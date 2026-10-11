import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { grimoireTool, runsGrimoire } from '../grimoire-calls';
import { jsonLines } from '../jsonl';
import type { Step, Transcript } from '../steps';

// Grimoire's own tolerant reader for Claude Code's JSONL transcripts (spec §14
// Readers), built against what Claude Code 2.1.296 writes (spike A, GOK-126;
// docs/research/spikes/claude-hooks-transcripts.md). No vendor SDK.
//
// - One API message spans several lines, one per content block, all sharing
//   `message.id`: blocks are grouped by it, so a block written twice is one step.
// - Metadata lines are skipped; lines and blocks of a type the reader doesn't
//   know are skipped and counted. A torn last line is ignored.
// - A missing `is_error` means the result succeeded.
// - A spilled result is read from its `<persisted-output>` preview; the spill
//   file is never opened.
// - A fork's copied history is found by uuid, never by `sessionId`, which the
//   fork rewrites (T5): it is everything before the fork's own `SessionStart:fork`
//   hook record, or else the leading run of lines whose uuids are in another
//   transcript of the same project folder.

export const CLAUDE_CODE_READER_VERSION = 1;

/** Top-level line types that carry nothing for a step log. */
const METADATA_LINES = new Set([
  'queue-operation',
  'mode',
  'atis-latch',
  'last-prompt',
  'cost-state',
  'ai-title',
]);

/** `attachment` line types that carry nothing for a step log (`hook_success` also holds the hint). */
const METADATA_ATTACHMENTS = new Set([
  'hook_success',
  'environment',
  'model',
  'deferred_tools_delta',
  'deferred_tools_record',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'total_tokens_reminder',
  'session_context',
  'date',
  'credential_org',
  'remote_session_change',
  'prompt_snapshot',
  'silent_turn_reminder',
  'command_permissions',
]);

/** `system` line subtypes the reader knows. A compact boundary is followed by the summary line. */
const KNOWN_SYSTEM = new Set(['compact_boundary', 'local_command']);

/** User lines a local command (`/clear`, `/compact`, …) writes: not prompts. */
const LOCAL_COMMAND = /^\s*<(?:command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/** Thinking is reasoning, and reasoning is dropped. */
const REASONING_BLOCKS = new Set(['thinking', 'redacted_thinking']);

/** Claude Code's shell tools, whose command may run the grimoire CLI. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** The tool that launches a subagent. */
const AGENT_TOOL = 'Agent';
/** The tool that runs a skill; a skill with `context: fork` runs in a subagent. */
const SKILL_TOOL = 'Skill';
/** Grimoire's chores skill, and the agent type it forks into (spike C). */
const CHORES = 'grimoire-chores';

export interface ReadClaudeCodeOptions {
  /** The subagent whose own transcript to read, instead of the session's main line. */
  readonly agentId?: string;
}

export type ReadResult = { readonly found: true; readonly transcript: Transcript } | { readonly found: false };

/**
 * Reads one context's transcript. `transcriptPath` is the session's main
 * transcript (`<projects>/<slug>/<session>.jsonl`); a subagent's own transcript
 * is found from it by agent id, under `<session>/subagents/`.
 */
export async function readClaudeCodeTranscript(
  transcriptPath: string,
  options: ReadClaudeCodeOptions = {},
): Promise<ReadResult> {
  const session = path.basename(transcriptPath).replace(/\.jsonl$/i, '');
  const sessionDir = path.join(path.dirname(transcriptPath), session);
  const file = options.agentId ? await findSubagentTranscript(sessionDir, options.agentId) : transcriptPath;
  if (!file || !(await isFile(file))) return { found: false };

  const parsed = await parseFile(file);
  await classifySubagents(parsed, sessionDir);
  const copiedSteps = options.agentId ? 0 : await countCopiedSteps(parsed, file);

  return {
    found: true,
    transcript: {
      client: { name: 'claude-code', version: parsed.version },
      reader: { version: CLAUDE_CODE_READER_VERSION },
      session,
      context: options.agentId ?? 'main',
      steps: parsed.steps,
      copiedSteps,
      flushedTo: parsed.flushedTo,
      lines: { read: parsed.read, unknown: parsed.unknown, malformed: parsed.malformed },
    },
  };
}

async function findSubagentTranscript(sessionDir: string, agentId: string): Promise<string | null> {
  const name = `agent-${agentId}.jsonl`;
  let entries: string[];
  try {
    entries = await readdir(path.join(sessionDir, 'subagents'), { recursive: true });
  } catch {
    return null;
  }
  const hit = entries.find((entry) => path.basename(entry) === name);
  return hit ? path.join(sessionDir, 'subagents', hit) : null;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

interface Parsed {
  /** Subagent launches are told apart once their results are read, so steps are replaced in place. */
  steps: Step[];
  version: string | null;
  flushedTo: string | null;
  read: number;
  unknown: number;
  malformed: number;
  /** Steps before the last `SessionStart:fork` hook record, if there is one. */
  forkBoundary: number | null;
  /** Every line that yielded steps, in order: its uuid, time, ordinal among the lines read, and first step. */
  stepLines: { uuid: string; at: string; line: number; firstStep: number }[];
  /** The time of every line read, by ordinal (`NaN` for a line without one). */
  lineTimes: number[];
  /**
   * Per tool-use id whose result line names an agent (`toolUseResult.agentId`):
   * the agent, and the subagent's own report (`toolUseResult.content`) when
   * there is one, free of the hand-back frame Claude Code puts around it.
   */
  subagentResults: Map<string, { agentId: string; report: string | null }>;
}

interface Line {
  type?: unknown;
  subtype?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  version?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  attachment?: { type?: unknown; hookName?: unknown };
  message?: { id?: unknown; content?: unknown };
  toolUseResult?: unknown;
}

interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  tool_name?: unknown;
}

async function parseFile(file: string): Promise<Parsed> {
  const parsed: Parsed = {
    steps: [],
    version: null,
    flushedTo: null,
    read: 0,
    unknown: 0,
    malformed: 0,
    forkBoundary: null,
    stepLines: [],
    lineTimes: [],
    subagentResults: new Map(),
  };
  const messages = new Map<string, { calls: Set<string>; texts: Set<string> }>();

  let pending: string | null = null;
  const take = (raw: string, isLast: boolean) => {
    if (raw.trim() === '') return;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      // A torn last line is still being written; any other bad line is counted.
      if (!isLast) parsed.malformed++;
      return;
    }
    if (line === null || typeof line !== 'object' || Array.isArray(line)) {
      parsed.malformed++;
      return;
    }
    parsed.read++;
    readLine(line, parsed, messages);
  };
  for await (const raw of jsonLines(createReadStream(file, { encoding: 'utf8' }))) {
    if (pending !== null) take(pending, false);
    pending = raw;
  }
  if (pending !== null) take(pending, true);
  return parsed;
}

function readLine(line: Line, parsed: Parsed, messages: Map<string, { calls: Set<string>; texts: Set<string> }>): void {
  const at = typeof line.timestamp === 'string' ? line.timestamp : '';
  const ref = typeof line.uuid === 'string' ? line.uuid : '';
  const ordinal = parsed.lineTimes.push(at ? Date.parse(at) : NaN) - 1;
  if (at && (parsed.flushedTo === null || Date.parse(at) > Date.parse(parsed.flushedTo))) parsed.flushedTo = at;
  if (typeof line.version === 'string') parsed.version = line.version;

  const before = parsed.steps.length;
  switch (line.type) {
    case 'user':
      readUser(line, at, ref, parsed);
      break;
    case 'assistant':
      readAssistant(line, at, ref, parsed, messages);
      break;
    case 'system':
      if (!KNOWN_SYSTEM.has(line.subtype as string)) parsed.unknown++;
      break;
    case 'attachment': {
      const kind = line.attachment?.type;
      if (kind === 'hook_success' && line.attachment?.hookName === 'SessionStart:fork') {
        parsed.forkBoundary = parsed.steps.length;
      } else if (!METADATA_ATTACHMENTS.has(kind as string)) {
        parsed.unknown++;
      }
      break;
    }
    default:
      if (!METADATA_LINES.has(line.type as string)) parsed.unknown++;
  }
  if (parsed.steps.length > before && ref) parsed.stepLines.push({ uuid: ref, at, line: ordinal, firstStep: before });
}

function readUser(line: Line, at: string, ref: string, parsed: Parsed): void {
  const content = line.message?.content;
  if (line.isCompactSummary === true) {
    parsed.steps.push({ kind: 'compaction', text: textOf(content, parsed), at, ref });
    return;
  }
  // Text Claude Code injects for the model (a local command's caveat, a skill's body).
  if (line.isMeta === true) return;
  if (typeof content === 'string') {
    if (!LOCAL_COMMAND.test(content)) parsed.steps.push({ kind: 'prompt', text: content, at, ref });
    return;
  }
  if (!Array.isArray(content)) {
    parsed.unknown++;
    return;
  }
  const prompt: string[] = [];
  for (const block of content as Block[]) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      parsed.steps.push({
        kind: 'tool_result',
        id: block.tool_use_id,
        error: block.is_error === true,
        text: textOf(block.content, parsed),
        at,
        ref,
      });
      const result = line.toolUseResult as { agentId?: unknown; content?: unknown } | undefined;
      if (typeof result?.agentId === 'string') {
        const report = Array.isArray(result.content) ? textOf(result.content, parsed) : null;
        parsed.subagentResults.set(block.tool_use_id, { agentId: result.agentId, report });
      }
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      prompt.push(block.text);
    } else if (block?.type === 'image') {
      prompt.push('[image]');
    } else {
      parsed.unknown++;
    }
  }
  const text = prompt.join('\n');
  if (prompt.length > 0 && !LOCAL_COMMAND.test(text)) parsed.steps.push({ kind: 'prompt', text, at, ref });
}

function readAssistant(
  line: Line,
  at: string,
  ref: string,
  parsed: Parsed,
  messages: Map<string, { calls: Set<string>; texts: Set<string> }>,
): void {
  const content = line.message?.content;
  if (!Array.isArray(content)) {
    parsed.unknown++;
    return;
  }
  const messageId = typeof line.message?.id === 'string' ? line.message.id : `line:${ref}`;
  let message = messages.get(messageId);
  if (!message) {
    message = { calls: new Set(), texts: new Set() };
    messages.set(messageId, message);
  }
  for (const block of content as Block[]) {
    if (REASONING_BLOCKS.has(block?.type as string)) continue;
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim() === '' || message.texts.has(block.text)) continue;
      message.texts.add(block.text);
      parsed.steps.push({ kind: 'assistant', text: block.text, at, ref });
    } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      if (message.calls.has(block.id)) continue;
      message.calls.add(block.id);
      parsed.steps.push({
        kind: 'tool_call',
        id: block.id,
        name: block.name,
        grimoire: grimoireOp(block.name, block.input),
        input: block.input ?? null,
        at,
        ref,
      });
    } else {
      parsed.unknown++;
    }
  }
}

/** The grimoire operation a call makes: an MCP tool's name, `cli` for a shell command running grimoire. */
function grimoireOp(name: string, input: unknown): string | null {
  const mcp = grimoireTool(name);
  if (mcp !== null) return mcp;
  const command = (input as { command?: unknown } | null)?.command;
  if (SHELL_TOOLS.has(name) && typeof command === 'string' && runsGrimoire(command)) return 'cli';
  return null;
}

/** A tool result's or a message's text: strings as they are, images as `[image]`. */
function textOf(content: unknown, parsed: Parsed): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Block[]) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image]');
    else if (block?.type === 'tool_reference' && typeof block.tool_name === 'string') {
      parts.push(`[tool_reference ${block.tool_name}]`);
    } else parsed.unknown++;
  }
  return parts.join('\n');
}

/**
 * Turns the calls that launched a subagent into subagent launches, and their
 * results into subagent results: the `Agent` tool, and any call whose result
 * names an agent (a skill run in a forked subagent).
 */
async function classifySubagents(parsed: Parsed, sessionDir: string): Promise<void> {
  const launches = new Set<string>();
  for (const step of parsed.steps) {
    if (step.kind === 'tool_call' && (step.name === AGENT_TOOL || parsed.subagentResults.has(step.id))) {
      launches.add(step.id);
    }
  }
  if (launches.size === 0) return;
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i]!;
    const subagent = parsed.subagentResults.get(step.kind === 'tool_call' || step.kind === 'tool_result' ? step.id : '');
    if (step.kind === 'tool_call' && launches.has(step.id)) {
      const agentId = subagent?.agentId;
      const input = step.input as { subagent_type?: unknown; skill?: unknown } | null;
      const agentType =
        (typeof input?.subagent_type === 'string' ? input.subagent_type : null) ??
        (agentId ? await agentTypeOf(sessionDir, agentId) : null) ??
        // Grimoire's own chores skill always forks into its own agent type.
        (step.name === SKILL_TOOL && input?.skill === CHORES ? CHORES : null);
      parsed.steps[i] = {
        kind: 'subagent_launch',
        id: step.id,
        name: step.name,
        agentType,
        input: step.input,
        at: step.at,
        ref: step.ref,
      };
    } else if (step.kind === 'tool_result' && launches.has(step.id)) {
      parsed.steps[i] = {
        kind: 'subagent_result',
        id: step.id,
        agentId: subagent?.agentId ?? null,
        error: step.error,
        text: subagent?.report ?? step.text,
        at: step.at,
        ref: step.ref,
      };
    }
  }
}

/** A subagent's type from the `agent-<id>.meta.json` beside its transcript (spike C): read without opening the transcript. */
async function agentTypeOf(sessionDir: string, agentId: string): Promise<string | null> {
  try {
    const meta = JSON.parse(
      await readFile(path.join(sessionDir, 'subagents', `agent-${agentId}.meta.json`), 'utf8'),
    ) as { agentType?: unknown };
    return typeof meta.agentType === 'string' ? meta.agentType : null;
  } catch {
    return null;
  }
}

/**
 * How many leading steps are a fork's copied history. Copied lines keep their
 * uuids and timestamps but carry the fork's `sessionId`, so they are found by
 * the fork's own `SessionStart:fork` hook record, or else by their uuids also
 * being in another transcript of the same project folder.
 *
 * Shared uuids alone can't say which file is the copy: a fork of a session
 * that was never compacted copies it from its first line. The copy is the file
 * whose lines were written out of order: the fork stamps its opening lines at
 * fork time, before history that is older than they are. An origin's opening
 * lines are older than the history after them.
 */
async function countCopiedSteps(parsed: Parsed, file: string): Promise<number> {
  if (parsed.forkBoundary !== null) return parsed.forkBoundary;
  const first = parsed.stepLines[0];
  if (!first) return 0;
  // The latest time on a line before the first step, and whether every given line is older.
  let opened = -Infinity;
  for (let i = 0; i < first.line; i++) if (parsed.lineTimes[i]! > opened) opened = parsed.lineTimes[i]!;
  const writtenLater = (lines: readonly { line: number }[]) =>
    lines.every((line) => !(parsed.lineTimes[line.line]! >= opened));
  // Checked before any other transcript is opened: most sessions aren't forks.
  if (!writtenLater([first])) return 0;

  const origin = await findTranscriptHolding(file, first.uuid, first.at);
  if (origin === null) return 0;
  let end = parsed.stepLines.findIndex((line) => !origin.includes(`"uuid":"${line.uuid}"`));
  if (end < 0) end = parsed.stepLines.length;
  if (!writtenLater(parsed.stepLines.slice(0, end))) return 0;
  return end < parsed.stepLines.length ? parsed.stepLines[end]!.firstStep : parsed.steps.length;
}

/** Another transcript in `file`'s folder holding a line with `uuid`. Only files written since `at` can. */
async function findTranscriptHolding(file: string, uuid: string, at: string): Promise<string | null> {
  const dir = path.dirname(file);
  const since = Date.parse(at);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const needle = `"uuid":"${uuid}"`;
  for (const name of names) {
    const other = path.join(dir, name);
    if (!name.toLowerCase().endsWith('.jsonl') || path.resolve(other) === path.resolve(file)) continue;
    try {
      const info = await stat(other);
      if (!info.isFile() || (Number.isFinite(since) && info.mtimeMs < since)) continue;
      const text = await readFile(other, 'utf8');
      if (text.includes(needle)) return text;
    } catch {
      // A transcript that vanished or can't be read holds nothing.
    }
  }
  return null;
}
