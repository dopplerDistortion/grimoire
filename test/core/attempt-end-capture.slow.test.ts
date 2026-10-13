// Seam 1, against the clock: the attempt-end cut’s hard budget, the calling
// context’s flush wait, and the endings that wait for neither. In the serial
// `slow` project (npm run test:slow); the rest is in attempt-end-capture.test.ts.
import * as childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, vi } from 'vitest';
import { fixturePath, makeTempDir, removeDir, type Checkout } from '#harness';
import { registerSweep } from '../../src/capture/sweeps';
import type { CallContext, Core, CoreOptions } from '../../src/core';
import { commitToTracker, trackerFile, trackerTip } from './support';
import { CLAUDE_AGENT, SUBAGENT_CALL, DEBRIEF, claudeConfigDir, claudeCall, type StoredRecord, attemptDir, sessionRecords, created, test, claimed, PLAIN_SESSION, PLAIN_COMMENT, person, plainCall, CODEX_ROOT, CODEX_TX, codexCall } from './capture-support';

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

/**
 * Puts a git answering `delayMs` late in place of the next `times` gits the
 * core runs whose arguments match `command`, after letting the first `skip`
 * of those run as they are. The first writes `doneFile` when it finishes, the
 * n-th `<doneFile>.<n>`: `doneFiles` lists those started. `settled` waits
 * until each has written its done file or been killed.
 */
function slowNextGit(command: RegExp, delayMs: number, doneFile: string, times = 1, skip = 0): { restore(): void; doneFiles(): string[]; settled(): Promise<void> } {
  const started: string[] = [];
  const children: childProcess.ChildProcess[] = [];
  let skipped = 0;
  vi.mocked(childProcess.spawn).mockImplementation(((name: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (name !== 'git' || started.length === times || !command.test(args.join(' '))) return realSpawn(name, args, options);
    if (skipped < skip) {
      skipped += 1;
      return realSpawn(name, args, options);
    }
    const done = started.length === 0 ? doneFile : `${doneFile}.${started.length + 1}`;
    started.push(done);
    const child = realSpawn(process.execPath, ['-e', SLOW_GIT, '--', String(delayMs), done, '::git', ...args], options);
    children.push(child);
    return child;
  }) as unknown as typeof childProcess.spawn);
  const settled = async () => {
    const over = (i: number) => existsSync(started[i]!) || children[i]!.exitCode !== null || children[i]!.signalCode !== null;
    for (let i = 0; i < started.length; i++) for (let waited = 0; !over(i) && waited < delayMs + 5_000; waited += 100) await sleep(100);
  };
  return { restore: () => vi.mocked(childProcess.spawn).mockImplementation(realSpawn), doneFiles: () => [...started], settled };
}
describe('capture problems are statuses, never errors', () => {
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
    // Room for a first cut on a loaded machine; the flush wait alone would take three times as long.
    const budgetMs = 4_000;
    const flushWaitMs = 3 * budgetMs;
    const core = capture.makeCore({ capture: { budgetMs, flushWaitMs } });
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
    expect(took).toBeLessThan(flushWaitMs);
    const records = await sessionRecords(world.a, id, attempt);
    // The calling context is cut first, and waits for its ending call only until the budget runs out.
    expect(records.find((r) => r.fields.context === 'main')!.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['tail_unflushed'], facts: 'scanned' });
    expect(records.find((r) => r.fields.context === CLAUDE_AGENT)!.fields).toMatchObject({ excerpt: 'budget', facts: 'budget', reach: null });
  });
});

describe('the hard budget, finding the bound contexts', () => {
  test('covers reading the binding trailers: a git too slow for the budget leaves each context seen here with budget', async ({ world, grimoire, capture }) => {
    // The slow git answers just inside its stall time: everything but it gets the rest.
    const budgetMs = 1_000;
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

/** How long after its cut starts the ending call's line lands: well after a prompt first cut. */
const FLUSH_DELAY_MS = 1_000;
/** The flush wait these tests give: the wait ends once the line is in, so room for a loaded machine costs nothing. */
const FLUSH_WAIT_MS = 4_000;

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
      const core = capture.makeCore({ capture: { codexHome, flushWaitMs: FLUSH_WAIT_MS } });
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
      const core = capture.makeCore({ capture: { claudeConfigDir: plain.configDir, flushWaitMs: FLUSH_WAIT_MS } });
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

/** The binding-trailer reads (`git log --grep=Grimoire-Attempt: …`) the core has spawned so far. */
const TRAILER_READ = / log .*--grep=Grimoire-Attempt: /;
function trailerReads(): number {
  return vi.mocked(childProcess.spawn).mock.calls.filter(([name, args]) => name === 'git' && TRAILER_READ.test((args as readonly string[]).join(' '))).length;
}

describe('an ending with nothing to capture', () => {
  test('a person’s close, at a bare shell, of an attempt no agent bound reads no binding trailers: a git too slow to answer never holds it up', async ({
    world,
    grimoire,
    capture,
  }) => {
    // An unmarked CLI with no terminal: a person, with no transcript anywhere. The slow git would hold the cut 8 s, inside its 10 s budget.
    const gitDelayMs = 8_000;
    const shell: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: false, nonce: 'nonce-shell' };
    const core = capture.makeCore({ capture: { flushWaitMs: 2_000 } });
    const id = await created(core, shell, 'By hand');
    const claim = await core.call('claim', { id }, shell);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    capture.at('2026-10-11T03:27:30.000Z');
    const done = path.join(world.root, 'slow-git-done');
    const reads = trailerReads();
    const slow = slowNextGit(TRAILER_READ, gitDelayMs, done);
    try {
      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', attempt: claim.result.attempt }, shell);
      const took = Date.now() - started;

      expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
      expect(trailerReads()).toBe(reads);
      expect(took).toBeLessThan(gitDelayMs);
      expect(await sessionRecords(world.a, id, claim.result.attempt)).toEqual([]);
    } finally {
      slow.restore();
      // Had the slow git run, it would still be running in the repo: let it finish before the repo goes.
      if (trailerReads() > reads) for (let waited = 0; !existsSync(done) && waited < gitDelayMs + 5_000; waited += 100) await sleep(100);
    }
  });

  test('nor does an abandoned release of another person’s attempt at a terminal, or a close in the dashboard', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const bob: CallContext = {
      ...grimoire.ctx,
      surface: 'cli',
      client: null,
      evidence: {},
      tty: false,
      person: { name: world.b.identity.name, email: world.b.identity.email },
      nonce: 'nonce-bob',
    };
    const dashboard: CallContext = { ...grimoire.ctx, surface: 'dashboard', client: null, evidence: {}, nonce: 'nonce-dashboard' };
    const stale = await created(core, bob, 'Stale claim');
    const bobs = await core.call('claim', { id: stale }, bob);
    if (!bobs.ok) throw new Error(JSON.stringify(bobs.error));
    const mine = await created(core, dashboard, 'Clicked through');
    const claim = await core.call('claim', { id: mine }, dashboard);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    capture.at('2026-10-11T03:27:30.000Z');
    const reads = trailerReads();

    const released = await core.call('release', { id: stale, attempt: bobs.result.attempt, abandoned: true }, person(grimoire.ctx));
    const closed = await core.call('close', { id: mine, reason: 'done', attempt: claim.result.attempt }, dashboard);

    expect(released).toMatchObject({ ok: true, result: { ended: 'release-abandoned' } });
    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    expect(trailerReads()).toBe(reads);
    expect(await sessionRecords(world.a, stale, bobs.result.attempt)).toEqual([]);
    expect(await sessionRecords(world.a, mine, claim.result.attempt)).toEqual([]);
  });

  test('a calling context with no evidence naming a transcript (no hint, no _meta, no spawn env, no session) waits for no flush', async ({
    world,
    grimoire,
    capture,
  }) => {
    // The flush wait would hold each close this long, inside the 10 s budget: their records are not_found either way.
    const flushWaitMs = 6_000;
    const core = capture.makeCore({ capture: { flushWaitMs } });
    const callers: [string, CallContext][] = [
      ['a Claude Code connection with no hint and no _meta', plainCall(grimoire.ctx, { era: 'modern', hint: null, meta: null })],
      ['a Codex connection with no _meta', { ...grimoire.ctx, client: { name: 'codex-mcp-client', version: '0.162.1' }, evidence: {}, mcp: { era: 'legacy', hint: null, meta: null }, nonce: 'nonce-codex' }],
      ['a marked shell naming no session', { ...grimoire.ctx, surface: 'cli', client: { name: 'claude-code' }, evidence: { agentMarkers: ['AI_AGENT'] }, tty: false, nonce: 'nonce-marked' }],
    ];
    for (const [caller, ctx] of callers) {
      const id = await created(core, grimoire.ctx, caller);
      capture.at('2026-10-11T03:27:30.000Z');

      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx);
      const took = Date.now() - started;

      expect(closed, caller).toMatchObject({ ok: true, result: { ended: 'done' } });
      expect(took, caller).toBeLessThan(flushWaitMs);
      const attempt = (closed as { ok: true; result: { attempt: string } }).result.attempt;
      expect((await sessionRecords(world.a, id, attempt)).map((r) => [r.fields.excerpt, r.fields.facts]), caller).toEqual([['not_found', 'not_found']]);
    }
  });
});

describe('a person’s ending', () => {
  test('a close or a release from an unmarked CLI, with or without a terminal, and no agent evidence waits for no flush and reads no binding trailers', async ({ world, grimoire, capture }) => {
    // The flush wait would hold each ending this long, inside the 10 s budget.
    const flushWaitMs = 6_000;
    const core = capture.makeCore({ capture: { flushWaitMs } });
    const shell: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: false, nonce: 'nonce-shell' };
    const endings: [string, CallContext, 'close' | 'release'][] = [
      ['a close at a terminal', person(grimoire.ctx), 'close'],
      ['a release at a terminal', person(grimoire.ctx), 'release'],
      ['a close from a bare shell', shell, 'close'],
      ['a release from a bare shell', shell, 'release'],
    ];
    for (const [ending, ctx, op] of endings) {
      const id = await created(core, ctx, ending);
      const claim = await core.call('claim', { id }, ctx);
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T03:27:30.000Z');
      const reads = trailerReads();

      const started = Date.now();
      const ended = op === 'close' ? await core.call('close', { id, reason: 'done', attempt }, ctx) : await core.call('release', { id, attempt }, ctx);
      const took = Date.now() - started;

      expect(ended, ending).toMatchObject({ ok: true });
      expect(took, ending).toBeLessThan(flushWaitMs);
      expect(trailerReads(), ending).toBe(reads);
      expect(await sessionRecords(world.a, id, attempt), ending).toEqual([]);
    }
  });
});

describe('a reopen superseding several attempts', () => {
  test('cuts them all within one budget: the attempts it supersedes share it', async ({ world, grimoire, capture }) => {
    // Each superseded attempt's trailer read stalls past the budget: with a budget each, the reopen would take two.
    const budgetMs = 4_000;
    // Inside the 5 s git stall time, so the slow gits answer (and write their done files) rather than being killed.
    const gitDelayMs = 4_500;
    const core = capture.makeCore({ capture: { budgetMs } });
    const id = await created(core, grimoire.ctx, 'Left open twice');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    expect(await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    // Two attempts an agent opened, left open on the closed issue as folds can leave them.
    const tip = (await trackerTip(world.a))!;
    const opened: Record<string, string> = {};
    for (const handle of ['at-a0a0a0', 'at-b1b1b1']) {
      for (const file of ['start.md', 'issue-at-start.md']) {
        opened[`${attemptDir(id, handle)}/${file}`] = await trackerFile(world.a, tip, `${attemptDir(id, attempt)}/${file}`);
      }
    }
    await commitToTracker(world.a, opened);
    const slow = slowNextGit(TRAILER_READ, gitDelayMs, path.join(world.root, 'slow-git-done'), 2);
    try {
      const started = Date.now();
      const reopened = await core.call('reopen', { id, comment: 'Not done after all.' }, person(grimoire.ctx));
      const took = Date.now() - started;

      expect(reopened).toMatchObject({ ok: true });
      expect(slow.doneFiles().length).toBeGreaterThan(0);
      // One budget plus room for the commit on a loaded machine; two budgets would be 8 s.
      expect(took).toBeLessThan(2 * budgetMs - 1_000);
    } finally {
      slow.restore();
      // The slow gits still run in the repo: let them finish before the repo goes.
      for (const done of slow.doneFiles()) for (let waited = 0; !existsSync(done) && waited < gitDelayMs + 5_000; waited += 100) await sleep(100);
    }
  });
});

/** The reflog read (`git log -g`) a context's facts scan starts with, for its observed commits. */
const REFLOG_READ = / log -g /;

describe('the hard budget, overtaking a facts scan', () => {
  test('a cut that reaches further than the one before it stands though the deadline overtook its facts scan', async ({ world, grimoire, capture }) => {
    // Until the comment call lands, no transcript holds it (not_found, nothing scanned); the cut that finds it scans
    // with a reflog read that answers only after the budget has run out.
    const budgetMs = 4_000;
    const plain = await plainFlushedToComment();
    const flush = flushOnceCutStarts(plain.file, plain.rest, FLUSH_DELAY_MS);
    const slow = slowNextGit(REFLOG_READ, 2 * budgetMs, path.join(world.root, 'slow-git-done'));
    try {
      const core = capture.makeCore({ capture: { claudeConfigDir: plain.configDir, budgetMs, flushWaitMs: 3 * budgetMs } });
      capture.at('2026-10-11T03:30:00.000Z');
      const id = await created(core, grimoire.ctx, 'Overtaken scan');
      capture.at('2026-10-11T03:30:40.051Z');
      const ctx = plainCall(grimoire.ctx, { era: 'modern', hint: null, meta: { 'claudecode/toolUseId': PLAIN_COMMENT } });

      const started = Date.now();
      const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx);
      const took = Date.now() - started;

      if (!closed.ok) throw new Error(JSON.stringify(closed.error));
      expect(slow.doneFiles()).toHaveLength(1);
      expect(took).toBeLessThan(2 * budgetMs);
      const [record] = await sessionRecords(world.a, id, closed.result.attempt);
      expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', excerpt: 'cut', excerpt_notes: [] });
      // Partial, unless git's own stall limit (the same deadline) killed the reflog read just before the scan was overtaken.
      expect(['partial', 'scanned']).toContain(record!.fields.facts);
      expect(record!.body).toContain('tool mcp__grimoire__comment');
    } finally {
      slow.restore();
      flush.stop();
      await slow.settled();
      await removeDir(plain.configDir);
    }
  });

  test('a cut that reaches no further than the one before it does not displace it when the deadline overtakes its facts scan', async ({ world, grimoire, capture }) => {
    // The ending call never lands: every cut reaches as far as the first, whose facts scan finished; the second's
    // reflog read answers only after the budget has run out.
    const budgetMs = 4_000;
    const core = capture.makeCore({ capture: { budgetMs, flushWaitMs: 3 * budgetMs } });
    const id = await created(core, grimoire.ctx, 'Overtaken again');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');
    const slow = slowNextGit(REFLOG_READ, 2 * budgetMs, path.join(world.root, 'slow-git-done'), 1, 1);
    try {
      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

      expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
      expect(slow.doneFiles()).toHaveLength(1);
      const records = await sessionRecords(world.a, id, attempt);
      expect(records.find((r) => r.fields.context === 'main')!.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['tail_unflushed'], facts: 'scanned' });
    } finally {
      slow.restore();
      await slow.settled();
    }
  });
});
