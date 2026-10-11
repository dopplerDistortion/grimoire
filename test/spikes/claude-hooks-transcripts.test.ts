// Spike A (GOK-126): the Claude Code 2.1.296 behaviours that the bootstrap, the
// identity hint and the transcript reader rest on, encoded against the real,
// sanitized artifacts the spike captured (seam 2). Findings and verdicts:
// docs/research/spikes/claude-hooks-transcripts.md.
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureJson, runCommand } from '#harness';

interface PreToolUsePayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  mcp_server?: { name: string; source: string };
  agent_id?: string;
  agent_type?: string;
}

interface SessionStartPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  source: string;
}

interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: string;
    updatedInput: Record<string, unknown>;
    permissionDecision?: string;
  };
}

interface ToolsCallRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

const HOOKS = 'claude-code/hook-payloads';
const OUTPUTS = 'claude-code/hook-outputs';
const META = 'claude-code/meta';
/** The reserved key the spike's probe hook filled (the MCP slice picks the real name). */
const HINT_KEY = '_grimoire_hint';

describe('Claude Code hook payloads (spike A)', () => {
  it('a main-thread PreToolUse for a grimoire tool names the session, transcript and tool use, and no agent', () => {
    const p = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use.json`);

    expect(p.hook_event_name).toBe('PreToolUse');
    expect(p.tool_name).toBe('mcp__grimoire__show');
    expect(p.tool_input).toEqual({ ref: 'gr-1' });
    expect(p.tool_use_id).toMatch(/^toolu_/);
    expect(p.transcript_path.endsWith(`${p.session_id}.jsonl`)).toBe(true);
    expect(p.permission_mode).toBe('default');
    expect(p.mcp_server).toEqual({ name: 'grimoire', source: 'project' });
    expect(p).not.toHaveProperty('agent_id');
    expect(p).not.toHaveProperty('agent_type');
  });

  it('a subagent PreToolUse adds agent_id and agent_type but keeps the parent session and transcript', () => {
    const p = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use-subagent.json`);

    expect(p.tool_name).toBe('mcp__grimoire__show');
    expect(p.agent_id).toMatch(/^[0-9a-f]{17}$/);
    expect(p.agent_type).toBe('general-purpose');
    // The transcript named is the parent's; the subagent's own file is found by agent_id.
    expect(p.transcript_path.endsWith(`${p.session_id}.jsonl`)).toBe(true);
  });

  it.each(['startup', 'clear', 'compact', 'resume', 'fork'])(
    'SessionStart reports source %s and names its own transcript',
    (source) => {
      const p = readFixtureJson<SessionStartPayload>(`${HOOKS}/session-start-${source}.json`);

      expect(p.hook_event_name).toBe('SessionStart');
      expect(p.source).toBe(source);
      expect(p.transcript_path.endsWith(`${p.session_id}.jsonl`)).toBe(true);
    },
  );
});

describe('the identity hint through PreToolUse updatedInput (spike A, T1)', () => {
  it('the honoured output adds the reserved key to the unchanged input and makes no permission decision', () => {
    const payload = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use.json`);
    const out = readFixtureJson<PreToolUseOutput>(`${OUTPUTS}/pre-tool-use-updated-input.json`);

    expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    const { [HINT_KEY]: hint, ...rest } = out.hookSpecificOutput.updatedInput;
    expect(rest).toEqual(payload.tool_input);
    expect(hint).toEqual({
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      tool_use_id: payload.tool_use_id,
    });
  });

  it('the server receives the updated input verbatim, with _meta naming the same tool use', () => {
    const payload = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use.json`);
    const out = readFixtureJson<PreToolUseOutput>(`${OUTPUTS}/pre-tool-use-updated-input.json`);
    const call = readFixtureJson<ToolsCallRequest>(`${META}/tools-call.json`);

    expect(call.method).toBe('tools/call');
    expect(call.params.name).toBe('show');
    expect(call.params.arguments).toEqual(out.hookSpecificOutput.updatedInput);
    expect(call.params._meta?.['claudecode/toolUseId']).toBe(payload.tool_use_id);
  });

  it('the ids-only hint, honoured even under the auto-mode classifier, carries no transcript path', () => {
    const out = readFixtureJson<PreToolUseOutput>(`${OUTPUTS}/pre-tool-use-updated-input-ids-only.json`);

    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    const hint = out.hookSpecificOutput.updatedInput[HINT_KEY] as Record<string, unknown>;
    expect(Object.keys(hint).sort()).toEqual(['session_id', 'tool_use_id']);
  });
});

/** One transcript line, loosely typed: the reader slices own the real model. */
interface Line {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  isCompactSummary?: boolean;
  compactMetadata?: { trigger?: string };
  attachment?: { type?: string; hookName?: string; toolUseID?: string; stdout?: string };
  message?: { id?: string; content?: unknown };
  toolUseResult?: { agentId?: string };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const TX = 'claude-code/transcripts';

function readJsonl(relPath: string): Line[] {
  return readFixture(relPath)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Line);
}

function blocks(lines: Line[]): Block[] {
  return lines.flatMap((l) => (Array.isArray(l.message?.content) ? (l.message.content as Block[]) : []));
}

const toolUses = (lines: Line[]) => blocks(lines).filter((b) => b.type === 'tool_use');
const toolResults = (lines: Line[]) => blocks(lines).filter((b) => b.type === 'tool_result');
const hookLine = (lines: Line[], hookName: string) =>
  lines.find((l) => l.attachment?.type === 'hook_success' && l.attachment.hookName === hookName);
const sessionIds = (lines: Line[]) => new Set(lines.flatMap((l) => (l.sessionId ? [l.sessionId] : [])));
const uuids = (lines: Line[]) => new Set(lines.flatMap((l) => (l.uuid ? [l.uuid] : [])));

const PLAIN = '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5';
const CLEAR_BEFORE = '249ac573-2f00-49b8-8848-8ef2b4e1dd2e';
const CLEAR_AFTER = 'bd89d1c0-6593-4567-9ccc-8433da1492d2';
const COMPACTED = '18aa1670-988c-4aaf-bb6f-ca64e8e30d07';
const FORKED = 'c90649d0-b4ab-422d-83f0-0869304b2c19';
const PARENT = '0e195270-803a-4006-be3c-4af4e288c343';
const SPILLED = '38eff1c4-f34f-4747-8ebf-9de8df2a86bd';

describe('Claude Code transcripts (spike A)', () => {
  it('a plain session: one session id, and the hook-named call in it with the model’s own input; the hint is only in the hook record', () => {
    const lines = readJsonl(`${TX}/plain/${PLAIN}.jsonl`);
    const payload = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use.json`);

    expect(sessionIds(lines)).toEqual(new Set([PLAIN]));
    const call = toolUses(lines).find((b) => b.id === payload.tool_use_id);
    expect(call?.name).toBe('mcp__grimoire__show');
    expect(call?.input).toEqual({ ref: 'gr-1' });
    expect(hookLine(lines, 'PreToolUse:mcp__grimoire__show')?.attachment?.stdout).toContain(HINT_KEY);
  });

  it('a plain session: is_error is often absent, one message spans several lines, and git’s commit line is in a result', () => {
    const lines = readJsonl(`${TX}/plain/${PLAIN}.jsonl`);
    const results = toolResults(lines);

    expect(results.some((r) => r.is_error === true)).toBe(true);
    expect(results.some((r) => !('is_error' in r))).toBe(true);
    const ids = lines.flatMap((l) => (l.type === 'assistant' && l.message?.id ? [l.message.id] : []));
    expect(new Set(ids).size).toBeLessThan(ids.length);
    expect(JSON.stringify(results)).toMatch(/\[main [0-9a-f]{7,}\] Add notes/);
  });

  it('/clear starts a new transcript file under a new session id, with no copied history', () => {
    const before = readJsonl(`${TX}/clear/${CLEAR_BEFORE}.jsonl`);
    const after = readJsonl(`${TX}/clear/${CLEAR_AFTER}.jsonl`);

    expect(sessionIds(before)).toEqual(new Set([CLEAR_BEFORE]));
    expect(sessionIds(after)).toEqual(new Set([CLEAR_AFTER]));
    expect([...uuids(after)].filter((u) => uuids(before).has(u))).toEqual([]);
    expect(hookLine(after, 'SessionStart:clear')).toBeDefined();
    expect(JSON.stringify(after)).toContain('<command-name>/clear</command-name>');
  });

  it('compaction stays in the same file and session, behind a compact boundary and one summary line', () => {
    const lines = readJsonl(`${TX}/compaction/${COMPACTED}.jsonl`);

    expect(sessionIds(lines)).toEqual(new Set([COMPACTED]));
    const at = lines.findIndex((l) => l.subtype === 'compact_boundary');
    expect(at).toBeGreaterThan(0);
    expect(lines[at]?.parentUuid).toBeNull();
    expect(lines[at]?.compactMetadata?.trigger).toBe('manual');
    expect(lines.filter((l) => l.isCompactSummary === true)).toHaveLength(1);
    expect(toolUses(lines.slice(0, at)).some((b) => b.name === 'mcp__grimoire__comment')).toBe(true);
    expect(hookLine(lines, 'SessionStart:compact')).toBeDefined();
  });

  it('a fork copies history under its own session id; the copy keeps uuids, call ids and timestamps, and ends at SessionStart:fork', () => {
    const origin = readJsonl(`${TX}/fork/${COMPACTED}.jsonl`);
    const fork = readJsonl(`${TX}/fork/${FORKED}.jsonl`);

    // sessionId is rewritten on copied lines, so it can't tell copied history apart.
    expect(sessionIds(fork)).toEqual(new Set([FORKED]));
    const boundary = fork.findIndex((l) => l.attachment?.hookName === 'SessionStart:fork');
    expect(boundary).toBeGreaterThan(0);
    const copied = fork.slice(0, boundary).filter((l) => l.uuid);
    const own = fork.slice(boundary).filter((l) => l.uuid);
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((l) => uuids(origin).has(l.uuid!))).toBe(true);
    expect(own.every((l) => !uuids(origin).has(l.uuid!))).toBe(true);
    const originCallIds = new Set(toolUses(origin).map((b) => b.id));
    expect(toolUses(copied).every((b) => originCallIds.has(b.id))).toBe(true);
    // Copied lines keep their original timestamps, all before the fork started.
    const forkedAt = fork[boundary]!.timestamp!;
    expect(copied.every((l) => l.timestamp! < forkedAt)).toBe(true);
  });

  it('a subagent writes <session>/subagents/agent-<agent_id>.jsonl, found from the PreToolUse agent_id or the launch result', () => {
    const payload = readFixtureJson<PreToolUsePayload>(`${HOOKS}/pre-tool-use-subagent.json`);
    const parent = readJsonl(`${TX}/subagent/${PARENT}.jsonl`);
    const sub = readJsonl(`${TX}/subagent/${PARENT}/subagents/agent-${payload.agent_id}.jsonl`);
    const meta = readFixtureJson<{ agentType: string; toolUseId: string }>(
      `${TX}/subagent/${PARENT}/subagents/agent-${payload.agent_id}.meta.json`,
    );

    expect(payload.session_id).toBe(PARENT);
    expect(sessionIds(sub)).toEqual(new Set([PARENT]));
    expect(sub.every((l) => l.isSidechain === true && l.agentId === payload.agent_id)).toBe(true);
    expect(toolUses(sub).find((b) => b.id === payload.tool_use_id)?.name).toBe('mcp__grimoire__show');
    // The parent holds only the launch and the result.
    expect(toolUses(parent).find((b) => b.id === meta.toolUseId)?.name).toBe('Agent');
    expect(meta.agentType).toBe(payload.agent_type);
    expect(parent.find((l) => l.toolUseResult?.agentId)?.toolUseResult?.agentId).toBe(payload.agent_id);
    expect(toolUses(parent).some((b) => b.id === payload.tool_use_id)).toBe(false);
  });

  it('a large tool result spills to <session>/tool-results/, leaving a preview in the transcript', () => {
    const lines = readJsonl(`${TX}/spill/${SPILLED}.jsonl`);
    const spilled = toolResults(lines).find(
      (r) => typeof r.content === 'string' && r.content.startsWith('<persisted-output>'),
    );
    const named = /[\\/]tool-results[\\/](\w+\.txt)/.exec(String(spilled?.content));

    expect(String(spilled?.content)).toContain(SPILLED);
    expect(named).not.toBeNull();
    expect(readFixture(`${TX}/spill/${SPILLED}/tool-results/${named![1]}`)).toMatch(/^line 0 /);
  });

  it('--resume without --fork-session appends to the same file under the same session id', () => {
    const before = readJsonl(`${TX}/clear/${CLEAR_AFTER}.jsonl`);
    const resumed = readJsonl(`${TX}/resume/${CLEAR_AFTER}.jsonl`);

    expect(sessionIds(resumed)).toEqual(new Set([CLEAR_AFTER]));
    expect(resumed.slice(0, before.length)).toEqual(before);
    expect(hookLine(resumed.slice(before.length), 'SessionStart:resume')).toBeDefined();
  });
});

describe('node -e argument layout for client entries (spike A, R3)', () => {
  // Stands in for the bootstrap: prints what the script sees after `node -e <script>`.
  const PRINT_ARGS = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const DIR = 'C:/Users/ö x/repo';

  it('refuses --from right after the script, because node reads it as one of its own options', async () => {
    const r = await runCommand(process.execPath, ['-e', PRINT_ARGS, '--from', DIR, 'hook', 'pre-tool-use']);

    expect(r.code).toBe(9);
    expect(r.stderr).toContain('bad option: --from');
  });

  it('after --, the script gets [--from, dir, verb, event] starting at process.argv[1]', async () => {
    const r = await runCommand(process.execPath, ['-e', PRINT_ARGS, '--', '--from', DIR, 'hook', 'pre-tool-use']);

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['--from', DIR, 'hook', 'pre-tool-use']);
  });

  it('a verb first also ends node’s option parsing, and the mcp entry needs nothing else', async () => {
    const hook = await runCommand(process.execPath, ['-e', PRINT_ARGS, 'hook', 'pre-tool-use', '--from', DIR]);
    const mcp = await runCommand(process.execPath, ['-e', PRINT_ARGS, 'mcp']);

    expect(JSON.parse(hook.stdout)).toEqual(['hook', 'pre-tool-use', '--from', DIR]);
    expect(JSON.parse(mcp.stdout)).toEqual(['mcp']);
  });
});
