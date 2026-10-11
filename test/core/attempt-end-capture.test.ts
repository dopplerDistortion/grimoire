// Seam 1 (spec Testing Decisions; §14 Cut at attempt end, Pending session
// records, Statuses; §3 The attempt directory; §19): every attempt-ending op
// cuts the bound contexts that ran on this machine and seals their session
// records, `end.md` and the outcome in one commit. Real Claude Code and Codex
// transcripts from the seam-2 fixtures stand in for the clients' transcripts:
// their tool-use ids stand in for the ids of the grimoire calls the tests make.
import * as childProcess from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { appendFile, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, vi } from 'vitest';
import { FIXTURES_DIR, fixturePath, makeTempDir, removeDir, type Checkout } from '#harness';
import { seenHereRows, sessionKey, type SeenHereRow } from '../../src/capture/seen-here';
import { registerSweep } from '../../src/capture/sweeps';
import { recordRevealedRoot } from '../../src/capture/transcript-roots';
import type { CallContext, Core, CoreOptions } from '../../src/core';
import { traceCapture, type TraceCapture } from '../../src/core/capture';
import { putMachineSetting } from '../../src/core/settings';
import { MachineLocalStore } from '../../src/machine-local';
import { createScanner } from '../../src/scanner';
import { openTracker } from '../../src/tracker';
import { agentContext, commitToTracker, coreTest, fetchTracker, pushTracker, TRACKER_REF, trackerFile, trackerTip } from './support';

// Lets a test put a slow git in place of one git the core runs.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;

/** Runs as `node -e <script> -- <delay ms> <done file> ::git <args>`: the real git, `delay` late; then writes the done file. */
const SLOW_GIT = `
const at = process.argv.indexOf('::git');
const [delay, done] = process.argv.slice(1, at);
setTimeout(() => {
  const run = require('node:child_process').spawnSync('git', process.argv.slice(at + 1), { stdio: 'inherit', windowsHide: true });
  require('node:fs').writeFileSync(done, 'done');
  process.exit(run.status ?? 1);
}, Number(delay));
`;

/** Puts a git answering `delayMs` late in place of the next git the core runs whose arguments match `command`. */
function slowNextGit(command: RegExp, delayMs: number, doneFile: string): { restore(): void } {
  let left = 1;
  vi.mocked(childProcess.spawn).mockImplementation(((name: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (name !== 'git' || left === 0 || !command.test(args.join(' '))) return realSpawn(name, args, options);
    left--;
    return realSpawn(process.execPath, ['-e', SLOW_GIT, '--', String(delayMs), doneFile, '::git', ...args], options);
  }) as unknown as typeof childProcess.spawn);
  return { restore: () => vi.mocked(childProcess.spawn).mockImplementation(realSpawn) };
}

/** Claude Code's spike-A subagent session: the main line launched one subagent, which called grimoire. */
const CLAUDE_SESSION = '0e195270-803a-4006-be3c-4af4e288c343';
const CLAUDE_AGENT = 'aa0434c9616245e9e';
const CLAUDE_TX = 'claude-code/transcripts/subagent';
/** The main line's `Agent` launch, and the subagent's `mcp__grimoire__show` (standing in for grimoire writes). */
const MAIN_CALL = 'toolu_01BWyzp3ee5Q6rwGmHjUoyey';
const SUBAGENT_CALL = 'toolu_01RgZkxkBkrfVmCHWzxZ2nWH';

/** A seam-2 golden excerpt (test/client-contract/golden/). */
const golden = (name: string) => readFileSync(new URL(`../client-contract/golden/${name}.excerpt.txt`, import.meta.url), 'utf8');

const DEBRIEF = { asked: 'Show gr-5', tried: 'A subagent', failed: 'none', worked: 'It showed it', next: 'none' };

/** A Claude Code `projects/` tree holding the fixture sessions, as `$CLAUDE_CONFIG_DIR` would. */
async function claudeConfigDir(...sessions: { folder: string; session: string }[]): Promise<string> {
  const dir = await makeTempDir('grimoire-claude-config-');
  const project = path.join(dir, 'projects', 'C--Users-user-proj');
  await mkdir(project, { recursive: true });
  for (const { folder, session } of sessions) {
    await cp(fixturePath(`${folder}/${session}.jsonl`), path.join(project, `${session}.jsonl`));
    // Its subagents' own transcripts, when it has any.
    const subagents = path.join(FIXTURES_DIR, folder, session);
    if (existsSync(subagents)) await cp(subagents, path.join(project, session), { recursive: true });
  }
  return dir;
}

/** A Claude Code MCP call from the subagent session's main line (or its subagent), with the hook's hint matching `_meta`. */
function claudeCall(base: CallContext, toolUseId: string, agentId?: string): CallContext {
  return claudeCallIn(base, CLAUDE_SESSION, toolUseId, agentId === undefined ? undefined : { id: agentId, type: 'general-purpose' });
}

/** A Claude Code MCP call from `session`'s main line, or one of its subagents, with the hook's hint matching `_meta`. */
function claudeCallIn(base: CallContext, session: string, toolUseId: string, agent?: { id: string; type?: string }): CallContext {
  const hint = {
    session_id: session,
    tool_use_id: toolUseId,
    ...(agent !== undefined ? { agent_id: agent.id, ...(agent.type !== undefined ? { agent_type: agent.type } : {}) } : {}),
  };
  return {
    ...base,
    client: { name: 'claude-code', version: '2.1.296' },
    evidence: {},
    mcp: { era: 'modern', hint, meta: { 'claudecode/toolUseId': toolUseId } },
    nonce: 'nonce-claude',
  };
}

/** Sets the store's excerpt mode, as `init` or a human's `settings set excerpts` would. */
async function setExcerptMode(checkout: Checkout, mode: 'excerpts' | 'facts' | 'none'): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact(
      { op: 'settings-set', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'human', client: 'cli', nonce: 'n' } },
      (draft) => {
        draft.putSetting('excerpts', mode, 'alice@example.com');
        return { result: null };
      },
    );
  } finally {
    await tracker.close();
  }
}

/** A session record as committed: its frontmatter values by key, and its body. */
interface StoredRecord {
  readonly name: string;
  readonly fields: Record<string, unknown>;
  readonly body: string;
}

function parseRecord(name: string, text: string): StoredRecord {
  expect(text.startsWith('---\n')).toBe(true);
  const close = text.indexOf('\n---\n', 3);
  const fields: Record<string, unknown> = {};
  for (const line of text.slice(4, close).split('\n')) {
    const colon = line.indexOf(': ');
    fields[line.slice(0, colon)] = JSON.parse(line.slice(colon + 2));
  }
  return { name, fields, body: text.slice(close + 5) };
}

const attemptDir = (id: string, attempt: string) => `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;

/** The session records of `attempt` at the tracker tip. */
async function sessionRecords(checkout: Checkout, id: string, attempt: string): Promise<StoredRecord[]> {
  const tip = (await trackerTip(checkout))!;
  const dir = `${attemptDir(id, attempt)}/sessions`;
  const listed = await checkout.gitResult(['ls-tree', '--name-only', `${tip}:${dir}`]);
  if (listed.code !== 0) return [];
  const names = listed.stdout.split('\n').filter(Boolean);
  return Promise.all(names.map(async (name) => parseRecord(name, await trackerFile(checkout, tip, `${dir}/${name}`))));
}

/** The capture of `attempt` as the core derives it from the tracker in `checkout`. */
async function captureOf(checkout: Checkout, attempt: string): Promise<TraceCapture> {
  const tracker = await openTracker(checkout.dir);
  try {
    return await traceCapture(await tracker.read(), attempt);
  } finally {
    await tracker.close();
  }
}

async function created(core: Core, ctx: CallContext, title: string): Promise<string> {
  const outcome = await core.call('create', { title }, ctx);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.result.id;
}

/** `coreTest` plus a Claude Code config dir holding the subagent session, and a core whose capture searches it. */
const test = coreTest.extend('capture', async ({ world, grimoire }, { onCleanup }) => {
  const configDir = await claudeConfigDir(
    { folder: CLAUDE_TX, session: CLAUDE_SESSION },
    { folder: 'claude-code/transcripts/plain', session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5' },
    { folder: 'claude-code/transcripts/chore-fork', session: CHORE_SESSION },
  );
  onCleanup(() => removeDir(configDir));
  let now = new Date('2026-10-11T03:27:17.500Z');
  // The temp folder holding the config dir stands in for the home folder: roots read `~/<config dir>/projects`.
  const options = (extra: CoreOptions = {}): CoreOptions => ({
    ...extra,
    clock: () => now,
    capture: {
      claudeConfigDir: configDir,
      codexHome: path.join(configDir, 'no-codex'),
      home: path.dirname(configDir),
      flushWaitMs: 50,
      ...extra.capture,
    },
  });
  await setExcerptMode(world.a, 'excerpts');
  return {
    configDir,
    core: grimoire.makeCore(options()),
    makeCore: (extra: CoreOptions = {}) => grimoire.makeCore(options(extra)),
    at: (iso: string) => {
      now = new Date(iso);
    },
  };
});

describe('closing an attempt', () => {
  test('claim → update (with the handle) from a subagent → close seals one session record per bound context, each cut from its own transcript, in the one commit that writes end.md', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Show gr-5');
    const claim = await core.call('claim', { id }, claudeCall(grimoire.ctx, MAIN_CALL));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:27:20.300Z');
    const update = await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    expect(update.ok).toBe(true);
    const beforeClose = (await trackerTip(world.a))!;
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_not_flushed'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done', outcome: 'pass' } });
    // One commit: end.md, the outcome and both session records.
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--count', `${beforeClose}..${TRACKER_REF}`])).toBe('1');
    const changed = (await world.a.git(['diff', '--name-only', beforeClose, tip])).split('\n');
    expect(changed).toEqual(expect.arrayContaining([`${attemptDir(id, attempt)}/end.md`]));
    const records = await sessionRecords(world.a, id, attempt);
    expect(records).toHaveLength(2);
    for (const record of records) expect(changed).toContain(`${attemptDir(id, attempt)}/sessions/${record.name}`);

    const main = records.find((r) => r.fields.context === 'main')!;
    const subagent = records.find((r) => r.fields.context === CLAUDE_AGENT)!;
    expect(main.fields).toMatchObject({
      client: 'claude-code',
      client_version: '2.1.296',
      reader_version: 1,
      session: CLAUDE_SESSION,
      source: 'hint',
      excerpt: 'cut',
      // The close call hadn't reached the transcript: the cut stops at its flushed end.
      excerpt_notes: ['tail_unflushed'],
      facts: 'scanned',
      skills_read: [],
      commits: [],
    });
    // The main line shows the subagent only as its launch and result.
    expect(main.body).toContain('tool Agent');
    expect(main.body).not.toContain('tool mcp__grimoire__show');
    // The subagent passed the handle: its own transcript is cut (the seam-2 golden excerpt of it).
    expect(subagent.fields).toMatchObject({ session: CLAUDE_SESSION, source: 'hint', excerpt: 'cut', excerpt_notes: [] });
    expect(subagent.body).toBe(golden('claude-code/subagent'));
    expect(subagent.fields.reach).toEqual({ at: '2026-10-11T03:27:22.005Z', ref: expect.any(String) });
    expect(subagent.fields).toMatchObject({ steps: 8, steps_kept: 8, characters: subagent.body.length });

    // end.md stays attempt-level only.
    const end = await trackerFile(world.a, tip, `${attemptDir(id, attempt)}/end.md`);
    const endKeys = end.split('\n').filter((line) => line.includes(': ')).map((line) => line.slice(0, line.indexOf(':')));
    expect(endKeys).toEqual(['ended', 'ended_by', 'at', 'debrief', 'worker_kind', 'wiki_exposed', 'field_changes']);
    // Per-context entries and facts_complete are read from the session records.
    const trace = await captureOf(world.a, attempt);
    expect(trace.contexts.map((c) => [c.context, c.excerpt.status, c.facts])).toEqual(
      expect.arrayContaining([
        ['main', 'cut', 'scanned'],
        [CLAUDE_AGENT, 'cut', 'scanned'],
      ]),
    );
    expect(trace.facts_complete).toBe(true);
    // Each cut's reach is noted on its context's seen-here row.
    const rows = await seenHereRows(new MachineLocalStore(path.join(world.a.dir, '.git')), { handle: attempt });
    expect(rows.find((row) => row.context === CLAUDE_AGENT)!.reach).toEqual(subagent.fields.reach);
    expect(rows.find((row) => row.context === 'main')!.reach).toEqual(main.fields.reach);
  });
});

/** Claims `id` from Claude Code's main line as call `toolUseId`; returns the handle. */
async function claimed(core: Core, ctx: CallContext, id: string, toolUseId = MAIN_CALL): Promise<string> {
  const claim = await core.call('claim', { id }, claudeCall(ctx, toolUseId));
  if (!claim.ok) throw new Error(JSON.stringify(claim.error));
  return claim.result.attempt;
}

describe('capture problems are statuses, never errors', () => {
  test('a transcript that can’t be found gives a not_found placeholder naming the roots searched; the close succeeds', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Nowhere');
    const lost = (toolUseId: string): CallContext => {
      const ctx = claudeCall(grimoire.ctx, toolUseId);
      return { ...ctx, mcp: { ...ctx.mcp!, hint: { session_id: 'ffffffff-0000-4000-8000-000000000000', tool_use_id: toolUseId } } };
    };
    const claim = await core.call('claim', { id }, lost('toolu_lost_claim'));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt: claim.result.attempt, debrief: DEBRIEF }, lost('toolu_lost_close'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const [record] = await sessionRecords(world.a, id, claim.result.attempt);
    expect(record!.fields).toMatchObject({
      session: 'ffffffff-0000-4000-8000-000000000000',
      context: 'main',
      excerpt: 'not_found',
      facts: 'not_found',
      window_start: null,
      reach: null,
      roots: [`~${path.sep}${path.basename(capture.configDir)}${path.sep}projects`],
    });
    expect(record!.body).toBe('');
    // A context whose facts weren't scanned leaves the trace's facts incomplete: read unknown.
    expect((await captureOf(world.a, claim.result.attempt)).facts_complete).toBe(false);
  });

  test('a scanner that can’t run drops the excerpt with status unscanned; the rest of the record is written and the close succeeds', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore({ scanner: createScanner([]) });
    const id = await created(core, grimoire.ctx, 'Unscanned');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({ excerpt: 'unscanned', facts: 'scanned', steps_kept: 0, characters: 0 });
    expect(record!.fields.window_start).toMatchObject({ at: '2026-10-11T03:27:15.900Z' });
    expect(record!.body).toBe('');
  });

  test('a cut over its budget gives status budget, and the close completes without waiting for it', async ({ world, grimoire, capture }) => {
    // The ending call never reaches the transcript: without a budget the calling context would wait the whole 2 s flush wait.
    const core = capture.makeCore({ capture: { budgetMs: 1, flushWaitMs: 2_000 } });
    const id = await created(core, grimoire.ctx, 'Over budget');
    const attempt = await claimed(core, grimoire.ctx, id);
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');

    const started = Date.now();
    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    const took = Date.now() - started;

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    expect(took).toBeLessThan(2_000);
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.context, r.fields.excerpt, r.fields.facts]).sort()).toEqual([
      ['aa0434c9616245e9e', 'budget', 'budget'],
      ['main', 'budget', 'budget'],
    ]);
  });
});

describe('the hard budget', () => {
  test('bounds the calling context’s flush wait: it keeps the cut it made, and the contexts after it get budget', async ({ world, grimoire, capture }) => {
    // The ending call never reaches the transcript, and the flush wait outlasts the budget.
    const budgetMs = 1_500;
    const core = capture.makeCore({ capture: { budgetMs, flushWaitMs: 5_000 } });
    const id = await created(core, grimoire.ctx, 'Tight budget');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');

    const started = Date.now();
    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    const took = Date.now() - started;

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    expect(took).toBeGreaterThanOrEqual(budgetMs - 200);
    expect(took).toBeLessThan(4_000);
    const records = await sessionRecords(world.a, id, attempt);
    // The calling context is cut first, and waits for its ending call only until the budget runs out.
    expect(records.find((r) => r.fields.context === 'main')!.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['tail_unflushed'], facts: 'scanned' });
    expect(records.find((r) => r.fields.context === CLAUDE_AGENT)!.fields).toMatchObject({ excerpt: 'budget', facts: 'budget', reach: null });
  });
});

describe('the hard budget, finding the bound contexts', () => {
  test('covers reading the binding trailers: a git too slow for the budget leaves each context seen here with budget', async ({ world, grimoire, capture }) => {
    const budgetMs = 1_500;
    const gitDelayMs = 4_000;
    const core = capture.makeCore({ capture: { budgetMs } });
    const id = await created(core, grimoire.ctx, 'Slow git');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');
    const done = path.join(world.root, 'slow-git-done');
    const slow = slowNextGit(/ log .*--grep=Grimoire-Attempt: /, gitDelayMs, done);
    try {
      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
      const took = Date.now() - started;

      expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
      expect(took).toBeLessThan(gitDelayMs);
      const records = await sessionRecords(world.a, id, attempt);
      expect(records.map((r) => [r.fields.context, r.fields.excerpt, r.fields.facts]).sort()).toEqual([
        [CLAUDE_AGENT, 'budget', 'budget'],
        ['main', 'budget', 'budget'],
      ]);
    } finally {
      slow.restore();
      // The slow git still runs in the repo: let it finish before the repo goes.
      for (let waited = 0; !existsSync(done) && waited < gitDelayMs + 5_000; waited += 100) await sleep(100);
    }
  });
});

describe('replays', () => {
  test('replaying the close answers replayed: true without cutting again, and makes no second commit', async ({ world, grimoire, capture }) => {
    // The spec's 2 s flush wait: a cut of the calling context waits it out, since its close call never reaches the transcript.
    const core = capture.makeCore({ capture: { flushWaitMs: 2_000 } });
    const id = await created(core, grimoire.ctx, 'Replayed');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    const close = { id, reason: 'done' as const, attempt, debrief: DEBRIEF };
    expect(await core.call('close', close, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    const sealed = await trackerTip(world.a);

    const started = Date.now();
    const replay = await core.call('close', close, claudeCall(grimoire.ctx, 'toolu_close_retry'));
    const took = Date.now() - started;

    expect(replay).toMatchObject({ ok: true, result: { replayed: true, ended: 'done', attempt } });
    expect(took).toBeLessThan(1_500);
    expect(await trackerTip(world.a)).toBe(sealed);
    expect(await sessionRecords(world.a, id, attempt)).toHaveLength(1);
  });
});

describe('the excerpt mode', () => {
  test('in facts mode, records carry the entry and the facts but no excerpt text: status off', async ({ world, grimoire, capture }) => {
    await setExcerptMode(world.a, 'facts');
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Facts only');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      client: 'claude-code',
      session: CLAUDE_SESSION,
      context: 'main',
      excerpt: 'off',
      facts: 'scanned',
      skills_read: [],
      commits: [],
      steps_kept: 0,
      characters: 0,
      window_start: { at: '2026-10-11T03:27:15.900Z', ref: expect.any(String) },
    });
    expect(record!.fields.steps).toBeGreaterThan(0);
    expect(record!.fields.reach).toMatchObject({ at: expect.any(String) });
    expect(record!.body).toBe('');
  });
});

/** The main line's key, and a good earlier cut of it reaching `reach` (as a sweep leaves one waiting with the open attempt). */
function storedCut(reach: { at: string; ref: string }): { key: string; bytes: string } {
  const key = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: 'main', nonce: 'nonce-claude' });
  const bytes = [
    '---',
    'client: "claude-code"',
    'client_version: "2.1.296"',
    'reader_version: 1',
    `session: "${CLAUDE_SESSION}"`,
    'context: "main"',
    'source: "hint"',
    'window_start: {"at":"2026-10-11T03:27:15.900Z","ref":"a"}',
    `window_end: ${JSON.stringify(reach)}`,
    'steps: 1',
    'steps_kept: 1',
    'characters: 10',
    'excerpt: "cut"',
    'excerpt_notes: []',
    'facts: "scanned"',
    'skills_read: []',
    'commits: []',
    `reach: ${JSON.stringify(reach)}`,
    'cut_at: "2026-10-11T03:27:17.000Z"',
    'roots: []',
    '---',
    'user:\n | an earlier excerpt\n',
  ].join('\n');
  return { key, bytes };
}

describe('a stored record', () => {
  /** Claims as `claimCall`, stores an earlier cut reaching `reach`, closes; returns the record the seal left. */
  async function sealedOver(
    capture: { makeCore: (extra?: CoreOptions) => Core; at: (iso: string) => void },
    base: CallContext,
    checkout: Checkout,
    reach: { at: string; ref: string },
    options: { claimCall?: string; core?: CoreOptions } = {},
  ): Promise<{ key: string; record: StoredRecord }> {
    const core = capture.makeCore(options.core);
    const id = await created(core, base, 'Stored');
    const attempt = await claimed(core, base, id, options.claimCall);
    const stored = storedCut(reach);
    await commitToTracker(checkout, { [`${attemptDir(id, attempt)}/sessions/${stored.key}.md`]: stored.bytes });
    capture.at('2026-10-11T03:27:30.000Z');
    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(base, 'toolu_close'));
    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const records = await sessionRecords(checkout, id, attempt);
    expect(records).toHaveLength(1);
    return { key: stored.key, record: records[0]! };
  }

  test('a later cut that fails (unreadable) never replaces a good stored record: the seal keeps it, noted source: pending', async ({
    world,
    grimoire,
    capture,
  }) => {
    // A claim call the transcript doesn't hold, made inside its parsed range: the cut can't trust the reader.
    const { key, record } = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' }, { claimCall: 'toolu_never_written' });

    expect(record.name).toBe(`${key}.md`);
    expect(record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach: { at: '2026-10-11T03:27:16.000Z', ref: 'b' } });
    expect(record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('nor does one that reached further but lost its excerpt (unscanned)', async ({ world, grimoire, capture }) => {
    const { record } = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' }, { core: { scanner: createScanner([]) } });

    expect(record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'] });
    expect(record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('a good cut reaching strictly further replaces it; one reaching no further leaves its text, noted source: pending', async ({ world, grimoire, capture }) => {
    const further = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' });
    // The cut's last step is the main line's final assistant text, at 03:27:22.041 or before.
    const behind = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:59.000Z', ref: 'z' });

    expect(further.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['tail_unflushed'] });
    expect(further.record.body).toContain('tool Agent');
    expect(behind.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach: { at: '2026-10-11T03:27:59.000Z', ref: 'z' } });
    expect(behind.record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('a good cut reaching exactly as far doesn’t replace it either: only strictly further does', async ({ world, grimoire, capture }) => {
    // How far a cut of the main line reaches, from a seal over a record it passed.
    const reach = (await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' })).record.fields.reach as { at: string; ref: string };

    const level = await sealedOver(capture, grimoire.ctx, world.a, reach);

    expect(level.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach });
    expect(level.record.body).toBe('user:\n | an earlier excerpt\n');
  });
});

/** Codex's spike-E subagent session: the root thread spawned one child thread, both under a scripted model. */
const CODEX_ROOT = '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72';
const CODEX_CHILD = '01a12947-16a2-7152-be00-4e4b1e12a4d8';
const CODEX_TX = 'codex/transcripts/subagent';

/** A Codex MCP call from `thread` of the root session, as call `callId` (Codex runs no grimoire hook: `_meta` only). */
function codexCall(base: CallContext, thread: string, callId: string, session = CODEX_ROOT): CallContext {
  return {
    ...base,
    client: { name: 'codex-mcp-client', version: '0.162.1' },
    evidence: {},
    mcp: { era: 'legacy', hint: null, meta: { sessionId: session, threadId: thread, callId } },
    nonce: 'nonce-codex',
  };
}

/** A Codex home whose `sessions/2026/10/11/` holds the named rollouts of a fixture folder. */
async function codexHomeWith(folder: string, ...rollouts: string[]): Promise<{ home: string; day: string }> {
  const home = await makeTempDir('grimoire-codex-home-');
  const day = path.join(home, 'sessions', '2026', '10', '11');
  await mkdir(day, { recursive: true });
  for (const name of rollouts) await cp(fixturePath(`${folder}/${name}`), path.join(day, name));
  return { home, day };
}

describe('Codex', () => {
  test('each thread that passed the handle is cut from its own rollout, found by thread id in the Codex home a hook revealed', async ({
    world,
    grimoire,
    capture,
  }) => {
    // The rollouts live in a Codex home only a hook's transcript_path names: the default home is elsewhere.
    const codexHome = await makeTempDir('grimoire-codex-home-');
    const day = path.join(codexHome, 'sessions', '2026', '10', '11');
    await mkdir(day, { recursive: true });
    const rootFile = `rollout-2026-10-11T07-44-45-${CODEX_ROOT}.jsonl`;
    await cp(fixturePath(`${CODEX_TX}/${rootFile}`), path.join(day, rootFile));
    await cp(fixturePath(`${CODEX_TX}/rollout-2026-10-11T07-44-47-${CODEX_CHILD}.jsonl`), path.join(day, `rollout-2026-10-11T07-44-47-${CODEX_CHILD}.jsonl`));
    try {
      const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
      await recordRevealedRoot(machine, { client: 'codex', session: CODEX_ROOT, transcriptPath: path.join(day, rootFile) });
      const core = capture.makeCore();
      capture.at('2026-10-11T04:44:47.100Z');
      const id = await created(core, grimoire.ctx, 'Codex work');
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_2_0'));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T04:44:47.340Z');
      await core.call('update', { id, labels_add: ['read'], attempt }, codexCall(grimoire.ctx, CODEX_CHILD, 'call_5_0'));
      capture.at('2026-10-11T04:44:47.800Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_8_0'));

      expect(closed).toMatchObject({ ok: true });
      const records = await sessionRecords(world.a, id, attempt);
      expect(records).toHaveLength(2);
      const root = records.find((r) => r.fields.context === CODEX_ROOT)!;
      const child = records.find((r) => r.fields.context === CODEX_CHILD)!;
      expect(root.fields).toMatchObject({ client: 'codex', client_version: '0.162.1', session: CODEX_ROOT, source: 'meta', excerpt: 'cut', excerpt_notes: [] });
      expect(child.fields).toMatchObject({ session: CODEX_ROOT, source: 'meta', excerpt: 'cut', reach: { at: '2026-10-11T04:44:47.685Z', ref: expect.stringMatching(/^\d+$/) } });
      // The seam-2 goldens: the root keeps the child only as its launch, result and wait. (How much a trim cuts
      // depends on the paths the goldens rewrote: the spike's home and repo, not this test's.)
      const trims = (text: string) => text.replace(/\[… \d+ chars trimmed …\]/g, '[… trimmed …]');
      expect(trims(root.body)).toBe(trims(golden('codex/subagent-root')));
      expect(trims(child.body)).toBe(trims(golden('codex/subagent')));
    } finally {
      await removeDir(codexHome);
    }
  });
});

/** Spike C's Claude Code run: the main line ran the grimoire-chores skill, forked into a grimoire-chores subagent. */
const CHORE_SESSION = 'c2eb58d9-ccb7-4978-bc0e-35f624a5266b';
const CHORE_SUBAGENT = 'a523fef26307d8241';
/** The main line's `Skill` call, and the chores subagent's `ToolSearch`. */
const CHORE_SKILL_CALL = 'toolu_01P6XhbCSzNqUtZ7B5KhAP3x';
const CHORE_SUBAGENT_CALL = 'toolu_01UQtAtS3Z9HVgYgWDEF4TFq';

/** Spike F's Codex run: the root thread spawned the grimoire-chores role, whose thread called chore_start. */
const CHORE_ROOT = '01a12968-6f96-78e2-aef8-4da11543207e';
const CHORE_THREAD = '01a12968-71aa-7fe1-a70d-7745aa7feacd';
const CHORE_TX = 'codex/transcripts/chore-role';

describe('chore contexts', () => {
  test('a Codex chore thread that bound with the handle is excluded from excerpts and fact scans: it gets no session record', async ({
    world,
    grimoire,
    capture,
  }) => {
    const codex = await codexHomeWith(
      CHORE_TX,
      `rollout-2026-10-11T08-21-12-${CHORE_ROOT}.jsonl`,
      `rollout-2026-10-11T08-21-13-${CHORE_THREAD}.jsonl`,
    );
    try {
      const core = capture.makeCore({ capture: { codexHome: codex.home } });
      capture.at('2026-10-11T05:21:12.900Z');
      const id = await created(core, grimoire.ctx, 'Chores');
      // The root's first call stands in for its claim; the chore thread's chore_start for an update naming the handle.
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, CHORE_ROOT, 'call_1_0', CHORE_ROOT));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T05:21:13.450Z');
      expect(await core.call('update', { id, labels_add: ['chore'], attempt }, codexCall(grimoire.ctx, CHORE_THREAD, 'call_8_0', CHORE_ROOT))).toMatchObject({
        ok: true,
      });
      capture.at('2026-10-11T05:21:13.600Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, CHORE_ROOT, 'call_close', CHORE_ROOT));

      expect(closed).toMatchObject({ ok: true });
      const records = await sessionRecords(world.a, id, attempt);
      expect(records.map((r) => [r.fields.context, r.fields.excerpt])).toEqual([[CHORE_ROOT, 'cut']]);
      // Nothing of the chore thread's own steps (its apply_patch, its chore_start) is in the trace.
      expect(records[0]!.body).not.toMatch(/^tool (?:apply_patch|mcp__grimoire__chore_start)$/m);
      expect((await captureOf(world.a, attempt)).contexts.map((c) => c.context)).toEqual([CHORE_ROOT]);
    } finally {
      await removeDir(codex.home);
    }
  });
});

describe('chore subagents', () => {
  test('a Claude Code grimoire-chores subagent that bound with the handle gets no session record: its own transcript names its type', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    capture.at('2026-10-11T03:23:41.500Z');
    const id = await created(core, grimoire.ctx, 'Claude chores');
    const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, CHORE_SESSION, CHORE_SKILL_CALL));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:23:43.450Z');
    // The hint names no agent type: only the subagent's own .meta.json says it is a chores subagent.
    const fromChores = claudeCallIn(grimoire.ctx, CHORE_SESSION, CHORE_SUBAGENT_CALL, { id: CHORE_SUBAGENT });
    expect(await core.call('comment', { id, body: 'chore', attempt }, fromChores)).toMatchObject({ ok: true });
    capture.at('2026-10-11T03:23:52.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, CHORE_SESSION, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context])).toEqual([[CHORE_SESSION, 'main']]);
  });

  test('nor does a calling context its validated hint names a grimoire-chores subagent, even with no transcript to read', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const lost = 'ffffffff-0000-4000-8000-000000000000';
    const id = await created(core, grimoire.ctx, 'Chores close');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call(
      'close',
      { id, reason: 'done', attempt, debrief: DEBRIEF },
      claudeCallIn(grimoire.ctx, lost, 'toolu_chores_close', { id: 'a0000000000000001', type: 'grimoire-chores' }),
    );

    expect(closed).toMatchObject({ ok: true });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context])).toEqual([[CLAUDE_SESSION, 'main']]);
  });
});

describe('the other attempt-ending ops', () => {
  test('a human’s abandoned release binds nothing, so only the bound agent contexts are cut', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const human: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Abandoned');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');

    const released = await core.call('release', { id, attempt, abandoned: true }, human);

    expect(released).toMatchObject({ ok: true, result: { ended: 'release-abandoned', outcome: 'fail' } });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.context, r.fields.excerpt]).sort()).toEqual([
      ['aa0434c9616245e9e', 'cut'],
      ['main', 'cut'],
    ]);
  });

  test('a reassign cuts the bound agent contexts; the person reassigning is no agent context, so gets no record', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const human: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Handed over');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const reassigned = await core.call('reassign', { id, assignee: world.b.identity.email }, human);

    expect(reassigned).toMatchObject({ ok: true, result: { ended: attempt } });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.client, r.fields.context, r.fields.excerpt, r.fields.facts])).toEqual([['claude-code', 'main', 'cut', 'scanned']]);
    // The attempt it opened has no bound context yet.
    const opened = (reassigned as { ok: true; result: { attempt: string } }).result.attempt;
    expect(await sessionRecords(world.a, id, opened)).toEqual([]);
  });

  test('a reopen supersedes an attempt a fold left open: its context, bound only on the other side of the fold, gets a placeholder', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const bobCore = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Closed here, claimed there');
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const mine = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    await core.call('close', { id, reason: 'done', attempt: mine, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    const bobClaim = await bobCore.call('claim', { id }, agentContext(world.b));
    if (!bobClaim.ok) throw new Error(JSON.stringify(bobClaim.error));
    const bobs = bobClaim.result.attempt;
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const reopened = await core.call('reopen', { id, comment: 'Bob is still on it.' }, person(grimoire.ctx));

    expect(reopened).toMatchObject({ ok: true });
    // Bob's claim is only on the remote tip: this machine has no row for his context, so it isn't cut.
    const records = await sessionRecords(world.a, id, bobs);
    expect(records.map((r) => r.fields)).toEqual([
      expect.objectContaining({ client: 'claude-code', session: 'sess-1', context: 'main', excerpt: 'not_found', facts: 'not_found', roots: [], reach: null }),
    ]);
    expect((await captureOf(world.a, bobs)).facts_complete).toBe(false);
  });
});

describe('an unclaimed close', () => {
  test('cuts its own context into the instant attempt it opens and seals in one commit', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Done without a claim');
    const before = (await trackerTip(world.a))!;
    capture.at('2026-10-11T03:27:30.000Z');

    // The Agent launch stands in for the close call: the attempt opens and ends with it.
    const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, claudeCall(grimoire.ctx, MAIN_CALL));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done', outcome: 'pass' } });
    expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    const attempt = (closed as { ok: true; result: { attempt: string } }).result.attempt;
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context, r.fields.excerpt, r.fields.excerpt_notes])).toEqual([[CLAUDE_SESSION, 'main', 'cut', []]]);
    expect(records[0]!.body).toContain('tool Agent');
  });

  test('whose call never reaches the transcript in time finds no window: nothing was scanned, so its facts are partial', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Not flushed');
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_never_flushed'));

    expect(closed).toMatchObject({ ok: true });
    const attempt = (closed as { ok: true; result: { attempt: string } }).result.attempt;
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      session: CLAUDE_SESSION,
      excerpt: 'cut',
      excerpt_notes: ['tail_unflushed'],
      facts: 'partial',
      window_start: null,
      steps: 0,
      reach: null,
    });
    expect(record!.body).toBe('');
    expect((await captureOf(world.a, attempt)).facts_complete).toBe(false);
  });

  test('by a person at their terminal leaves no session record: a person is no agent context', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Done by hand');
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done' }, { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' });

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    expect(await sessionRecords(world.a, id, (closed as { ok: true; result: { attempt: string } }).result.attempt)).toEqual([]);
  });
});

describe('which contexts are cut', () => {
  test('a bound context with no seen-here row on this machine isn’t cut: the seal writes a placeholder naming no roots', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Elsewhere');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    // The subagent's row is gone (as if it had bound on another machine).
    const subagentKey = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: CLAUDE_AGENT, nonce: 'nonce-claude' });
    expect(await machine.coordination.remove('seen-here', `${attempt}/${subagentKey}`)).toBe(true);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.find((r) => r.name === `${subagentKey}.md`)!.fields).toMatchObject({
      context: CLAUDE_AGENT,
      excerpt: 'not_found',
      facts: 'not_found',
      roots: [],
      reach: null,
    });
    expect(records.find((r) => r.fields.context === 'main')!.fields).toMatchObject({ excerpt: 'cut' });
  });

  test('an attempt-ending call cancels the sweeps running in its process before it cuts', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Swept');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    // The subagent's own transcript is away until the sweep is cancelled: a cut made before that can't find it.
    const subagents = path.join(capture.configDir, 'projects', 'C--Users-user-proj', CLAUDE_SESSION);
    renameSync(subagents, `${subagents}.away`);
    let cancelled = 0;
    const done = registerSweep(() => {
      cancelled++;
      renameSync(`${subagents}.away`, subagents);
    });
    capture.at('2026-10-11T03:27:30.000Z');

    try {
      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    } finally {
      done();
      if (existsSync(`${subagents}.away`)) renameSync(`${subagents}.away`, subagents);
    }

    expect(cancelled).toBe(1);
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.find((r) => r.fields.context === CLAUDE_AGENT)!.fields).toMatchObject({ excerpt: 'cut' });
  });

  test('a context whose record a human purged is skipped: no record is written, and the trace lists it purged', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Purged');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    const subagentKey = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: CLAUDE_AGENT, nonce: 'nonce-claude' });
    await commitToTracker(world.a, { [`purges/${attempt}/${subagentKey}.md`]: '---\nby: "alice@example.com"\nat: "2026-10-11T03:27:25.000Z"\n---\n' });
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => r.fields.context)).toEqual(['main']);
    expect(records.map((r) => r.name)).not.toContain(`${subagentKey}.md`);
    const trace = await captureOf(world.a, attempt);
    expect(trace.contexts.map((c) => [c.key, c.excerpt.status, c.facts])).toEqual(
      expect.arrayContaining([[subagentKey, 'purged', 'purged']]),
    );
    expect(trace.contexts).toHaveLength(2);
    expect(trace.facts_complete).toBe(false);
  });
});

/** Claude Code's spike-A plain session: one turn, whose one write on the issue is `mcp__grimoire__comment` (call PLAIN_COMMENT). */
const PLAIN_SESSION = '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5';
const PLAIN_COMMENT = 'toolu_01FGkSuaFCkBXSzKt8JWTnv7';

/** A person at their own terminal: no transcript, no debrief needed. */
function person(base: CallContext): CallContext {
  return { ...base, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
}

/** A Claude Code MCP call from the plain session's main line carrying only the given evidence. */
function plainCall(base: CallContext, mcp: CallContext['mcp'], evidence: CallContext['evidence'] = {}): CallContext {
  return { ...base, client: { name: 'claude-code', version: '2.1.296' }, evidence, ...(mcp ? { mcp } : {}), nonce: 'nonce-plain' };
}

/**
 * A person claims; a Claude Code context comments naming the handle at the
 * time the plain session made its comment call, carrying `ctx`'s evidence;
 * the person closes. Returns the comment context's session record.
 */
async function commentedFrom(
  capture: { makeCore: (extra?: CoreOptions) => Core; at: (iso: string) => void },
  base: CallContext,
  checkout: Checkout,
  ctx: CallContext,
  times = { claim: '2026-10-11T03:30:00.000Z', comment: '2026-10-11T03:30:40.051Z', close: '2026-10-11T03:30:45.000Z' },
): Promise<StoredRecord | undefined> {
  const core = capture.makeCore();
  capture.at(times.claim);
  const id = await created(core, base, 'Commented');
  const claim = await core.call('claim', { id }, person(base));
  if (!claim.ok) throw new Error(JSON.stringify(claim.error));
  const { attempt } = claim.result;
  capture.at(times.comment);
  expect(await core.call('comment', { id, body: 'done', attempt }, ctx)).toMatchObject({ ok: true });
  capture.at(times.close);
  expect(await core.call('close', { id, reason: 'done', attempt }, person(base))).toMatchObject({ ok: true });
  return (await sessionRecords(checkout, id, attempt)).find((r) => r.fields.client === 'claude-code');
}

describe('identity checked against the transcript at cut time', () => {
  test('a hint that came with no _meta counts once its session’s transcript holds its tool-use id', async ({ world, grimoire, capture }) => {
    const hint = { session_id: PLAIN_SESSION, tool_use_id: PLAIN_COMMENT };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'legacy', hint, meta: null }));

    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'hint', excerpt: 'cut' });
    expect(record!.body).toContain('tool mcp__grimoire__comment');
  });

  test('a context’s paths are rewritten against the worktree its row says it worked in, not the closing call’s', async ({ world, grimoire, capture }) => {
    // The plain session ran in spike A's probe repo: a linked worktree of the repo, as far as this test goes.
    const probe = 'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-spike-a\\proj';
    const core = capture.makeCore();
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    capture.at('2026-10-11T03:30:00.000Z');
    const id = await created(core, grimoire.ctx, 'Another worktree');
    const claim = await core.call('claim', { id }, person(grimoire.ctx));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:30:40.051Z');
    const hint = { session_id: PLAIN_SESSION, tool_use_id: PLAIN_COMMENT };
    const commenting = plainCall(grimoire.ctx, { era: 'modern', hint, meta: { 'claudecode/toolUseId': PLAIN_COMMENT } });
    expect(await core.call('comment', { id, body: 'done', attempt }, commenting)).toMatchObject({ ok: true });
    const key = sessionKey({ client: 'claude-code', session: PLAIN_SESSION, context: 'main', nonce: 'nonce-plain' });
    await machine.coordination.update<SeenHereRow>('seen-here', `${attempt}/${key}`, (row) => (row ? { ...row, worktree: probe } : undefined));
    capture.at('2026-10-11T03:30:45.000Z');

    expect(await core.call('close', { id, reason: 'done', attempt }, person(grimoire.ctx))).toMatchObject({ ok: true });

    const record = (await sessionRecords(world.a, id, attempt)).find((r) => r.fields.client === 'claude-code')!;
    expect(record.fields).toMatchObject({ session: PLAIN_SESSION, excerpt: 'cut' });
    expect(record.body).toContain(' | file_path: <repo>\\README.md');
    expect(record.body).not.toContain(probe);
  });

  test('a pending hint whose tool-use id its transcript doesn’t hold claims nothing', async ({ world, grimoire, capture }) => {
    const forged = { session_id: PLAIN_SESSION, tool_use_id: 'toolu_never_made' };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'legacy', hint: forged, meta: null }));

    expect(record!.fields).toMatchObject({ session: null, source: null, excerpt: 'not_found' });
  });

  test('a _meta tool-use id alone is joined to the transcript that holds it', async ({ world, grimoire, capture }) => {
    const meta = { 'claudecode/toolUseId': PLAIN_COMMENT };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'modern', hint: null, meta }));

    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'tool-use-id', excerpt: 'cut' });
  });

  test('the spawn-env session is trusted only if its transcript holds the call', async ({ world, grimoire, capture }) => {
    const trusted = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, undefined, { spawnEnvId: PLAIN_SESSION }));
    // The subagent session's main line made no comment call around then, inside its flushed range.
    const wrong = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, undefined, { spawnEnvId: CLAUDE_SESSION }), {
      claim: '2026-10-11T03:27:00.000Z',
      comment: '2026-10-11T03:27:19.000Z',
      close: '2026-10-11T03:27:30.000Z',
    });

    expect(trusted!.fields).toMatchObject({ session: PLAIN_SESSION, source: 'spawn-env', excerpt: 'cut' });
    expect(wrong!.fields).toMatchObject({ session: CLAUDE_SESSION, source: 'spawn-env', excerpt: 'unmatched', facts: 'unmatched', reach: null });
  });
});

describe('modes that open no transcript, or commit no text', () => {
  test('in none mode no transcript is opened: facts-only records, reaching the context’s latest skill_read event plus the event count', async ({
    world,
    grimoire,
    capture,
  }) => {
    await setExcerptMode(world.a, 'none');
    // No transcript anywhere: a cut that looked would say not_found.
    const core = capture.makeCore({ capture: { claudeConfigDir: path.join(capture.configDir, 'nothing-here') } });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'No transcripts');
    const attempt = await claimed(core, grimoire.ctx, id);
    // Two skill_read events of the claiming context (the shape skill_read appends), and one of another session.
    const actor = { kind: 'agent', client: 'claude-code', session: CLAUDE_SESSION, context: 'main', call: 'toolu_read', nonce: 'nonce-claude' };
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:18.000Z', actor, nonce: 'nonce-claude' });
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:21.000Z', actor, nonce: 'nonce-claude' });
    await machine.records.append('skill-reads', {
      skill: 'other',
      version: 'b'.repeat(64),
      at: '2026-10-11T03:27:25.000Z',
      actor: { ...actor, session: 'someone-else' },
      nonce: 'nonce-other',
    });
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      session: CLAUDE_SESSION,
      context: 'main',
      excerpt: 'off',
      excerpt_notes: [],
      facts: 'events_only',
      reader_version: null,
      window_start: null,
      reach: { at: '2026-10-11T03:27:21.000Z', ref: '2' },
    });
    expect(record!.body).toBe('');
  });

  test('this machine’s capture.excerpts_max lowers the store’s mode for its own cuts: status off, noted capped', async ({ world, grimoire, capture }) => {
    await putMachineSetting(path.join(world.a.dir, '.git'), 'capture.excerpts_max', 'facts');
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Capped');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({ excerpt: 'off', excerpt_notes: ['tail_unflushed', 'capped'], facts: 'scanned', characters: 0 });
    expect(record!.body).toBe('');
  });
});

/**
 * Appends `rest` to `file` `delayMs` after the next attempt-ending call
 * starts its cut (it cancels this process's sweeps first): a cut that starts
 * promptly reads the file short, so only its flush wait can see the rest.
 */
function flushOnceCutStarts(file: string, rest: string, delayMs: number): { stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const unregister = registerSweep(() => {
    timer = setTimeout(() => void appendFile(file, rest), delayMs);
  });
  return {
    stop: () => {
      unregister();
      clearTimeout(timer);
    },
  };
}

/** How long after its cut starts the ending call's line lands: well inside the 2 s flush wait, well after a prompt first cut. */
const FLUSH_DELAY_MS = 1_000;

/** A config dir holding only the plain session, flushed up to its comment call (each line edited by `edit`): returns the rest. */
async function plainFlushedToComment(edit: (line: string) => string = (line) => line): Promise<{ configDir: string; file: string; rest: string }> {
  const configDir = await claudeConfigDir({ folder: 'claude-code/transcripts/plain', session: PLAIN_SESSION });
  const file = path.join(configDir, 'projects', 'C--Users-user-proj', `${PLAIN_SESSION}.jsonl`);
  const lines = readFileSync(file, 'utf8').split('\n').map(edit);
  const call = lines.findIndex((line) => line.includes(PLAIN_COMMENT) && line.includes('"tool_use"'));
  expect(call).toBeGreaterThan(0);
  await writeFile(file, `${lines.slice(0, call).join('\n')}\n`);
  return { configDir, file, rest: lines.slice(call).join('\n') };
}

describe('the calling context', () => {
  test('waits for its ending call to reach its transcript, then cuts it whole', async ({ world, grimoire, capture }) => {
    const codexHome = await makeTempDir('grimoire-codex-home-');
    const day = path.join(codexHome, 'sessions', '2026', '10', '11');
    await mkdir(day, { recursive: true });
    const name = `rollout-2026-10-11T07-44-45-${CODEX_ROOT}.jsonl`;
    const lines = readFileSync(fixturePath(`${CODEX_TX}/${name}`), 'utf8').split('\n');
    // Codex has flushed the rollout up to the ending call (`echo`, call_8_0, line 25): the rest lands while the close waits.
    const ending = lines.findIndex((line) => line.includes('"call_id":"call_8_0"') && line.includes('"function_call"'));
    expect(ending).toBeGreaterThan(0);
    await writeFile(path.join(day, name), `${lines.slice(0, ending).join('\n')}\n`);
    const flush = flushOnceCutStarts(path.join(day, name), lines.slice(ending).join('\n'), FLUSH_DELAY_MS);
    try {
      const core = capture.makeCore({ capture: { codexHome, flushWaitMs: 2_000 } });
      capture.at('2026-10-11T04:44:47.100Z');
      const id = await created(core, grimoire.ctx, 'Flushing');
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_2_0'));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      capture.at('2026-10-11T04:44:47.800Z');

      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', attempt: claim.result.attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_8_0'));
      const took = Date.now() - started;

      expect(closed).toMatchObject({ ok: true });
      // It waited for the line to land.
      expect(took).toBeGreaterThanOrEqual(FLUSH_DELAY_MS);
      const [record] = await sessionRecords(world.a, id, claim.result.attempt);
      expect(record!.fields).toMatchObject({ context: CODEX_ROOT, excerpt: 'cut', excerpt_notes: [] });
      expect(record!.body).toContain('text: root closes gr-7k2pq');
    } finally {
      flush.stop();
      await removeDir(codexHome);
    }
  });

  /** An unclaimed close at the plain session's comment call, from a context `ctx` names only as given; returns its record. */
  async function unclaimedCloseWhileFlushing(
    capture: { makeCore: (extra?: CoreOptions) => Core; at: (iso: string) => void },
    base: CallContext,
    checkout: Checkout,
    plain: { configDir: string; file: string; rest: string },
    ctx: CallContext,
  ): Promise<{ record: StoredRecord | undefined; took: number }> {
    const flush = flushOnceCutStarts(plain.file, plain.rest, FLUSH_DELAY_MS);
    try {
      const core = capture.makeCore({ capture: { claudeConfigDir: plain.configDir, flushWaitMs: 2_000 } });
      capture.at('2026-10-11T03:30:00.000Z');
      const id = await created(core, base, 'Closed unclaimed');
      // When grimoire saw the call: its PreToolUse hook ran, its result not yet written.
      capture.at('2026-10-11T03:30:40.051Z');
      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx);
      const took = Date.now() - started;
      if (!closed.ok) throw new Error(JSON.stringify(closed.error));
      const [record] = await sessionRecords(checkout, id, closed.result.attempt);
      return { record, took };
    } finally {
      flush.stop();
      await removeDir(plain.configDir);
    }
  }

  test('known only by a _meta tool-use id that is its only binding call, it waits for the call to reach a transcript, then cuts it', async ({
    world,
    grimoire,
    capture,
  }) => {
    const plain = await plainFlushedToComment();
    const ctx = plainCall(grimoire.ctx, { era: 'modern', hint: null, meta: { 'claudecode/toolUseId': PLAIN_COMMENT } });

    const { record, took } = await unclaimedCloseWhileFlushing(capture, grimoire.ctx, world.a, plain, ctx);

    expect(took).toBeGreaterThanOrEqual(FLUSH_DELAY_MS);
    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'tool-use-id', excerpt: 'cut', excerpt_notes: [], facts: 'scanned' });
    expect(record!.body).toContain('tool mcp__grimoire__comment');
  });

  test('known only by its spawn-env session, it waits for its ending call to reach that transcript before trusting it', async ({
    world,
    grimoire,
    capture,
  }) => {
    // A connection with no _meta: the close is found by its operation and time, in a copy whose comment call is a close.
    const plain = await plainFlushedToComment((line) => line.replaceAll('mcp__grimoire__comment', 'mcp__grimoire__close'));
    const ctx = plainCall(grimoire.ctx, undefined, { spawnEnvId: PLAIN_SESSION });

    const { record, took } = await unclaimedCloseWhileFlushing(capture, grimoire.ctx, world.a, plain, ctx);

    expect(took).toBeGreaterThanOrEqual(FLUSH_DELAY_MS);
    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'spawn-env', excerpt: 'cut', excerpt_notes: [], facts: 'scanned' });
    expect(record!.body).toContain('tool mcp__grimoire__close');
  });
});
