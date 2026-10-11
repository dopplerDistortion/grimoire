// Client contract for the Codex capture reader (GOK-137; spec §14 Readers,
// Window, Roots, Statuses; §22 T4, T6; seam 2). Real, sanitized Codex 0.162.1
// rollouts from spike E (GOK-130), captured under a scripted model, go in with
// the binding evidence; steps, window, excerpt and status come out. Findings
// behind the fixtures: docs/research/spikes/codex-mcp-hooks-transcripts.md.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePath, makeTempDir, readFixture, readFixtureBytes, removeDir } from '#harness';
import {
  cutCodex,
  readCodexTranscript,
  type BindingCall,
  type CodexCutInput,
  type Cut,
  type CutEvidence,
  type Step,
  type ToolResultStep,
} from '../../src/capture';

const TX = 'codex/transcripts';

/** The home folder, and the temp folder the spike's repos lived in. */
const HOME = 'C:\\Users\\USER';
const TMP = 'C:\\Users\\USER\\AppData\\Local\\Temp';
const repo = (name: string) => `${TMP}\\gok130\\repos\\${name}`;

/** Scenario A under `codex exec`: history mode paginated. */
const PAGINATED_THREAD = '01a12946-7d23-7f93-b8c8-aa18d1bca5ef';
const PAGINATED = `${TX}/paginated/rollout-2026-10-11T07-44-07-${PAGINATED_THREAD}.jsonl`;
/** Scenario A's MCP call, `echo {text: "show gr-7k2pq"}`: the binding call the evidence names. */
const PAGINATED_ECHO = { id: 'call_2_0', at: '2026-10-11T04:44:09.130Z' };

function cut(transcript: string, context: string, evidence: CutEvidence, extra: Partial<CodexCutInput> = {}): Promise<Cut> {
  return cutCodex({
    transcript: fixturePath(transcript),
    context,
    evidence,
    paths: { home: HOME, repo: repo('a1'), tmp: TMP },
    ...extra,
  });
}

describe('a paginated session (scenario A)', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [PAGINATED_ECHO],
  };

  it('is cut from the prompt opening the turn with the binding call to the transcript end, with the ordinal as the reach', async () => {
    const result = await cut(PAGINATED, PAGINATED_THREAD, evidence);

    expect(result.status).toBe('cut');
    expect(result.notes).toEqual([]);
    expect(result.client).toEqual({ name: 'codex', version: '0.162.1' });
    expect(result.session).toBe(PAGINATED_THREAD);
    expect(result.context).toBe(PAGINATED_THREAD);
    // The user's prompt (the `UserMessage` item), and the closing assistant message.
    expect(result.window).toEqual({
      start: { at: '2026-10-11T04:44:09.060Z', ref: '8' },
      end: { at: '2026-10-11T04:44:26.300Z', ref: '48' },
    });
    expect(result.reach).toEqual({ at: '2026-10-11T04:44:26.300Z', ref: '48' });
    expect(result.steps.map(label)).toEqual([
      'prompt',
      'call tool_search',
      'result ok',
      'call mcp__probe__echo',
      'result ok',
      'call exec_command',
      'result ok',
      'call exec_command',
      'result ok',
      'call exec_command',
      'result error',
      'call apply_patch',
      'result ok',
      'call exec_command',
      'result ok',
      'call write_stdin',
      'result ok',
      'assistant',
    ]);
    expect(result.lines).toEqual({ read: 52, unknown: 0, malformed: 0 });
    await expectGolden('paginated', result);
  });
});

/** Scenario A through the app-server with `historyMode: "legacy"`. */
const LEGACY_THREAD = '01a12947-770e-7b53-9c8c-cb3dc787936c';
const LEGACY = `${TX}/legacy/rollout-2026-10-11T07-45-11-${LEGACY_THREAD}.jsonl`;
const LEGACY_ECHO = { id: 'call_2_0', at: '2026-10-11T04:45:12.010Z' };

describe('a legacy session (scenario A)', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:45:00.000Z',
    bindingCalls: [LEGACY_ECHO],
  };

  it('has no ordinals, so the line index is the reach; the failing command is read from its "Process exited with code" text', async () => {
    const result = await cutLegacy(fixturePath(LEGACY), evidence);

    expect(result.status).toBe('cut');
    expect(result.session).toBe(LEGACY_THREAD);
    // The `user_message` event on line 7, and the assistant message on line 43.
    expect(result.window).toEqual({
      start: { at: '2026-10-11T04:45:11.975Z', ref: '7' },
      end: { at: '2026-10-11T04:45:29.235Z', ref: '43' },
    });
    expect(result.steps.map(label)).toEqual([
      'prompt',
      'call tool_search',
      'result ok',
      'call mcp__probe__echo',
      'result ok',
      'call exec_command',
      'result ok',
      'call exec_command',
      'result ok',
      'call exec_command',
      'result error',
      'call apply_patch',
      'result ok',
      'call exec_command',
      'result ok',
      'call write_stdin',
      'result ok',
      'assistant',
    ]);
    expect(result.lines).toEqual({ read: 47, unknown: 0, malformed: 0 });
    await expectGolden('legacy', result);
  });

  it('flags apply_patch failures from "Exit code: N" when there is no structured record', async () => {
    const file = await editedCopy(LEGACY, (lines) =>
      lines
        .filter((line) => !line.includes('"type":"patch_apply_end"'))
        .map((line) => (line.includes('"custom_tool_call_output"') ? line.replace('Exit code: 0', 'Exit code: 1') : line)),
    );
    const result = await cutLegacy(file, evidence);

    expect(result.steps.filter((s) => s.kind === 'tool_result').map((s) => s.error)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  function cutLegacy(file: string, evidence: CutEvidence): Promise<Cut> {
    const paths = { home: HOME, repo: repo('l1'), tmp: TMP };
    return cutCodex({ transcript: file, context: LEGACY_THREAD, evidence, paths });
  }
});

describe('failure flags', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [PAGINATED_ECHO],
  };
  const resultErrors = (result: Cut) => result.steps.filter((s) => s.kind === 'tool_result').map((s) => s.error);

  it('come from the structured record before the text: a CommandExecution status or exit code overrides "Process exited with code"', async () => {
    // The skill read (call_3_0) recorded as failed, the failing node (call_5_0) as completed with 0;
    // their output texts still read "exited with code 0" and "exited with code 1".
    const file = await editedCopy(PAGINATED, (lines) =>
      lines.map((line) =>
        editJson(line, (l) => {
          const item = (l.payload as { item?: Record<string, unknown> }).item;
          if (item?.type !== 'CommandExecution') return;
          if (item.id === 'call_3_0') Object.assign(item, { status: 'failed', exit_code: 2 });
          if (item.id === 'call_5_0') Object.assign(item, { status: 'completed', exit_code: 0 });
        }),
      ),
    );
    const result = await cutFile(file, PAGINATED_THREAD, evidence);

    expect(resultErrors(result)).toEqual([false, false, true, false, false, false, false, false]);
  });

  it('give a long-running command’s exit code to the write_stdin poll that saw it exit, never to the exec_command that started it', async () => {
    const failing = await editedCopy(PAGINATED, (lines) =>
      lines.map((line) =>
        editJson(line, (l) => {
          const item = (l.payload as { item?: Record<string, unknown> }).item;
          if (item?.type === 'CommandExecution' && item.process_id === '10767') {
            Object.assign(item, { status: 'failed', exit_code: 1 });
          }
        }),
      ),
    );
    const result = await cutFile(failing, PAGINATED_THREAD, evidence);
    const original = await cut(PAGINATED, PAGINATED_THREAD, evidence);

    // exec_command (still running) ok, write_stdin (saw it exit) error.
    expect(resultErrors(result).slice(-2)).toEqual([false, true]);
    expect(resultErrors(original).slice(-2)).toEqual([false, false]);
  });

  it('come from the poll’s own text when there is no structured record (legacy)', async () => {
    const file = await editedCopy(LEGACY, (lines) =>
      lines.map((line) =>
        line.includes('"call_id":"call_8_0"') ? line.replace('Process exited with code 0', 'Process exited with code 7') : line,
      ),
    );
    const result = await cutCodex({
      transcript: file,
      context: LEGACY_THREAD,
      evidence: { ...evidence, attemptOpenedAt: '2026-10-11T04:45:00.000Z', bindingCalls: [LEGACY_ECHO] },
      paths: { home: HOME, repo: repo('l1'), tmp: TMP },
    });

    expect(resultErrors(result).slice(-2)).toEqual([false, true]);
  });
});

const COMPACTED_THREAD = '01a12940-f9ff-7c52-8090-6d13f0b1b0a2';
const COMPACTED = `${TX}/compaction/rollout-2026-10-11T07-38-06-${COMPACTED_THREAD}.jsonl`;

describe('a compacted session', () => {
  // `echo "before compaction"` binds; the compaction runs mid-turn, then `echo "after compaction"`.
  const evidence: CutEvidence = {
    issue: 'gr-3',
    attemptOpenedAt: '2026-10-11T04:38:00.000Z',
    bindingCalls: [{ id: 'call_2_0', at: '2026-10-11T04:38:06.830Z' }],
  };
  const paths = { home: HOME, repo: `${TMP}\\gok130\\runs\\compact1\\work`, tmp: TMP };

  it('is cut across the compaction, kept as one step holding the summarizer’s reply, which is not assistant text', async () => {
    const result = await cutCodex({ transcript: fixturePath(COMPACTED), context: COMPACTED_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
    expect(result.steps.map(label)).toEqual([
      'prompt',
      'call tool_search',
      'result ok',
      'call mcp__probe__echo',
      'result ok',
      'compaction',
      'call mcp__probe__echo',
      'result ok',
      'assistant',
    ]);
    expect(result.steps.find((s) => s.kind === 'compaction')).toMatchObject({
      text: 'SUMMARY: the user asked for scripted probe calls; all ran.',
      ref: '21',
    });
    expect(result.steps.filter((s) => s.kind === 'assistant').map((s) => s.kind === 'assistant' && s.text)).toEqual([
      'compacted turn done',
    ]);
    await expectGolden('compaction', result);
  });

  it('folds the reply as the last response item before the compacted line, even unmarked', async () => {
    const file = await editedCopy(COMPACTED, (lines) =>
      lines.map((line) =>
        editJson(line, (l) => void delete (l.metadata as { compaction_output?: unknown } | undefined)?.compaction_output),
      ),
    );
    const result = await cutCodex({ transcript: file, context: COMPACTED_THREAD, evidence, paths });
    const original = await cutCodex({ transcript: fixturePath(COMPACTED), context: COMPACTED_THREAD, evidence, paths });

    expect(readFixture(COMPACTED)).toContain('"compaction_output":true');
    expect(result.excerpt).toBe(original.excerpt);
  });
});

const ROOT_THREAD = '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72';
const CHILD_THREAD = '01a12947-16a2-7152-be00-4e4b1e12a4d8';
const ROOT = `${TX}/subagent/rollout-2026-10-11T07-44-45-${ROOT_THREAD}.jsonl`;
const CHILD = `${TX}/subagent/rollout-2026-10-11T07-44-47-${CHILD_THREAD}.jsonl`;
/** The child thread's `echo "child reads gr-7k2pq"`. */
const CHILD_ECHO = { id: 'call_5_0', at: '2026-10-11T04:44:47.400Z' };

describe('a subagent thread (T4 confirmed)', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [CHILD_ECHO],
  };
  const paths = { home: HOME, repo: repo('b1'), tmp: TMP };

  it('that made the binding calls is cut from its own rollout, found by thread id under the Codex home', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [ROOT, CHILD] });
    const result = await cutCodex({ codexHome, context: CHILD_THREAD, session: ROOT_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
    expect(result.session).toBe(ROOT_THREAD);
    expect(result.context).toBe(CHILD_THREAD);
    expect(result.steps.map(label)).toEqual([
      'prompt',
      'call tool_search',
      'result ok',
      'call mcp__probe__echo',
      'result ok',
      'call exec_command',
      'result ok',
      'assistant',
    ]);
    await expectGolden('subagent', result);
  });

  it('appears in the launching thread only as its launch and result, and as the wait for it', async () => {
    const read = await readCodexTranscript(fixturePath(ROOT));
    const root = await cutCodex({ transcript: fixturePath(ROOT), context: ROOT_THREAD, evidence, paths });

    expect(read.found).toBe(true);
    if (!read.found) return;
    expect(read.transcript.steps.map(label)).toEqual([
      'prompt',
      'call tool_search',
      'result ok',
      'launch spawn_agent',
      'subagent result ok',
      'call wait_agent',
      'result ok',
      'call mcp__probe__echo',
      'result ok',
      'assistant',
    ]);
    expect(read.transcript.steps.find((s) => s.kind === 'subagent_result')).toMatchObject({ agentId: CHILD_THREAD });
    expect(read.transcript.steps.find((s) => s.kind === 'subagent_launch')).toMatchObject({ agentType: null });
    // The child's call is not the root's: checked against the root alone, it is missing.
    expect(root.status).toBe('unreadable');
  });

  it('the launching thread’s own cut keeps the subagent as its launch, its result and the wait', async () => {
    // The root's `echo "root closes gr-7k2pq"`, after the subagent finished.
    const result = await cutCodex({
      transcript: fixturePath(ROOT),
      context: ROOT_THREAD,
      evidence: { ...evidence, bindingCalls: [{ id: 'call_8_0', at: '2026-10-11T04:44:47.735Z' }] },
      paths,
    });

    expect(result.status).toBe('cut');
    expect(result.window?.start.ref).toBe('8');
    await expectGolden('subagent-root', result);
  });

  it('spawned with its parent’s history (fork_context) is cut after the copied records, which subagent_history_start_ordinal marks', async () => {
    // The field comes from Codex's source (spike E); spike E's run didn't fork, so it is set here by hand:
    // the child's records before ordinal 12 (its prompt and tool_search) stand for the copied history.
    const file = await editedCopy(CHILD, (lines) =>
      lines.map((line) =>
        line.includes('"type":"session_meta"')
          ? line.replace('"history_mode":"paginated"', '"history_mode":"paginated","subagent_history_start_ordinal":12')
          : line,
      ),
    );
    const read = await readCodexTranscript(file);
    const result = await cutCodex({ transcript: file, context: CHILD_THREAD, evidence, paths });

    expect(read.found && read.transcript.copiedSteps).toBe(3);
    expect(result.status).toBe('cut');
    expect(result.window?.start.ref).toBe('12');
  });

  it('with no rollout of its own gives not_found, naming the session and context', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [ROOT] });
    const result = await cutCodex({ codexHome, context: CHILD_THREAD, session: ROOT_THREAD, evidence, paths });

    expect(result.status).toBe('not_found');
    expect(result).toMatchObject({ session: ROOT_THREAD, context: CHILD_THREAD, excerpt: null, steps: [] });
  });
});

/** Scenario A's paginated session after `thread/archive` and `rollout/compress`. */
const ARCHIVED_ZST = `${TX}/archived-zstd/archived_sessions/rollout-2026-10-11T07-44-07-${PAGINATED_THREAD}.jsonl.zst`;

describe('archived and compressed sessions', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [PAGINATED_ECHO],
  };
  const paths = { home: HOME, repo: repo('a1'), tmp: TMP };

  it('are found in archived_sessions/ by thread id, and a .jsonl.zst is read through Node’s zstd', async () => {
    const codexHome = await codexHomeWith({ archived_sessions: [ARCHIVED_ZST] });
    const result = await cutCodex({ codexHome, context: PAGINATED_THREAD, evidence, paths });
    const live = await cut(PAGINATED, PAGINATED_THREAD, evidence);

    expect(result.status).toBe('cut');
    expect(result.steps).toEqual(live.steps);
    expect(result.reach).toEqual({ at: '2026-10-11T04:44:26.300Z', ref: '48' });
    await expectGolden('archived-zstd', result);
  });

  it('are found from a hook’s transcript_path, in its extended \\\\?\\ spelling, after the file was archived and compressed', async () => {
    const codexHome = await codexHomeWith({ archived_sessions: [ARCHIVED_ZST] });
    const hookPath = `\\\\?\\${path.join(codexHome, 'sessions', '2026', '10', '11', path.basename(PAGINATED))}`;
    const result = await cutCodex({ transcript: hookPath, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
    expect(result.reach?.ref).toBe('48');
  });

  it('are read where they were compressed in place, from the plain name a hook gave', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [ARCHIVED_ZST] });
    const hookPath = path.join(codexHome, 'sessions', '2026', '10', '11', path.basename(PAGINATED));
    const result = await cutCodex({ transcript: hookPath, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
  });

  it('prefer the plain rollout when both a .jsonl and a .jsonl.zst exist, as Codex does', async () => {
    const plain = await editedCopy(PAGINATED, (lines) => [...lines, lines.at(-1)!.replace('"ordinal":51', '"ordinal":52')]);
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [ARCHIVED_ZST] });
    await writeFile(path.join(codexHome, 'sessions', '2026', '10', '11', path.basename(PAGINATED)), await readFile(plain));
    const result = await cutCodex({ codexHome, context: PAGINATED_THREAD, evidence, paths });

    expect(result.lines.read).toBe(53);
  });

  it('give not_found when the thread is in neither sessions/ nor archived_sessions/', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [LEGACY], archived_sessions: [ROOT] });
    const result = await cutCodex({ codexHome, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('not_found');
  });

  it('are searched in every day folder up to the call’s day, newest first, when the thread’s own day doesn’t hold it', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/09/30': [PAGINATED], 'sessions/2026/10/20': [] });
    const result = await cutCodex({ codexHome, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
  });

  it('give budget when the search runs out of time, so the next sweep tries again', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [PAGINATED] });
    const result = await cutCodex({ codexHome, context: PAGINATED_THREAD, evidence, paths, deadline: Date.now() - 1 });

    expect(result.status).toBe('budget');
    expect(result.excerpt).toBeNull();
  });

  it('are unreadable, never partly read, when the zstd frame is cut short', async () => {
    const dir = await tempDir();
    const bytes = readFixtureBytes(ARCHIVED_ZST);
    const file = path.join(dir, path.basename(ARCHIVED_ZST));
    await writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const result = await cutCodex({ transcript: file, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('unreadable');
    expect(result.steps).toEqual([]);
    expect(await readCodexTranscript(file)).toMatchObject({ found: false, unreadable: 'zstd_corrupt' });
  });

  it('are searched by id when the given transcript is another thread’s', async () => {
    const codexHome = await codexHomeWith({ 'sessions/2026/10/11': [PAGINATED, LEGACY] });
    const other = path.join(codexHome, 'sessions', '2026', '10', '11', path.basename(LEGACY));
    const result = await cutCodex({ transcript: other, context: PAGINATED_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
    expect(result.context).toBe(PAGINATED_THREAD);
  });
});

describe('the format check', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [PAGINATED_ECHO],
  };

  it('gives unreadable, with no excerpt and no steps, when a binding call id is missing inside the parsed range', async () => {
    // A call grimoire saw while this rollout was being written, which isn't in it.
    const missing = { id: 'call_9_9', at: '2026-10-11T04:44:15.000Z' };
    const result = await cut(PAGINATED, PAGINATED_THREAD, { ...evidence, bindingCalls: [PAGINATED_ECHO, missing] });

    expect(result.status).toBe('unreadable');
    expect(result).toMatchObject({ excerpt: null, steps: [], window: null, reach: null });
  });

  it('cuts to the flushed end with tail_unflushed when a binding call is only past the last line', async () => {
    // Flushed up to the failing node command's output; the write_stdin poll is the ending call.
    const file = await editedCopy(PAGINATED, (lines) => lines.slice(0, lineOf(lines, '"type":"custom_tool_call"')));
    const ending = { id: 'call_8_0', at: '2026-10-11T04:44:21.310Z' };
    const result = await cutFile(file, PAGINATED_THREAD, { ...evidence, bindingCalls: [PAGINATED_ECHO, ending] });

    expect(result.status).toBe('cut');
    expect(result.notes).toEqual(['tail_unflushed']);
    expect(result.reach).toEqual({ at: '2026-10-11T04:44:10.436Z', ref: '31' });
  });

  it('ignores a torn last line', async () => {
    const file = await editedCopy(
      PAGINATED,
      (lines) => {
        const torn = lineOf(lines, '"call_id":"call_8_0","internal');
        return [...lines.slice(0, torn), lines[torn]!.slice(0, 120)];
      },
      { trailingNewline: false },
    );
    const result = await cutFile(file, PAGINATED_THREAD, evidence);

    expect(result.status).toBe('cut');
    expect(result.lines.malformed).toBe(0);
    expect(result.steps.at(-1)).toMatchObject({ kind: 'tool_result', id: 'call_7_0' });
  });

  it('skips and counts a torn fragment Codex left mid-file, and then never trusts a missing call to be unflushed', async () => {
    // Codex reopened the file after a crash: it wrote "\n" after the fragment and went on.
    const file = await editedCopy(PAGINATED, (lines) => {
      const at = lineOf(lines, '"call_id":"call_5_0","internal');
      return [...lines.slice(0, at), lines[at]!.slice(0, 90), ...lines.slice(at)];
    });
    const whole = await cutFile(file, PAGINATED_THREAD, evidence);
    const missingAfter = await cutFile(file, PAGINATED_THREAD, {
      ...evidence,
      bindingCalls: [PAGINATED_ECHO, { id: 'call_9_9', at: '2026-10-11T04:45:00.000Z' }],
    });

    expect(whole.status).toBe('cut');
    expect(whole.lines.malformed).toBe(1);
    expect(whole.steps.map(label)).toEqual((await cut(PAGINATED, PAGINATED_THREAD, evidence)).steps.map(label));
    expect(missingAfter.status).toBe('unreadable');
  });

  it('skips and counts unknown line, item and event types, and the excerpt is unchanged', async () => {
    // A line type, a response item, an event and a structured item from a Codex this reader predates.
    const file = await editedCopy(PAGINATED, (lines) => {
      const at = lineOf(lines, '"type":"world_state"');
      return [
        ...lines.slice(0, at),
        lines[at]!.replace('"type":"world_state"', '"type":"future_line"'),
        lines[at + 1]!.replace('"type":"turn_context","payload":{', '"type":"response_item","payload":{"type":"future_item",'),
        lines[at + 1]!.replace('"type":"turn_context","payload":{', '"type":"event_msg","payload":{"type":"future_event",'),
        lines[at + 1]!.replace(
          '"type":"turn_context","payload":{',
          '"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FutureItem"},',
        ),
        ...lines.slice(at),
      ];
    });
    const original = await cut(PAGINATED, PAGINATED_THREAD, evidence);
    const result = await cutFile(file, PAGINATED_THREAD, evidence);

    expect(original.lines.unknown).toBe(0);
    expect(result.lines.unknown).toBe(4);
    expect(result.excerpt).toBe(original.excerpt);
  });
});

const MCP_RESULTS_THREAD = '01a12939-d71a-7861-812d-d92ac82d7fe6';
const MCP_RESULTS = `${TX}/mcp-results/rollout-2026-10-11T07-30-18-${MCP_RESULTS_THREAD}.jsonl`;
const MCP_PATHS = { home: HOME, repo: `${TMP}\\gok130\\runs\\mcp2\\work`, tmp: TMP };

/** mcp-results with the probe server renamed `grimoire`, so its tools are grimoire operations. */
function asGrimoire(lines: string[]): string[] {
  return lines.map((line) => line.replaceAll('"namespace":"mcp__probe"', '"namespace":"mcp__grimoire"'));
}

describe('MCP results', () => {
  it('are read from a string or an array of content items, with the "Wall time" header stripped; an MCP failure is flagged from its record', async () => {
    const read = await readCodexTranscript(fixturePath(MCP_RESULTS));

    expect(read.found).toBe(true);
    if (!read.found) return;
    // After the tool_search result: echo, big (24,482 bytes, whole), which (structuredContent only),
    // boom (a JSON-RPC error, as two content items), then the parallel p1 and p2.
    const results = read.transcript.steps.filter((s): s is ToolResultStep => s.kind === 'tool_result').slice(1);
    const text = (id: string) => results.find((s) => s.id === id)?.text;

    expect(results.map((s) => [s.id, s.error])).toEqual([
      ['call_2_0', false],
      ['call_3_0', false],
      ['call_4_0', false],
      ['call_5_0', true],
      ['call_6_0', false],
      ['call_6_1', false],
    ]);
    expect(text('call_4_0')).toBe('{"seen_via":"structuredContent"}');
    expect(text('call_5_0')).toBe('tool call error: tool call failed for `probe/boom`\n\nCaused by:\n    Mcp error: -32603: probe exploded');
    expect(text('call_3_0')).toMatch(/^\{"rows":\[\{"id":"row-0".*"truncated":true,"cursor":"137"\}$/s);
    expect(results.filter((s) => s.text.includes('Wall time'))).toEqual([]);
  });
});

describe('matching a binding call without a call id (T6 fallback)', () => {
  // T6 is confirmed: Codex 0.162.1 always sends `_meta.callId`. The fallback is for a call without one.
  const attempt = { issue: 'gr-9', attemptOpenedAt: '2026-10-11T04:30:00.000Z' };
  /** Cuts mcp-results, its probe renamed grimoire, with `bindingCalls` as the evidence. */
  async function cutCalls(...bindingCalls: BindingCall[]): Promise<Cut> {
    const file = await editedCopy(MCP_RESULTS, asGrimoire);
    return cutFile(file, MCP_RESULTS_THREAD, { ...attempt, bindingCalls }, { paths: MCP_PATHS });
  }

  it('finds the one grimoire call of that tool bracketing the time grimoire saw it', async () => {
    const result = await cutCalls({ grimoire: 'echo', at: '2026-10-11T04:30:19.120Z' });
    const byId = await cutCalls({ id: 'call_2_0', at: '2026-10-11T04:30:19.120Z' });

    expect(result.status).toBe('cut');
    expect(result.excerpt).toBe(byId.excerpt);
    expect(result.steps.find((s) => s.kind === 'tool_call' && s.id === 'call_2_0')).toMatchObject({
      name: 'mcp__grimoire__echo',
      grimoire: 'echo',
    });
  });

  it('gives unmatched when more than one call fits: the two parallel echo calls', async () => {
    const result = await cutCalls({ grimoire: 'echo', at: '2026-10-11T04:30:19.235Z' });

    expect(result.status).toBe('unmatched');
    expect(result).toMatchObject({ excerpt: null, steps: [], window: null });
  });

  it('gives unmatched when no call fits inside the parsed range, and a time cut to the second fits only a call within that second', async () => {
    const none = await cutCalls({ grimoire: 'claim', at: '2026-10-11T04:30:19.150Z' });
    const which = await cutCalls({ grimoire: 'which', at: '2026-10-11T04:30:19.000Z' });
    const echo = await cutCalls({ grimoire: 'echo', at: '2026-10-11T04:30:19.000Z' });

    expect(none.status).toBe('unmatched');
    expect(which.status).toBe('cut');
    expect(echo.status).toBe('unmatched');
  });

  it('cuts to the flushed end with tail_unflushed when the time is past the last line', async () => {
    const result = await cutCalls(
      { id: 'call_2_0', at: '2026-10-11T04:30:19.120Z' },
      { grimoire: 'close', at: '2026-10-11T04:31:00.000Z' },
    );

    expect(result.status).toBe('cut');
    expect(result.notes).toEqual(['tail_unflushed']);
  });
});

describe('knowledge chores', () => {
  const evidence: CutEvidence = {
    issue: 'gr-7k2pq',
    attemptOpenedAt: '2026-10-11T04:44:00.000Z',
    bindingCalls: [{ id: 'call_8_0', at: '2026-10-11T04:44:47.735Z' }],
  };
  const paths = { home: HOME, repo: repo('b1'), tmp: TMP };

  it('are kept out of the excerpt: a grimoire-chores subagent’s launch, result and the wait for it, and every chore_* call', async () => {
    // The subagent root, with its spawn_agent given the grimoire-chores role (the spec's Codex
    // chore carrier) and its tool_search call made a grimoire chore_start call.
    const file = await editedCopy(ROOT, (lines) =>
      lines.map((line) =>
        editJson(line, (l) => {
          const payload = l.payload as Record<string, unknown>;
          if (payload.type === 'function_call' && payload.name === 'spawn_agent') {
            const args = JSON.parse(payload.arguments as string) as Record<string, unknown>;
            payload.arguments = JSON.stringify({ ...args, agent_type: 'grimoire-chores' });
          }
          if (payload.type === 'tool_search_call') {
            const call = { type: 'function_call', namespace: 'mcp__grimoire', name: 'chore_start', arguments: '{}' };
            Object.assign(payload, call);
          }
        }),
      ),
    );
    const result = await cutCodex({ transcript: file, context: ROOT_THREAD, evidence, paths });
    const original = await cutCodex({ transcript: fixturePath(ROOT), context: ROOT_THREAD, evidence, paths });

    expect(result.status).toBe('cut');
    // Out of the fact scans too: the cut's steps hold none of them.
    expect(result.steps.map(label)).toEqual(['prompt', 'call mcp__probe__echo', 'result ok', 'assistant']);
    expect(result.excerpt).not.toMatch(/^tool (?:spawn_agent|wait_agent|mcp__grimoire__chore_start)$/m);
    // The spawn's result and the wait's result (the chore's last message).
    expect(result.excerpt).not.toMatch(/Kierkegaard|"completed":"child done"/);
    expect(result.callIds).toEqual(['call_8_0']);
    expect(original.excerpt).toMatch(/tool spawn_agent[\s\S]*tool wait_agent/);
  });
});

describe('the reader', () => {
  it.each([
    [PAGINATED],
    [LEGACY],
    [COMPACTED],
    [ROOT],
    [CHILD],
    [MCP_RESULTS],
    [ARCHIVED_ZST],
  ])('knows every line, item and event type Codex 0.162.1 wrote in %s', async (file) => {
    const read = await readCodexTranscript(fixturePath(file));

    expect(read.found && read.transcript.lines).toMatchObject({ unknown: 0, malformed: 0 });
  });

  it('names the grimoire operation of MCP calls, and marks exec_command calls that run the grimoire CLI', async () => {
    const commands = new Map([
      ['call_3_0', 'node .grimoire/run.cjs comment gr-7k2pq --body done'],
      ['call_4_0', 'npm run -s grimoire -- claim gr-7k2pq'],
    ]);
    const file = await editedCopy(PAGINATED, (lines) =>
      asGrimoire(lines).map((line) =>
        editJson(line, (l) => {
          const payload = l.payload as Record<string, unknown>;
          const command = commands.get(payload.call_id as string);
          if (payload.type === 'function_call' && command) payload.arguments = JSON.stringify({ cmd: command });
        }),
      ),
    );
    const read = await readCodexTranscript(file);
    const calls = read.found ? read.transcript.steps.filter((s) => s.kind === 'tool_call') : [];

    expect(calls.map((s) => [s.name, s.grimoire])).toEqual([
      ['tool_search', null],
      ['mcp__grimoire__echo', 'echo'],
      ['exec_command', 'cli'],
      ['exec_command', 'cli'],
      ['exec_command', null],
      ['apply_patch', null],
      ['exec_command', null],
      ['write_stdin', null],
    ]);
  });

  it('reads the session and context from the first session_meta: a subagent thread names its root as the session', async () => {
    const child = await readCodexTranscript(fixturePath(CHILD));

    expect(child.found && [child.transcript.session, child.transcript.context]).toEqual([ROOT_THREAD, CHILD_THREAD]);
    expect(child.found && child.transcript.copiedSteps).toBe(0);
  });
});

// Temp copies of real fixtures, for the cases a client writes only now and then
// (a torn line, a line type from a newer version). Each copy is the real rollout
// with the stated lines cut, inserted or edited, nothing else.

/** The index of the first line containing `needle`. */
function lineOf(lines: readonly string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`no line contains ${needle}`);
  return index;
}

/**
 * Copies a fixture rollout under its own name into `dir` (default: a fresh temp
 * folder), with `edit` applied to its lines.
 */
async function editedCopy(
  relPath: string,
  edit: (lines: string[]) => string[] = (lines) => lines,
  { dir, trailingNewline = true }: { dir?: string; trailingNewline?: boolean } = {},
): Promise<string> {
  const lines = edit(readFixture(relPath).split('\n').filter((line) => line !== ''));
  const target = dir ?? (await tempDir());
  await mkdir(target, { recursive: true });
  const file = path.join(target, path.basename(relPath));
  await writeFile(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

/** Parses a rollout line, lets `mutate` edit it, and writes it back as Codex does (compact JSON). */
function editJson(line: string, mutate: (line: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  mutate(parsed);
  return JSON.stringify(parsed);
}

/** A fresh `CODEX_HOME` holding byte copies of fixture rollouts, by folder (`sessions/YYYY/MM/DD`, `archived_sessions`). */
async function codexHomeWith(folders: Record<string, string[]>): Promise<string> {
  const home = await tempDir();
  for (const [folder, files] of Object.entries(folders)) {
    const dir = path.join(home, ...folder.split('/'));
    await mkdir(dir, { recursive: true });
    for (const file of files) await writeFile(path.join(dir, path.basename(file)), readFixtureBytes(file));
  }
  return home;
}

function cutFile(file: string, context: string, evidence: CutEvidence, extra: Partial<CodexCutInput> = {}): Promise<Cut> {
  return cutCodex({ transcript: file, context, evidence, paths: { home: HOME, repo: repo('a1'), tmp: TMP }, ...extra });
}

// Temp folders made by a test, removed after it.
let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map(removeDir));
  tempDirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('grimoire-codex-capture-');
  tempDirs.push(dir);
  return dir;
}

function label(step: Step): string {
  switch (step.kind) {
    case 'tool_call':
    case 'subagent_launch':
      return `${step.kind === 'tool_call' ? 'call' : 'launch'} ${step.name}`;
    case 'tool_result':
    case 'subagent_result':
      return `${step.kind === 'tool_result' ? 'result' : 'subagent result'} ${step.error ? 'error' : 'ok'}`;
    default:
      return step.kind;
  }
}

/**
 * Golden files, reviewed by hand: `<name>.excerpt.txt` holds the excerpt, and
 * `<name>.cut.json` the rest of the cut (status, window, reach, counts and the
 * window's steps). Update them with `vitest -u`, then review the diff.
 */
async function expectGolden(name: string, result: Cut): Promise<void> {
  const { excerpt, ...rest } = result;
  await expect(excerpt).toMatchFileSnapshot(`./golden/codex/${name}.excerpt.txt`);
  await expect(`${JSON.stringify(rest, null, 2)}\n`).toMatchFileSnapshot(`./golden/codex/${name}.cut.json`);
}
