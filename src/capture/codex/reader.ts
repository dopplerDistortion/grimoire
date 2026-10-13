import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import * as zlib from 'node:zlib';
import { grimoireTool, runsGrimoire } from '../grimoire-calls';
import { jsonLines } from '../jsonl';
import { stampOf, type Step, type Transcript } from '../steps';
import { zstdFrameGuard } from './zstd-frames';

// Grimoire's own tolerant reader for Codex transcripts (spec §14 Readers), built
// against what Codex CLI 0.162.1 writes (spike E, GOK-130;
// docs/research/spikes/codex-mcp-hooks-transcripts.md). No vendor SDK.
//
// - Both history modes: `session_meta.history_mode` is `paginated` (every line
//   has an `ordinal`) or `legacy` (none, so the line index is the ordinal). A
//   step's ref is that ordinal: a cut's reach is the last step's time and ordinal.
// - Steps come from `response_item` lines, which both modes write the same way,
//   except prompts: those are the user's own input events (`user_message`, or a
//   `UserMessage` item), never the context Codex injects as user messages.
// - A tool output is a string or an array of content items. Its response header
//   (`Wall time: …`, unified exec's `Chunk ID: …`, apply_patch's `Exit code: …`,
//   each ending in `Output:`) is stripped.
// - A result failed when the structured record says so (paginated
//   `item_completed` `exit_code`/`status`, legacy `mcp_tool_call_end` and
//   `patch_apply_end`), else when the header reads "Process exited with code N"
//   or "Exit code: N" with N other than 0. A long-running command's exit belongs
//   to the `write_stdin` poll that saw it.
// - The summarizer's reply before a `compacted` line is folded into the
//   compaction step: it is not visible assistant text. Codex marks it with
//   `compaction_output` in the line's `metadata`; an unmarked one is known by
//   holding the `compacted` line's summary.
// - Unparsable lines are skipped and counted anywhere (Codex can leave a torn
//   fragment mid-file); a torn last line is ignored.
// - `.jsonl.zst` is read through Node's zstd (22.15+); without it, or on a bad
//   or cut-short frame, the transcript is unreadable, never partly read.

export const CODEX_READER_VERSION = 1;

/** Why a transcript that exists can't be read. */
export type CodexUnreadable = 'zstd_unavailable' | 'zstd_corrupt' | 'read_error';

export type CodexReadResult =
  | { readonly found: true; readonly file: string; readonly transcript: Transcript }
  | { readonly found: false; readonly file?: string; readonly unreadable?: CodexUnreadable };

/** Line types that carry nothing for a step log. */
const METADATA_LINES = new Set(['turn_context', 'world_state', 'token_usage_record']);

/** `event_msg` types that carry nothing the reader needs. */
const METADATA_EVENTS = new Set([
  'task_started',
  'task_complete',
  'token_count',
  'thread_settings_applied',
  'turn_aborted',
  'agent_message',
  'agent_reasoning',
  'context_compacted',
]);

/** Paginated `item_completed` items that carry nothing the reader needs (the response items hold them). */
const METADATA_ITEMS = new Set(['AgentMessage', 'ContextCompaction', 'Reasoning']);

/** Paginated `item_completed` items whose `status` (and `exit_code`) say whether a call failed. */
const STRUCTURED_ITEMS = new Set(['McpToolCall', 'CommandExecution', 'FileChange', 'CollabAgentToolCall']);
const FAILED_STATUSES = new Set(['failed', 'declined']);

/** Codex's shell tools, whose command may run the grimoire CLI. 0.162.1 has only `exec_command`. */
const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command']);
/** The unified exec tool that polls (and writes to) a running command's session. */
const POLL_TOOL = 'write_stdin';
/** The tool that launches a subagent thread (multi-agent v1). */
const SPAWN_TOOL = 'spawn_agent';

/** The prefix Codex puts before a summary in a `compacted` line's message. */
const SUMMARY_PREFIX = /^Another language model started to solve this problem[\s\S]*?to assist with your own analysis:\n/;

/** A response header line. Every header ends with an `Output:` line. */
const HEADER_LINE = new RegExp(
  '^(?:Chunk ID: .*|Wall time: .*|Original token count: .*|Total output lines: .*' +
    '|Process exited with code (-?\\d+)|Process running with session ID (\\d+)|Exit code: (-?\\d+))$',
);
const MAX_HEADER_LINES = 8;

/** Reads one context's (thread's) transcript, Codex's `rollout-….jsonl` or `rollout-….jsonl.zst` file. */
export async function readCodexTranscript(file: string): Promise<CodexReadResult> {
  const compressed = /\.zst$/i.test(file);
  if (compressed && typeof zlib.createZstdDecompress !== 'function') {
    return { found: false, file, unreadable: 'zstd_unavailable' };
  }
  // Stamped before the read: a line written meanwhile moves the stamp, so the next sweep reads it.
  const stamp = await stampOf(file);
  let parsed: Parsed;
  try {
    parsed = await parseLines(jsonLines(compressed ? decompressed(file) : createReadStream(file, { encoding: 'utf8' })));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    return { found: false, file, unreadable: compressed ? 'zstd_corrupt' : 'read_error' };
  }
  const fromName = threadOfFileName(file);
  const context = parsed.context ?? fromName;
  return {
    found: true,
    file,
    transcript: {
      client: { name: 'codex', version: parsed.version },
      reader: { version: CODEX_READER_VERSION },
      session: parsed.session ?? context,
      context,
      agentType: parsed.agentRole,
      steps: parsed.steps,
      copiedSteps: parsed.copiedSteps,
      flushedTo: parsed.flushedTo,
      lines: { read: parsed.read, unknown: parsed.unknown, malformed: parsed.malformed },
      ...(stamp !== null ? { stamp } : {}),
    },
  };
}

/** A `.jsonl.zst` file's text, decoded as it streams. A bad or cut-short frame fails the iteration. */
function decompressed(file: string): AsyncIterable<string> {
  const decoder = zlib.createZstdDecompress();
  decoder.setEncoding('utf8');
  return pipeline(createReadStream(file), zstdFrameGuard(), decoder, () => {}) as AsyncIterable<string>;
}

/** The thread id at the end of a transcript's file name: `rollout-<time>-<thread>[_<rollout>].jsonl[.zst]`. */
function threadOfFileName(file: string): string {
  const name = path.basename(file).replace(/\.zst$/i, '').replace(/\.jsonl$/i, '');
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^_]*)?$/i.exec(name);
  return uuid ? uuid[1]! : name;
}

interface Header {
  /** "Process exited with code N". */
  exited?: number;
  /** "Process running with session ID N". */
  running?: string;
  /** "Exit code: N". */
  exitCode?: number;
}

interface CallInfo {
  readonly name: string;
  readonly input: unknown;
}

interface Parsed {
  /** Results get their error flags once every structured record is read, so steps are replaced in place. */
  steps: Step[];
  /** Steps folded away after they were read (a compaction summarizer's reply). */
  dropped: Set<number>;
  copiedSteps: number;
  version: string | null;
  session: string | null;
  context: string | null;
  /** The thread's role (`session_meta.agent_role`): a `grimoire-chores` thread is a chore thread. */
  agentRole: string | null;
  /** Where a subagent's own records begin, when it was spawned with its parent's history. */
  ownHistoryFrom: number | null;
  flushedTo: string | null;
  read: number;
  unknown: number;
  malformed: number;
  calls: Map<string, CallInfo>;
  results: { index: number; callId: string; header: Header }[];
  /** Per call id, whether its structured record says it failed. */
  structured: Map<string, boolean>;
  /** Per running unified exec session id, the call that started it: the last result reading "Process running with session ID N". */
  running: Map<string, string>;
  /** Per `write_stdin` call id, the call that started the session it polls. */
  polled: Map<string, string>;
  /** Per `spawn_agent` call id, the thread it spawned. */
  spawned: Map<string, string>;
  /** The last response item, while it is an assistant message: a `compacted` line right after it folds it. */
  lastAssistant: number | null;
  /** A reply the record marks as the compaction's output. */
  summary: string | null;
}

interface Line {
  type?: unknown;
  timestamp?: unknown;
  ordinal?: unknown;
  payload?: Record<string, unknown> & { type?: unknown };
  /** Codex's own notes on the record, beside the payload: `compaction_output`, `user_input_order`, … */
  metadata?: { compaction_output?: unknown } | null;
}

type Payload = Record<string, unknown>;

async function parseLines(lines: AsyncIterable<string>): Promise<Parsed> {
  const parsed: Parsed = {
    steps: [],
    dropped: new Set(),
    copiedSteps: 0,
    version: null,
    session: null,
    context: null,
    agentRole: null,
    ownHistoryFrom: null,
    flushedTo: null,
    read: 0,
    unknown: 0,
    malformed: 0,
    calls: new Map(),
    results: [],
    structured: new Map(),
    running: new Map(),
    polled: new Map(),
    spawned: new Map(),
    lastAssistant: null,
    summary: null,
  };
  let index = 0;
  let pending: { raw: string; index: number } | null = null;
  const take = ({ raw, index: lineIndex }: { raw: string; index: number }, isLast: boolean) => {
    if (raw.trim() === '') return;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      // A torn last line is still being written; a torn fragment Codex left mid-file is counted.
      if (!isLast) parsed.malformed++;
      return;
    }
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      parsed.malformed++;
      return;
    }
    parsed.read++;
    readLine(line, lineIndex, parsed);
  };
  for await (const raw of lines) {
    if (pending !== null) take(pending, false);
    pending = { raw, index: index++ };
  }
  if (pending !== null) take(pending, true);
  return finish(parsed);
}

function readLine(line: Line, lineIndex: number, parsed: Parsed): void {
  const at = typeof line.timestamp === 'string' ? line.timestamp : '';
  // Paginated lines carry their ordinal; legacy lines have none, so their index stands in.
  const ordinal = typeof line.ordinal === 'number' ? line.ordinal : lineIndex;
  const ref = String(ordinal);
  if (at && (parsed.flushedTo === null || Date.parse(at) > Date.parse(parsed.flushedTo))) parsed.flushedTo = at;
  const payload = line.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    if (!METADATA_LINES.has(line.type as string)) parsed.unknown++;
    return;
  }

  const before = parsed.steps.length;
  switch (line.type) {
    case 'session_meta':
      readSessionMeta(payload, parsed);
      break;
    case 'response_item':
      readResponseItem(payload, at, ref, parsed, line.metadata?.compaction_output === true);
      break;
    case 'event_msg':
      readEvent(payload, at, ref, parsed);
      break;
    case 'compacted':
      readCompacted(payload, at, ref, parsed);
      break;
    default:
      if (!METADATA_LINES.has(line.type as string)) parsed.unknown++;
  }
  // A subagent spawned with its parent's history: the copied records come first.
  if (parsed.ownHistoryFrom !== null && ordinal < parsed.ownHistoryFrom) {
    parsed.copiedSteps += parsed.steps.length - before;
  }
}

function readSessionMeta(payload: Payload, parsed: Parsed): void {
  // Only the file's own first line: a legacy fork copies its parent's after it.
  if (parsed.context !== null) return;
  if (typeof payload.id === 'string') parsed.context = payload.id;
  const spawn = (payload.source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown; agent_role?: unknown } } } | undefined)
    ?.subagent?.thread_spawn;
  const parent = spawn?.parent_thread_id;
  // A role's thread names its role twice (spike F); either will do.
  const role = typeof payload.agent_role === 'string' ? payload.agent_role : spawn?.agent_role;
  if (typeof role === 'string') parsed.agentRole = role;
  parsed.session =
    typeof payload.session_id === 'string' ? payload.session_id : typeof parent === 'string' ? parent : parsed.context;
  if (typeof payload.cli_version === 'string') parsed.version = payload.cli_version;
  if (typeof payload.subagent_history_start_ordinal === 'number') {
    parsed.ownHistoryFrom = payload.subagent_history_start_ordinal;
  }
}

/** `compactionOutput`: the line is marked as an item the compaction's summarizer returned. */
function readResponseItem(payload: Payload, at: string, ref: string, parsed: Parsed, compactionOutput: boolean): void {
  const lastAssistant = parsed.lastAssistant;
  parsed.lastAssistant = null;
  switch (payload.type) {
    case 'message':
      readMessage(payload, at, ref, parsed, compactionOutput);
      return;
    case 'reasoning':
      // Reasoning is dropped.
      return;
    case 'function_call': {
      const callId = payload.call_id;
      if (typeof callId !== 'string' || typeof payload.name !== 'string') break;
      const name = flatName(payload.namespace, payload.name);
      const input = parseArguments(payload.arguments);
      parsed.calls.set(callId, { name, input });
      if (name === POLL_TOOL) {
        const started = parsed.running.get(String((input as { session_id?: unknown } | null)?.session_id));
        if (started !== undefined) parsed.polled.set(callId, started);
      }
      if (name === SPAWN_TOOL) {
        const agentType = (input as { agent_type?: unknown } | null)?.agent_type;
        parsed.steps.push({
          kind: 'subagent_launch',
          id: callId,
          name,
          agentType: typeof agentType === 'string' ? agentType : null,
          input,
          at,
          ref,
        });
      } else {
        parsed.steps.push({ kind: 'tool_call', id: callId, name, grimoire: grimoireOp(name, input), input, at, ref });
      }
      return;
    }
    case 'custom_tool_call': {
      const callId = payload.call_id;
      if (typeof callId !== 'string' || typeof payload.name !== 'string') break;
      const input = payload.input ?? null;
      parsed.calls.set(callId, { name: payload.name, input });
      parsed.steps.push({ kind: 'tool_call', id: callId, name: payload.name, grimoire: null, input, at, ref });
      return;
    }
    case 'tool_search_call': {
      const callId = payload.call_id;
      if (typeof callId !== 'string') break;
      const input = payload.arguments ?? null;
      parsed.calls.set(callId, { name: 'tool_search', input });
      parsed.steps.push({ kind: 'tool_call', id: callId, name: 'tool_search', grimoire: null, input, at, ref });
      return;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = payload.call_id;
      if (typeof callId !== 'string') break;
      const { header, body } = splitHeader(outputText(payload.output, parsed));
      parsed.results.push({ index: parsed.steps.length, callId, header });
      if (header.running !== undefined) parsed.running.set(header.running, callId);
      if (parsed.calls.get(callId)?.name === SPAWN_TOOL) {
        const agentId = spawnedAgent(body);
        parsed.steps.push({ kind: 'subagent_result', id: callId, agentId, error: false, text: body, at, ref });
      } else {
        parsed.steps.push({ kind: 'tool_result', id: callId, error: false, text: body, at, ref });
      }
      return;
    }
    case 'tool_search_output': {
      const callId = payload.call_id;
      if (typeof callId !== 'string') break;
      parsed.steps.push({
        kind: 'tool_result',
        id: callId,
        error: payload.status === 'failed',
        text: toolList(payload.tools),
        at,
        ref,
      });
      return;
    }
  }
  parsed.lastAssistant = lastAssistant;
  parsed.unknown++;
}

function readMessage(payload: Payload, at: string, ref: string, parsed: Parsed, compactionOutput: boolean): void {
  switch (payload.role) {
    case 'developer':
    case 'system':
      // Instructions Codex sends the model.
      return;
    case 'user':
      // The user's input is read from its event, which Codex writes only for
      // real input; user-role messages also carry injected context
      // (`<environment_context>`, `<subagent_notification>`, AGENTS.md, …).
      return;
    case 'assistant': {
      const text = contentText(payload.content, parsed);
      if (compactionOutput) {
        parsed.summary = text;
        return;
      }
      if (text.trim() === '') return;
      parsed.lastAssistant = parsed.steps.length;
      parsed.steps.push({ kind: 'assistant', text, at, ref });
      return;
    }
    default:
      parsed.unknown++;
  }
}

function readEvent(payload: Payload, at: string, ref: string, parsed: Parsed): void {
  if (payload.type === 'item_completed') {
    const item = payload.item as Payload | undefined;
    const kind = item?.type as string | undefined;
    if (!item || kind === undefined) parsed.unknown++;
    else if (kind === 'UserMessage') pushPrompt(userInputText(item.content, parsed), at, ref, parsed);
    else if (STRUCTURED_ITEMS.has(kind)) readStructured(item, parsed);
    else if (!METADATA_ITEMS.has(kind)) parsed.unknown++;
    return;
  }
  switch (payload.type) {
    case 'user_message': {
      // Older Codex also wrote its injected context as user_message events, with a `kind`.
      if (payload.kind !== undefined && payload.kind !== 'plain') return;
      const parts = typeof payload.message === 'string' ? [payload.message] : [];
      for (const list of [payload.images, payload.local_images]) {
        if (Array.isArray(list)) parts.push(...list.map(() => '[image]'));
      }
      pushPrompt(parts.join('\n'), at, ref, parsed);
      return;
    }
    case 'mcp_tool_call_end': {
      const result = payload.result as { Ok?: { isError?: unknown }; Err?: unknown } | undefined;
      if (typeof payload.call_id === 'string' && result && typeof result === 'object') {
        parsed.structured.set(payload.call_id, 'Err' in result || result.Ok?.isError === true);
      }
      return;
    }
    case 'patch_apply_end':
      if (typeof payload.call_id === 'string' && typeof payload.success === 'boolean') {
        parsed.structured.set(payload.call_id, !payload.success);
      }
      return;
    default:
      if (!METADATA_EVENTS.has(payload.type as string)) parsed.unknown++;
  }
}

function readStructured(item: Payload, parsed: Parsed): void {
  if (typeof item.id !== 'string' || item.status === 'in_progress') return;
  const failed =
    FAILED_STATUSES.has(item.status as string) || (typeof item.exit_code === 'number' && item.exit_code !== 0);
  parsed.structured.set(item.id, failed);
  if (item.type === 'CollabAgentToolCall' && item.tool === SPAWN_TOOL && Array.isArray(item.receiver_thread_ids)) {
    const [thread] = item.receiver_thread_ids as unknown[];
    if (typeof thread === 'string') parsed.spawned.set(item.id, thread);
  }
}

function readCompacted(payload: Payload, at: string, ref: string, parsed: Parsed): void {
  const message = typeof payload.message === 'string' ? payload.message.replace(SUMMARY_PREFIX, '') : null;
  let text = parsed.summary;
  // An unmarked reply is the last response item before the `compacted` line,
  // holding the line's own summary. Any other assistant message there is real:
  // post-turn and remote compaction record no reply.
  if (text === null && parsed.lastAssistant !== null && message !== null && message.trim() !== '') {
    const reply = parsed.steps[parsed.lastAssistant];
    if (reply?.kind === 'assistant' && reply.text.trim() === message.trim()) {
      text = reply.text;
      parsed.dropped.add(parsed.lastAssistant);
    }
  }
  if (text === null) text = message;
  parsed.summary = null;
  parsed.lastAssistant = null;
  parsed.steps.push({ kind: 'compaction', text: text ?? '', at, ref });
}

function pushPrompt(text: string, at: string, ref: string, parsed: Parsed): void {
  if (text.trim() !== '') parsed.steps.push({ kind: 'prompt', text, at, ref });
}

/** Sets every result's error flag, and drops folded steps. */
function finish(parsed: Parsed): Parsed {
  for (const { index, callId, header } of parsed.results) {
    const step = parsed.steps[index];
    if (step?.kind !== 'tool_result' && step?.kind !== 'subagent_result') continue;
    const error = failed(callId, header, parsed);
    const agentId = step.kind === 'subagent_result' ? (step.agentId ?? parsed.spawned.get(callId) ?? null) : null;
    parsed.steps[index] = step.kind === 'subagent_result' ? { ...step, error, agentId } : { ...step, error };
  }
  if (parsed.dropped.size > 0) {
    // The copied history is the first steps: a step folded away there leaves one fewer.
    const copied = parsed.copiedSteps;
    for (const index of parsed.dropped) if (index < copied) parsed.copiedSteps--;
    parsed.steps = parsed.steps.filter((_, i) => !parsed.dropped.has(i));
  }
  return parsed;
}

/**
 * Whether a result failed: the structured record first, then "Process exited
 * with code N", then "Exit code: N". A command still running hasn't failed; a
 * long-running command's exit code belongs to the poll that saw it exit.
 */
function failed(callId: string, header: Header, parsed: Parsed): boolean {
  if (header.running !== undefined) return false;
  // A command's structured record is under the id of the call that started it.
  const polled = parsed.calls.get(callId)?.name === POLL_TOOL;
  const recordOf = polled ? (header.exited !== undefined ? parsed.polled.get(callId) : undefined) : callId;
  const structured = recordOf === undefined ? undefined : parsed.structured.get(recordOf);
  if (structured !== undefined) return structured;
  if (header.exited !== undefined) return header.exited !== 0;
  if (header.exitCode !== undefined) return header.exitCode !== 0;
  return false;
}

/** Splits a tool output into its response header and the output itself. Text without a whole header is all output. */
function splitHeader(text: string): { header: Header; body: string } {
  const header: Header = {};
  let at = 0;
  for (let lines = 0; lines <= MAX_HEADER_LINES; lines++) {
    const end = text.indexOf('\n', at);
    const line = text.slice(at, end < 0 ? text.length : end);
    if (line === 'Output:') {
      return lines === 0 ? { header: {}, body: text } : { header, body: end < 0 ? '' : text.slice(end + 1) };
    }
    const match = HEADER_LINE.exec(line);
    if (!match || end < 0) break;
    if (match[1] !== undefined) header.exited = Number(match[1]);
    if (match[2] !== undefined) header.running = match[2];
    if (match[3] !== undefined) header.exitCode = Number(match[3]);
    at = end + 1;
  }
  return { header: {}, body: text };
}

/** A tool output: a string, or an array of content items. */
function outputText(output: unknown, parsed: Parsed): string {
  if (typeof output === 'string') return output;
  return contentText(output, parsed);
}

/** Message or output content items: text as it is, images as `[image]`. */
function contentText(content: unknown, parsed: Parsed): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    parsed.unknown++;
    return '';
  }
  const parts: string[] = [];
  for (const item of content as { type?: unknown; text?: unknown }[]) {
    const type = item?.type;
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (type === 'input_image' || type === 'image') {
      parts.push('[image]');
    } else {
      parsed.unknown++;
    }
  }
  return parts.join('\n');
}

/** A `UserMessage` item's input: text as it is, images as `[image]`, skills and mentions by name. */
function userInputText(content: unknown, parsed: Parsed): string {
  if (!Array.isArray(content)) {
    parsed.unknown++;
    return '';
  }
  const parts: string[] = [];
  for (const item of content as { type?: unknown; text?: unknown; name?: unknown }[]) {
    const type = item?.type;
    if (type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (type === 'image' || type === 'local_image') parts.push('[image]');
    else if ((type === 'skill' || type === 'mention') && typeof item.name === 'string') {
      parts.push(`[${type} ${item.name}]`);
    }
    else parsed.unknown++;
  }
  return parts.join('\n');
}

/** The tools a `tool_search` call loaded, one `[tool_reference <name>]` line each. */
function toolList(tools: unknown): string {
  if (!Array.isArray(tools)) return '';
  const names: string[] = [];
  for (const tool of tools as { type?: unknown; name?: unknown; tools?: unknown }[]) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools as { name?: unknown }[]) {
        if (typeof inner?.name === 'string') names.push(flatName(tool.name, inner.name));
      }
    } else if (typeof tool?.name === 'string') {
      names.push(tool.name);
    }
  }
  return names.map((name) => `[tool_reference ${name}]`).join('\n');
}

/** A tool's name as hooks and logs see it: an MCP tool is `mcp__<server>__<tool>`, any other tool its own name. */
function flatName(namespace: unknown, name: string): string {
  return typeof namespace === 'string' && namespace.startsWith('mcp__') ? `${namespace}__${name}` : name;
}

/** A function call's arguments: Codex records them as JSON text. */
function parseArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? null;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

/** The thread a `spawn_agent` output names: `{"agent_id": "<thread>", "nickname": …}`. */
function spawnedAgent(body: string): string | null {
  try {
    const agentId = (JSON.parse(body) as { agent_id?: unknown } | null)?.agent_id;
    return typeof agentId === 'string' ? agentId : null;
  } catch {
    return null;
  }
}

/** The grimoire operation a call makes: an MCP tool's name, `cli` for a shell command running grimoire. */
function grimoireOp(name: string, input: unknown): string | null {
  const tool = grimoireTool(name);
  if (tool !== null) return tool;
  if (!SHELL_TOOLS.has(name)) return null;
  // `exec_command` takes `cmd`; older shell tools took `command`, a string or an argv.
  const { cmd, command } = (input ?? {}) as { cmd?: unknown; command?: unknown };
  const text = [cmd, command]
    .map((value) => (Array.isArray(value) ? value.join(' ') : value))
    .find((value) => typeof value === 'string');
  return typeof text === 'string' && runsGrimoire(text) ? 'cli' : null;
}
