// Spike E (GOK-130): the Codex CLI 0.162.1 behaviours that the MCP server, the
// hook entry, the Codex transcript reader and the re-approval notices rest on,
// encoded against the real, sanitized artifacts the spike captured (seam 2).
// Findings and verdicts: docs/research/spikes/codex-mcp-hooks-transcripts.md.
//
// Model turns were scripted by a local stand-in for the Responses API (Codex
// was not logged in); everything else in these artifacts is the real Codex.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePath, makeTempDir, readFixture, readFixtureBytes, readFixtureJson, removeDir } from '#harness';
import { codexHookGroupHash } from '../../src/installer/pointers';
import { foreignUserPaths, userNameLeftovers } from './codex-mcp-hooks-transcripts/sanitize.mjs';

interface CodexToolsCallMeta {
  callId: string;
  sessionId: string;
  threadId: string;
  windowId: string;
  itemId?: string;
  progressToken: number;
  'x-codex-turn-metadata': Record<string, unknown>;
}

interface JsonRpcLine {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface ToolsCallRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: { name: string; arguments: Record<string, unknown>; _meta: CodexToolsCallMeta };
}

interface RolloutLine {
  timestamp: string;
  ordinal?: number;
  type: string;
  payload: Record<string, unknown> & { type?: string };
}

interface SessionStartPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  model: string;
  permission_mode: string;
  source: string;
}

interface HookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  command: string;
  async: boolean;
  matcher: string | null;
  timeoutSec: number;
  statusMessage: string | null;
  sourcePath: string;
  displayOrder: number;
  currentHash: string;
  trustStatus: 'trusted' | 'untrusted' | 'modified' | 'managed';
}

interface HooksListResponse {
  id: number;
  result: { data: { cwd: string; hooks: HookMetadata[]; warnings: unknown[]; errors: unknown[] }[] };
}

const TRANSCRIPTS = 'codex/transcripts';

const metaOf = (fixture: string) => readFixtureJson<ToolsCallRequest>(fixture).params._meta;

const jsonl = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

/** Every rollout file in a fixture folder, keyed by its thread id (session_meta.id). */
function rollouts(folder: string): Map<string, RolloutLine[]> {
  const out = new Map<string, RolloutLine[]>();
  for (const name of readdirSync(fixturePath(`${TRANSCRIPTS}/${folder}`))) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = jsonl<RolloutLine>(readFixture(`${TRANSCRIPTS}/${folder}/${name}`));
    out.set(String(sessionMeta(lines).id), lines);
  }
  return out;
}

function onlyRollout(folder: string): RolloutLine[] {
  const all = [...rollouts(folder).values()];
  expect(all).toHaveLength(1);
  return all[0]!;
}

function sessionMeta(lines: RolloutLine[]): Record<string, unknown> {
  const first = lines[0]!;
  expect(first.type).toBe('session_meta');
  return first.payload;
}

const items = (lines: RolloutLine[], type: string) =>
  lines.filter((l) => l.type === 'response_item' && l.payload.type === type).map((l) => l.payload);

const events = (lines: RolloutLine[], type: string) =>
  lines.filter((l) => l.type === 'event_msg' && l.payload.type === type).map((l) => l.payload);

const completedItems = (lines: RolloutLine[], itemType: string) =>
  events(lines, 'item_completed')
    .map((p) => p.item as Record<string, unknown>)
    .filter((item) => item.type === itemType);

/** The output a function_call_output carried for the call with this id. */
function outputOf(lines: RolloutLine[], callId: string): unknown {
  const out = [...items(lines, 'function_call_output'), ...items(lines, 'custom_tool_call_output')].find(
    (p) => p.call_id === callId,
  );
  expect(out, `an output for ${callId}`).toBeDefined();
  return out!.output;
}

function callNamed(lines: RolloutLine[], name: string, nth = 0): Record<string, unknown> {
  const calls = items(lines, 'function_call').filter((p) => p.name === name);
  expect(calls.length, `function_call ${name}`).toBeGreaterThan(nth);
  return calls[nth]!;
}

describe('Codex per-call _meta (T6)', () => {
  it('a root-thread call carries callId, with sessionId and threadId both naming the root thread', () => {
    const meta = metaOf('codex/meta/tools-call.json');

    expect(meta.callId).toMatch(/^call_/);
    expect(meta.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.threadId).toBe(meta.sessionId);
    expect(meta.windowId).toBe(`${meta.threadId}:0`);
    const turn = meta['x-codex-turn-metadata'];
    expect(turn.session_id).toBe(meta.sessionId);
    expect(turn.thread_id).toBe(meta.threadId);
    expect(turn.codex_version).toBe('0.162.1');
  });

  it('a subagent-thread call names its own thread in threadId and the root thread in sessionId', () => {
    const meta = metaOf('codex/meta/tools-call-subagent.json');

    expect(meta.callId).toMatch(/^call_/);
    expect(meta.threadId).not.toBe(meta.sessionId);
    const turn = meta['x-codex-turn-metadata'];
    expect(turn.thread_source).toBe('subagent');
    expect(turn.parent_thread_id).toBe(meta.sessionId);
    expect(turn.thread_id).toBe(meta.threadId);
  });

  it('every captured Codex tools/call carries callId, sessionId and threadId', () => {
    const calls = ['codex/mcp/tools-call/c2s.jsonl', 'codex/mcp/subagent/c2s.jsonl'].flatMap((f) =>
      jsonl<JsonRpcLine>(readFixture(f)).filter((l) => l.method === 'tools/call'),
    );

    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      const meta = call.params!._meta as CodexToolsCallMeta;
      expect(meta.callId).toMatch(/^call_/);
      expect(meta.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(meta.threadId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('the turn metadata session_id, the fallback where top-level sessionId is missing, names the same root thread', () => {
    // Top-level sessionId is new after Codex 0.150.0; x-codex-turn-metadata.session_id is older.
    const calls = ['codex/mcp/tools-call/c2s.jsonl', 'codex/mcp/subagent/c2s.jsonl', 'codex/mcp/two-turns/c2s.jsonl'].flatMap((f) =>
      jsonl<JsonRpcLine>(readFixture(f)).filter((l) => l.method === 'tools/call'),
    );
    const metas = [...calls.map((c) => c.params!._meta as CodexToolsCallMeta), metaOf('codex/meta/tools-call-subagent.json')];

    expect(metas.some((m) => m.threadId !== m.sessionId)).toBe(true);
    for (const meta of metas) expect(meta['x-codex-turn-metadata'].session_id).toBe(meta.sessionId);
  });

  it("callId is the call_id of the namespaced function_call in the transcript of the thread threadId names", () => {
    const cases = [
      { meta: 'codex/meta/tools-call.json', folder: 'paginated' },
      { meta: 'codex/meta/tools-call-subagent.json', folder: 'subagent' },
    ];
    for (const { meta: fixture, folder } of cases) {
      const request = readFixtureJson<ToolsCallRequest>(fixture);
      const { callId, threadId } = request.params._meta;
      const lines = rollouts(folder).get(threadId);
      expect(lines, `a transcript for thread ${threadId}`).toBeDefined();

      const call = items(lines!, 'function_call').find((p) => p.call_id === callId);
      expect(call).toMatchObject({ namespace: 'mcp__probe', name: request.params.name });
    }
  });
});

describe('Codex subagent threads (T4)', () => {
  it('a spawned subagent thread writes its own rollout, linked to the root thread', () => {
    const threads = rollouts('subagent');
    expect(threads.size).toBe(2);
    const bySource = (source: string) => [...threads.entries()].find(([, lines]) => sessionMeta(lines).thread_source === source)!;
    const [rootId, rootLines] = bySource('user');
    const [childId, childLines] = bySource('subagent');

    expect(sessionMeta(rootLines)).toMatchObject({ thread_source: 'user', session_id: rootId });
    expect(sessionMeta(childLines)).toMatchObject({
      thread_source: 'subagent',
      session_id: rootId,
      parent_thread_id: rootId,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1 } } },
    });

    const spawn = callNamed(rootLines, 'spawn_agent');
    expect(spawn.namespace).toBe('multi_agent_v1');
    expect(JSON.parse(String(outputOf(rootLines, String(spawn.call_id))))).toMatchObject({ agent_id: childId });
  });

  it('Codex starts one MCP server process per thread, not per call or per turn', () => {
    const starts = (run: string) => jsonl(readFixture(`codex/mcp/${run}/starts.jsonl`)).length;
    const calls = (run: string) => jsonl<JsonRpcLine>(readFixture(`codex/mcp/${run}/c2s.jsonl`)).filter((l) => l.method === 'tools/call');
    const turns = (run: string) => new Set(calls(run).map((c) => (c.params!._meta as CodexToolsCallMeta)['x-codex-turn-metadata'].turn_id));
    const threads = (run: string) => new Set(calls(run).map((c) => (c.params!._meta as CodexToolsCallMeta).threadId));

    // A root and its subagent: two threads, two processes.
    expect([threads('subagent').size, starts('subagent')]).toEqual([2, 2]);
    // Six calls in one turn of one thread: one process.
    expect([calls('tools-call').length, starts('tools-call')]).toEqual([6, 1]);
    // Calls in two turns of one app-server thread: still one process.
    expect([threads('two-turns').size, turns('two-turns').size, starts('two-turns')]).toEqual([1, 2, 1]);
  });
});

describe('Codex MCP results (P1, Codex half)', () => {
  const lines = onlyRollout('mcp-results');
  const callId = (name: string) => String(callNamed(lines, name).call_id);
  const HEADER = /^Wall time: \d+\.\d{4} seconds\nOutput:\n/;

  it('initializes at 2025-06-18 and calls tools with the server answering at that version', () => {
    const c2s = jsonl<JsonRpcLine>(readFixture('codex/mcp/tools-call/c2s.jsonl'));
    const s2c = jsonl<JsonRpcLine>(readFixture('codex/mcp/tools-call/s2c.jsonl'));

    expect(c2s[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(s2c.find((l) => l.id === 0)?.result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(c2s.filter((l) => l.method === 'tools/call')).toHaveLength(6);
  });

  it('the model sees structuredContent, not the text block, behind a "Wall time" header', () => {
    const output = String(outputOf(lines, callId('which')));

    expect(output).toMatch(HEADER);
    expect(output.replace(HEADER, '')).toBe('{"seen_via":"structuredContent"}');
  });

  it("grimoire's 24 KB cut reaches the model whole, under Codex's own truncation", () => {
    const body = String(outputOf(lines, callId('big'))).replace(HEADER, '');

    expect(body).not.toMatch(/truncated…/);
    expect(Buffer.byteLength(body)).toBe(24_482);
    expect(JSON.parse(body)).toMatchObject({ truncated: true, cursor: '137' });
  });

  it('a JSON-RPC error from the server reaches the model as content items, header first', () => {
    const output = outputOf(lines, callId('boom')) as { type: string; text: string }[];

    expect(output[0]!.text).toMatch(/^Wall time: .* seconds\nOutput:$/);
    expect(output[1]!.text).toContain('Mcp error: -32603: probe exploded');
  });

  it('a text-only result reaches the model as content items, header first; an isError result as its structuredContent', () => {
    const run = onlyRollout('truncation');
    const textOnly = outputOf(run, String(callNamed(run, 'textonly').call_id)) as { type: string; text: string }[];
    const failed = String(outputOf(run, String(callNamed(run, 'fail').call_id)));

    expect(textOnly.map((i) => i.type)).toEqual(['input_text', 'input_text']);
    expect(textOnly[0]!.text).toMatch(/^Wall time: .* seconds\nOutput:$/);
    expect(textOnly[1]!.text).toBe('plain text only');
    expect(JSON.parse(failed.replace(HEADER, ''))).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe("Codex's own cut of a long tool result (P1, Codex half)", () => {
  /** The function_call / function_call_output items of the last request Codex sent to the model. */
  const modelInput = (name: string) => jsonl<Record<string, unknown>>(readFixture(`codex/model-input/${name}.jsonl`));
  const seenBy = (input: Record<string, unknown>[], callId: string) =>
    String(input.find((i) => i.type === 'function_call_output' && i.call_id === callId)!.output);
  const markers = (s: string) => [...s.matchAll(/…(\d+) (tokens|chars) truncated…/g)].map((m) => ({ n: Number(m[1]), unit: m[2] }));
  const hugeCalls = (lines: RolloutLine[]) =>
    items(lines, 'function_call')
      .filter((p) => p.name === 'huge')
      .map((p) => ({ bytes: (JSON.parse(String(p.arguments)) as { bytes: number }).bytes, callId: String(p.call_id) }));
  const TAIL = '"truncated":false}';

  it('gpt-5.5 keeps 48,000 chars of a longer result, head and tail; the rollout keeps the first cut, the model sees it cut again', () => {
    const lines = onlyRollout('truncation');
    const input = modelInput('truncation');
    const calls = hugeCalls(lines);
    expect(calls.map((c) => c.bytes)).toEqual([30_000, 45_000, 60_000, 120_000]);

    for (const { bytes, callId } of calls) {
      const stored = String(outputOf(lines, callId));
      const seen = seenBy(input, callId);
      expect(seen.endsWith(TAIL), `${bytes}: the tail survives`).toBe(true);
      if (bytes <= 45_000) {
        expect(markers(stored)).toEqual([]);
        expect(seen).toBe(stored);
        continue;
      }
      // The rollout: Codex's first cut, whose marker counts the tokens it really removed.
      const [first] = markers(stored);
      expect(first).toMatchObject({ unit: 'tokens' });
      expect(first!.n).toBeGreaterThan(1_000);
      expect(stored.length - `…${first!.n} tokens truncated…`.length).toBe(48_000);
      // The model: that text cut once more, which removes the first marker; the new one reads 7.
      expect(markers(seen)).toEqual([{ n: 7, unit: 'tokens' }]);
      expect(seen.length - '…7 tokens truncated…'.length).toBe(48_000);
      expect(seen.slice(0, 20_000)).toBe(stored.slice(0, 20_000));
      expect(seen.slice(-20_000)).toBe(stored.slice(-20_000));
    }
  });

  it('a slug missing from the catalog gets a 12,000-char cut; the rollout counts the exact chars removed', () => {
    const lines = onlyRollout('truncation-unknown-model');
    const [{ bytes, callId }] = hugeCalls(lines) as [{ bytes: number; callId: string }];
    const stored = String(outputOf(lines, callId));
    const seen = seenBy(modelInput('truncation-unknown-model'), callId);
    const gpt = onlyRollout('truncation');
    const whole = String(outputOf(gpt, hugeCalls(gpt).find((c) => c.bytes === bytes)!.callId));

    expect(lines.find((l) => l.type === 'turn_context')!.payload.model).toBe('unknown-model-x');
    const [first] = markers(stored);
    expect(first).toEqual({ n: whole.length - 12_000, unit: 'chars' });
    expect(stored.length - `…${first!.n} chars truncated…`.length).toBe(12_000);
    expect(markers(seen)).toEqual([{ n: 7, unit: 'tokens' }]);
    expect(seen.length - '…7 tokens truncated…'.length).toBe(12_000);
    expect(seen.endsWith(TAIL)).toBe(true);
  });
});

describe('Codex shell command env', () => {
  it('a shell command sees CODEX_SESSION_ID and CODEX_THREAD_ID (both the root thread here) and CODEX_VERSION', () => {
    const lines = onlyRollout('truncation-unknown-model');
    const call = callNamed(lines, 'exec_command');
    const printed = String(outputOf(lines, String(call.call_id))).split('Output:\n')[1]!.trim();

    expect(String(call.arguments)).toContain('process.env.CODEX_SESSION_ID, process.env.CODEX_THREAD_ID, process.env.CODEX_VERSION');
    const id = String(sessionMeta(lines).id);
    expect(printed).toBe(`${id} ${id} 0.162.1`);
  });
});

describe('Codex rollouts in both history modes', () => {
  const paginated = onlyRollout('paginated');
  const legacy = onlyRollout('legacy');

  it('every line of every transcript fixture is a JSON object with timestamp, type and payload', () => {
    for (const folder of ['paginated', 'legacy', 'subagent', 'compaction', 'mcp-results', 'compaction-legacy', 'subagent-legacy-root', 'truncation', 'truncation-unknown-model', 'archived-zstd/before-archive']) {
      for (const lines of rollouts(folder).values()) {
        for (const line of lines) expect(line).toMatchObject({ timestamp: expect.any(String), type: expect.any(String) });
      }
    }
  });

  it('a paginated rollout numbers every line with a consecutive ordinal; a legacy one never does', () => {
    expect(sessionMeta(paginated).history_mode).toBe('paginated');
    expect(paginated.map((l) => l.ordinal)).toEqual(paginated.map((_, i) => i));

    expect(sessionMeta(legacy).history_mode).toBe('legacy');
    expect(legacy.every((l) => l.ordinal === undefined)).toBe(true);
  });

  it('only a paginated rollout records structured command results; legacy keeps the legacy events', () => {
    const failed = completedItems(paginated, 'CommandExecution').find((i) => i.status === 'failed');
    // `node -e "process.exit(3)"` under PowerShell: the shell flattens the exit code to 1.
    expect(failed).toMatchObject({ exit_code: 1, status: 'failed' });

    expect(events(legacy, 'item_completed')).toHaveLength(0);
    expect(events(legacy, 'user_message')).toHaveLength(1);
    expect(events(legacy, 'mcp_tool_call_end')).toHaveLength(1);
  });

  it('both modes carry the exit code in the unified-exec output text', () => {
    for (const lines of [paginated, legacy]) {
      const failing = callNamed(lines, 'exec_command', 2);
      expect(String(failing.arguments)).toContain('process.exit(3)');
      expect(String(outputOf(lines, String(failing.call_id)))).toMatch(
        /^Chunk ID: [0-9a-f]{6}\nWall time: [\d.]+ seconds\nProcess exited with code 1\nOriginal token count: \d+\nOutput:\n/,
      );
    }
  });

  it('a long-running command reports a session id, and its later write_stdin carries the exit code', () => {
    for (const lines of [paginated, legacy]) {
      const started = String(outputOf(lines, String(callNamed(lines, 'exec_command', 3).call_id)));
      const session = /Process running with session ID (\d+)/.exec(started)?.[1];
      expect(session).toBeDefined();
      expect(started).not.toMatch(/Process exited/);

      const poll = callNamed(lines, 'write_stdin');
      expect(JSON.parse(String(poll.arguments)).session_id).toBe(Number(session));
      expect(String(outputOf(lines, String(poll.call_id)))).toMatch(/\nProcess exited with code 0\n/);
    }
  });

  it('apply_patch output uses the "Exit code: N" header', () => {
    const patch = items(paginated, 'custom_tool_call').find((p) => p.name === 'apply_patch');

    expect(String(outputOf(paginated, String(patch!.call_id)))).toMatch(/^Exit code: 0\nWall time: \d+ seconds\nOutput:\n/);
  });

  it('a compaction, in both modes: the summary as an assistant message, then compacted, world_state, turn_context, thread_settings_applied', () => {
    for (const folder of ['compaction', 'compaction-legacy']) {
      const lines = onlyRollout(folder);
      const at = lines.findIndex((l) => l.type === 'compacted');
      expect(at, folder).toBeGreaterThan(0);

      const summary = lines.slice(0, at).filter((l) => l.type === 'response_item').at(-1)!;
      expect(summary.payload, folder).toMatchObject({ type: 'message', role: 'assistant', content: [{ text: expect.stringMatching(/^SUMMARY:/) }] });
      expect(lines[at]!.payload).toMatchObject({ message: expect.stringContaining('SUMMARY:'), replacement_history: expect.any(Array) });
      expect(lines.slice(at + 1, at + 4).map((l) => l.payload.type ?? l.type), folder).toEqual([
        'world_state',
        'turn_context',
        'thread_settings_applied',
      ]);
    }
    expect(completedItems(onlyRollout('compaction'), 'ContextCompaction')).toHaveLength(1);

    const legacy = onlyRollout('compaction-legacy');
    expect(sessionMeta(legacy).history_mode).toBe('legacy');
    expect(events(legacy, 'item_completed')).toHaveLength(0);
    expect(events(legacy, 'context_compacted')).toHaveLength(1);
  });

  it('history mode is per file: a legacy root thread spawns a paginated subagent thread', () => {
    const threads = [...rollouts('subagent-legacy-root').entries()];
    expect(threads).toHaveLength(2);
    const [rootId, root] = threads.find(([id, lines]) => sessionMeta(lines).session_id === id)!;
    const [childId, child] = threads.find(([id]) => id !== rootId)!;

    // An app-server thread (source "vscode") carries no thread_source at all.
    expect(sessionMeta(root)).toMatchObject({ history_mode: 'legacy', source: 'vscode' });
    expect(sessionMeta(root)).not.toHaveProperty('thread_source');
    expect(root.every((l) => l.ordinal === undefined)).toBe(true);

    expect(sessionMeta(child)).toMatchObject({ history_mode: 'paginated', thread_source: 'subagent', session_id: rootId, parent_thread_id: rootId });
    expect(child.map((l) => l.ordinal)).toEqual(child.map((_, i) => i));
    const spawn = callNamed(root, 'spawn_agent');
    expect(JSON.parse(String(outputOf(root, String(spawn.call_id))))).toMatchObject({ agent_id: childId });
  });

  it.skipIf(typeof zlib.zstdDecompressSync !== 'function')(
    "Node decodes Codex's own zstd frame of an archived session to the rollout as it was before archiving",
    () => {
      // Both files are Codex's bytes, unchanged: the run held no user name, so nothing was sanitized.
      const dir = `${TRANSCRIPTS}/archived-zstd`;
      const [name] = readdirSync(fixturePath(`${dir}/archived_sessions`));
      expect(name).toMatch(/^rollout-.*\.jsonl\.zst$/);
      const frame = readFixtureBytes(`${dir}/archived_sessions/${name}`);
      const before = readFixtureBytes(`${dir}/before-archive/${path.basename(name!, '.zst')}`);

      expect(frame.subarray(0, 4).toString('hex')).toBe('28b52ffd');
      expect(zlib.zstdDecompressSync(frame).equals(before)).toBe(true);
      expect(sessionMeta(jsonl<RolloutLine>(before.toString('utf8'))).history_mode).toBe('paginated');
    },
  );
});

describe('Read-only codex exec on native Windows (P7)', () => {
  interface ExecEvent {
    type: string;
    item?: { type: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number; status?: string };
  }
  const stream = (name: string) => jsonl<ExecEvent>(readFixture(`codex/exec-json/${name}.jsonl`));
  const commands = (events: ExecEvent[]) =>
    events.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').map((e) => e.item!);

  it("the runner's invocation answers a stdin bundle with the schema-shaped final message", () => {
    const events = stream('runner-stdin-bundle');

    expect(events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(JSON.parse(events[2]!.item!.text!)).toEqual({ summary: 'from the stdin bundle' });
  });

  it('without prefer_mxc, the read and the write the model asked for are both refused before running', () => {
    // What Codex sent back to the model for each call (the last request's input items).
    const input = jsonl<{ type: string; call_id: string; arguments?: string; output?: string }>(
      readFixture('codex/model-input/read-only-shell-blocked.jsonl'),
    );
    const asked = input.filter((i) => i.type === 'function_call');
    expect(asked.map((c) => (JSON.parse(c.arguments!) as { cmd: string }).cmd)).toEqual(['Get-Content input.txt', 'Set-Content written.txt x']);
    for (const call of asked) {
      const answer = input.find((i) => i.type === 'function_call_output' && i.call_id === call.call_id);
      expect(answer?.output).toMatch(/^exec_command failed: CreateProcess .*rejected: blocked by policy/);
    }

    // So the exec stream shows no command at all, and the turn still completes.
    const events = stream('read-only-shell-blocked');
    expect(commands(events)).toEqual([]);
    expect(events.at(-1)!.type).toBe('turn.completed');
  });

  it('with prefer_mxc, the read runs and the write is denied by the sandbox', () => {
    const run = commands(stream('read-only-prefer-mxc'));
    const read = run.find((c) => c.command!.includes('Get-Content input.txt'));
    const write = run.find((c) => c.command!.includes('Set-Content written.txt x'));

    expect(run).toHaveLength(2);
    expect(read).toMatchObject({ status: 'completed', exit_code: 0, aggregated_output: 'two items\r\n' });
    expect(write).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(write!.aggregated_output).toMatch(/Access to the path .*written\.txt' is denied/);
  });
});

describe('Codex SessionStart hook payloads', () => {
  it('names the session, its rollout, the cwd, the model, the permission mode and the source', () => {
    const p = readFixtureJson<SessionStartPayload>('codex/hook-payloads/session-start-startup.json');

    expect(Object.keys(p)).toEqual(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'source']);
    expect(p).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup', permission_mode: 'bypassPermissions' });
    expect(p.transcript_path).toMatch(new RegExp(`\\\\sessions\\\\\\d{4}\\\\\\d{2}\\\\\\d{2}\\\\rollout-.*-${p.session_id}\\.jsonl$`));
    expect(rollouts('subagent').has(p.session_id)).toBe(true);
  });

  it('a resumed session reports source resume, with the transcript path in verbatim \\\\?\\ form', () => {
    const p = readFixtureJson<SessionStartPayload>('codex/hook-payloads/session-start-resume.json');

    expect(p.source).toBe('resume');
    expect(p.transcript_path.startsWith('\\\\?\\C:\\')).toBe(true);
  });

  it('tells the clients apart: Codex always sends permission_mode, Claude Code never does; both can send model', () => {
    const codex = ['startup', 'resume'].map((s) => readFixtureJson<Record<string, unknown>>(`codex/hook-payloads/session-start-${s}.json`));
    const claude = readdirSync(fixturePath('claude-code/hook-payloads'))
      .filter((n) => /^session-start-.*\.json$/.test(n))
      .map((n) => readFixtureJson<Record<string, unknown>>(`claude-code/hook-payloads/${n}`));

    expect(claude.length).toBeGreaterThanOrEqual(6);
    for (const p of codex) expect(p).toHaveProperty('permission_mode');
    for (const p of claude) expect(p).not.toHaveProperty('permission_mode');
    expect(codex.every((p) => 'model' in p)).toBe(true);
    expect(claude.some((p) => 'model' in p)).toBe(true);
  });
});

describe('the Codex hook string under each shell Codex runs hooks with (R2)', () => {
  // Codex 0.162.1 (hooks/src/engine/command_runner.rs, core/src/shell.rs) runs a hook as
  // PowerShell [shell, -NoProfile, -Command, cmd] with standard argument quoting, as
  // cmd.exe /c "<cmd>" with the argument raw (the last-resort fallback), or as [sh, -c, cmd]
  // on Unix. pwsh 7 takes the same argv as PowerShell 5.1; it isn't installed everywhere.
  const bootstrap = readFileSync(new URL('./codex-mcp-hooks-transcripts/hooks/bootstrap.txt', import.meta.url), 'utf8');
  const payload = JSON.stringify({ session_id: 'r2', hook_event_name: 'SessionStart', source: 'startup' });
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const shells: { name: string; file: string; args: (cmd: string) => string[]; verbatim?: boolean }[] =
    process.platform === 'win32'
      ? [
          { name: 'Windows PowerShell 5.1', file: path.win32.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: (cmd) => ['-NoProfile', '-Command', cmd] },
          { name: 'cmd', file: path.win32.join(windir, 'System32', 'cmd.exe'), args: (cmd) => ['/c', `"${cmd}"`], verbatim: true },
          { name: 'sh (Git for Windows)', file: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', args: (cmd) => ['-c', cmd] },
        ]
      : [{ name: 'sh', file: '/bin/sh', args: (cmd) => ['-c', cmd] }];
  // The hook command calls `node` from PATH, as Codex's does.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  let repo = '';

  beforeAll(async () => {
    repo = await makeTempDir('grimoire-r2-');
    mkdirSync(path.join(repo, '.git', 'grimoire'), { recursive: true });
    // Stands in for the launcher: reports what the bootstrap passed and what the hook process got.
    const launcher =
      "module.exports = (args, root) => process.stdout.write(JSON.stringify({ args, script: process.execArgv[1], stdin: require('fs').readFileSync(0, 'utf8') }));\n";
    writeFileSync(path.join(repo, '.git', 'grimoire', 'launcher.cjs'), launcher);
  });
  afterAll(() => removeDir(repo));

  for (const shell of shells) {
    it.skipIf(!existsSync(shell.file))(`${shell.name}: with or without --, node gets [hook, session-start], the bootstrap unchanged and the payload`, () => {
      for (const command of [`node -e "${bootstrap}" hook session-start`, `node -e "${bootstrap}" -- hook session-start`]) {
        const r = spawnSync(shell.file, shell.args(command), {
          cwd: repo,
          env,
          input: payload,
          encoding: 'utf8',
          windowsVerbatimArguments: Boolean(shell.verbatim),
          windowsHide: true,
          timeout: 30_000,
        });

        expect(r.status, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ args: ['hook', 'session-start'], script: bootstrap, stdin: payload });
      }
    });
  }
});

describe('Codex hook trust (P4)', () => {
  const TRUST = 'codex/hook-trust';
  const listing = (name: string) => {
    const entries = readFixtureJson<HooksListResponse>(`${TRUST}/hooks-list-${name}.json`).result.data;
    expect(entries).toHaveLength(1);
    return entries[0]!.hooks;
  };
  const GRIMOIRE_HASH = 'sha256:907a800335f52254f17625e2db025f8d8bed0c3442538cf52359b00371c7c6e8';

  /** Each handler a project config declares, at its group index among that event's groups and its index in the group. */
  function declaredHandlers(toml: string) {
    const out: { event: string; group: number; handler: number; command: string }[] = [];
    const groupsSeen = new Map<string, number>();
    let event = '';
    let group = -1;
    let handler = -1;
    for (const line of toml.split(/\r?\n/)) {
      const groupHeader = /^\[\[hooks\.(\w+)\]\]$/.exec(line);
      const command = /^command = (".*")$/.exec(line);
      if (groupHeader) {
        event = groupHeader[1]!;
        group = groupsSeen.get(event) ?? 0;
        groupsSeen.set(event, group + 1);
        handler = -1;
      } else if (line === `[[hooks.${event}.hooks]]`) handler++;
      else if (command) out.push({ event, group, handler, command: JSON.parse(command[1]!) as string });
    }
    return out;
  }
  const snakeCase = (event: string) => event.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();

  it('keys trust by declaring file, event, group index among that event’s groups, and handler index', () => {
    const configOf: Record<string, string> = {
      untrusted: 'project-config',
      trusted: 'project-config',
      'second-clone': 'project-config',
      'linked-worktree': 'project-config',
      'group-inserted': 'project-config-group-inserted',
      'timeout-changed': 'project-config-timeout-changed',
      'mixed-groups': 'project-config-mixed-groups',
    };
    for (const [name, config] of Object.entries(configOf)) {
      const declared = declaredHandlers(readFixture(`${TRUST}/${config}.toml`));
      const hooks = listing(name);
      expect(hooks.map((h) => h.command).sort(), name).toEqual(declared.map((d) => d.command).sort());
      for (const hook of hooks) {
        const d = declared.find((x) => x.command === hook.command)!;
        expect(hook.key, name).toBe(`${hook.sourcePath}:${snakeCase(d.event)}:${d.group}:${d.handler}`);
      }
    }
  });

  it('a PreToolUse group and a two-handler group before grimoire’s: grimoire is session_start group 1, and displayOrder is only a global count', () => {
    const hooks = listing('mixed-groups');
    const suffixes = hooks.map((h) => h.key.slice(h.sourcePath.length));

    expect(suffixes).toEqual([':pre_tool_use:0:0', ':session_start:0:0', ':session_start:0:1', ':session_start:1:0']);
    expect(hooks.map((h) => h.displayOrder)).toEqual([0, 1, 2, 3]);
    expect(hooks[3]!.command).toContain('hook session-start');
  });

  it('a trusted hook stays trusted only at the same position, with the same definition, in the same clone', () => {
    expect(listing('untrusted')).toMatchObject([{ trustStatus: 'untrusted', currentHash: GRIMOIRE_HASH }]);
    expect(listing('trusted')).toMatchObject([{ trustStatus: 'trusted', currentHash: GRIMOIRE_HASH }]);

    // Another group inserted before grimoire's: grimoire's unchanged hook moves to group 1 and loses trust.
    const [inserted, shifted] = listing('group-inserted');
    expect(inserted).toMatchObject({ displayOrder: 0, trustStatus: 'modified' });
    expect(shifted).toMatchObject({ displayOrder: 1, trustStatus: 'untrusted', currentHash: GRIMOIRE_HASH });

    // Same position, timeout 10 -> 11: a new hash, so "modified".
    expect(listing('timeout-changed')).toMatchObject([{ displayOrder: 0, trustStatus: 'modified', timeoutSec: 11 }]);
    expect(listing('timeout-changed')[0]!.currentHash).not.toBe(GRIMOIRE_HASH);

    // A second clone: the same hash under another file path, so untrusted.
    const [clone] = listing('second-clone');
    expect(clone).toMatchObject({ trustStatus: 'untrusted', currentHash: GRIMOIRE_HASH });
    expect(clone!.sourcePath).not.toBe(listing('trusted')[0]!.sourcePath);
  });

  it("a linked worktree runs the main checkout's hook, under the main checkout's trust key", () => {
    const [hook] = listing('linked-worktree');
    const main = listing('trusted')[0]!;
    const worktreeCwd = readFixtureJson<HooksListResponse>(`${TRUST}/hooks-list-linked-worktree.json`).result.data[0]!.cwd;

    // The fixtures hold Windows paths, so use win32 path rules on every platform.
    expect(worktreeCwd).not.toBe(path.win32.dirname(path.win32.dirname(main.sourcePath)));
    expect(path.win32.dirname(path.win32.dirname(main.sourcePath))).toMatch(/\\repos\\h2$/);
    expect(hook).toMatchObject({ key: main.key, sourcePath: main.sourcePath, trustStatus: 'trusted' });
  });

  it('the trust hash Codex reports is reproducible from the hook definition alone, by the recipe grimoire uses', () => {
    // Codex 0.162.1 (hooks/src/engine/discovery.rs hook_hash, config/src/fingerprint.rs):
    // sha256 over compact JSON, keys sorted, of {event_name, matcher?, hooks: [handler]}.
    const hashOf = (hook: HookMetadata) =>
      codexHookGroupHash({
        // The event name is the snake_case one in the key, e.g. pre_tool_use.
        event_name: hook.key.slice(hook.sourcePath.length + 1).split(':')[0]!,
        matcher: hook.matcher,
        hooks: [{ type: hook.handlerType, command: hook.command, timeout: hook.timeoutSec, async: hook.async }],
      });

    const all = ['untrusted', 'group-inserted', 'timeout-changed', 'second-clone', 'mixed-groups'].flatMap(listing);
    expect(all.length).toBe(9);
    expect(all.filter((h) => h.matcher !== null)).toHaveLength(1);
    for (const hook of all) expect(hashOf(hook)).toBe(hook.currentHash);
  });

  it('trust is written to the user config as hooks.state.<key>.trusted_hash', () => {
    const state = readFixture(`${TRUST}/user-config-hooks-state.toml`);
    const [trusted] = listing('trusted');

    expect(state).toContain(`[hooks.state.'${trusted!.key}']`);
    expect(state).toContain(`trusted_hash = "${trusted!.currentHash}"`);
  });
});

describe('Spike E fixture hygiene (sanitize.mjs)', () => {
  it('flags a shortened copy of the user name and any Users path that is not USER', () => {
    // PowerShell's CategoryInfo line shortens long paths with "...".
    const shortened = 'PermissionDenied: (C:\\\\Users\\\\alexan...tmp\\\\written.txt:String)';

    expect(userNameLeftovers(shortened, 'alexandria')).not.toEqual([]);
    expect(foreignUserPaths(shortened)).toEqual(['Users\\\\alexan...tmp']);
    expect(foreignUserPaths('C:/Users/alexandria/x')).toEqual(['Users/alexandria']);
  });

  it('accepts USER in every escaping, and takes a user name with regex characters literally', () => {
    for (const p of ['C:\\Users\\USER\\x', 'C:\\\\Users\\\\USER\\\\x', 'C:\\\\\\\\Users\\\\\\\\USER\\\\\\\\x', 'C:/Users/USER/x', 'C:\\\\Users\\\\USER...tmp']) {
      expect(foreignUserPaths(p), p).toEqual([]);
    }
    expect(userNameLeftovers('C:\\Users\\USER\\a.b+(c', 'a.b+(c')).toEqual(['a.b+(c', 'a.b+(']);
  });

  it('no Codex fixture names a Windows user other than USER, in any file or zstd frame', () => {
    const files = readdirSync(fixturePath('codex'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => `codex/${path.relative(fixturePath('codex'), path.join(d.parentPath, d.name)).split(path.sep).join('/')}`);
    expect(files.length).toBeGreaterThan(30);

    for (const file of files) {
      const bytes = readFixtureBytes(file);
      if (file.endsWith('.zst') && typeof zlib.zstdDecompressSync !== 'function') continue;
      const text = (file.endsWith('.zst') ? zlib.zstdDecompressSync(bytes) : bytes).toString('utf8');
      expect(foreignUserPaths(text), file).toEqual([]);
    }
  });
});
