// Spike E (GOK-130): the Codex CLI 0.162.1 behaviours that the MCP server, the
// hook entry, the Codex transcript reader and the re-approval notices rest on,
// encoded against the real, sanitized artifacts the spike captured (seam 2).
// Findings and verdicts: docs/research/spikes/codex-mcp-hooks-transcripts.md.
//
// Model turns were scripted by a local stand-in for the Responses API (Codex
// was not logged in); everything else in these artifacts is the real Codex.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fixturePath, readFixture, readFixtureBytes, readFixtureJson } from '#harness';

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

  it('Codex starts one MCP server process per thread, the subagent thread included', () => {
    expect(jsonl(readFixture('codex/mcp/subagent/starts.jsonl'))).toHaveLength(2);
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
});

describe('Codex rollouts in both history modes', () => {
  const paginated = onlyRollout('paginated');
  const legacy = onlyRollout('legacy');

  it('every line of every transcript fixture is a JSON object with timestamp, type and payload', () => {
    for (const folder of ['paginated', 'legacy', 'subagent', 'compaction', 'mcp-results']) {
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

  it('a compaction writes a compacted line, then world_state, turn_context and thread_settings_applied', () => {
    const lines = onlyRollout('compaction');
    const at = lines.findIndex((l) => l.type === 'compacted');

    expect(at).toBeGreaterThan(0);
    expect(lines[at]!.payload).toMatchObject({ message: expect.stringContaining('SUMMARY:'), replacement_history: expect.any(Array) });
    expect(lines.slice(at + 1, at + 4).map((l) => l.payload.type ?? l.type)).toEqual([
      'world_state',
      'turn_context',
      'thread_settings_applied',
    ]);
    expect(completedItems(lines, 'ContextCompaction')).toHaveLength(1);
  });

  it.skipIf(typeof zlib.zstdDecompressSync !== 'function')(
    'an archived, compressed session is the same rollout behind a zstd frame Node can read',
    () => {
      const dir = `${TRANSCRIPTS}/archived-zstd/archived_sessions`;
      const [name] = readdirSync(fixturePath(dir));
      expect(name).toMatch(/^rollout-.*\.jsonl\.zst$/);

      const decoded = zlib.zstdDecompressSync(readFixtureBytes(`${dir}/${name}`));
      const plainName = readdirSync(fixturePath(`${TRANSCRIPTS}/paginated`))[0];
      expect(path.basename(name!, '.zst')).toBe(plainName);
      expect(decoded.equals(readFixtureBytes(`${TRANSCRIPTS}/paginated/${plainName}`))).toBe(true);
    },
  );
});

describe('Read-only codex exec on native Windows (P7)', () => {
  interface ExecEvent {
    type: string;
    item?: { type: string; text?: string; command?: string; exit_code?: number; status?: string };
  }
  const stream = (name: string) => jsonl<ExecEvent>(readFixture(`codex/exec-json/${name}.jsonl`));
  const commands = (events: ExecEvent[]) =>
    events.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').map((e) => e.item!);

  it("the runner's invocation answers a stdin bundle with the schema-shaped final message", () => {
    const events = stream('runner-stdin-bundle');

    expect(events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(JSON.parse(events[2]!.item!.text!)).toEqual({ summary: 'from the stdin bundle' });
  });

  it('without prefer_mxc every shell command is refused; with it, reads run and writes are denied', () => {
    expect(commands(stream('read-only-shell-blocked'))).toEqual([]);

    const [read, write] = commands(stream('read-only-prefer-mxc'));
    expect(read).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(write).toMatchObject({ status: 'failed', exit_code: 1 });
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
});

describe('Codex hook trust (P4)', () => {
  const TRUST = 'codex/hook-trust';
  const listing = (name: string) => {
    const entries = readFixtureJson<HooksListResponse>(`${TRUST}/hooks-list-${name}.json`).result.data;
    expect(entries).toHaveLength(1);
    return entries[0]!.hooks;
  };
  const GRIMOIRE_HASH = 'sha256:907a800335f52254f17625e2db025f8d8bed0c3442538cf52359b00371c7c6e8';

  it('keys trust by declaring file, event, group position and handler position', () => {
    for (const name of ['untrusted', 'trusted', 'group-inserted', 'timeout-changed', 'second-clone', 'linked-worktree']) {
      for (const hook of listing(name)) {
        expect(hook.key).toBe(`${hook.sourcePath}:session_start:${hook.displayOrder}:0`);
      }
    }
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

    expect(worktreeCwd).not.toBe(path.dirname(path.dirname(main.sourcePath)));
    expect(hook).toMatchObject({ key: main.key, sourcePath: main.sourcePath, trustStatus: 'trusted' });
  });

  it('the trust hash Codex reports is reproducible from the hook definition alone', () => {
    // Codex 0.162.1 (hooks/src/engine/discovery.rs hook_hash, config/src/fingerprint.rs):
    // sha256 over compact JSON, keys sorted, of {event_name, matcher?, hooks: [handler]}.
    const sortKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
          : v;
    const codexHookHash = (hook: HookMetadata) => {
      const handler = { type: hook.handlerType, command: hook.command, timeout: hook.timeoutSec, async: hook.async };
      const identity = { event_name: 'session_start', ...(hook.matcher !== null && { matcher: hook.matcher }), hooks: [handler] };
      return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex')}`;
    };

    const all = ['untrusted', 'group-inserted', 'timeout-changed', 'second-clone'].flatMap(listing);
    expect(all.length).toBe(5);
    for (const hook of all) expect(codexHookHash(hook)).toBe(hook.currentHash);
  });

  it('trust is written to the user config as hooks.state.<key>.trusted_hash', () => {
    const state = readFixture(`${TRUST}/user-config-hooks-state.toml`);
    const [trusted] = listing('trusted');

    expect(state).toContain(`[hooks.state.'${trusted!.key}']`);
    expect(state).toContain(`trusted_hash = "${trusted!.currentHash}"`);
  });
});
