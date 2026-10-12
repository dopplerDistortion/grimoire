// Sweeps (spec §14 Sweeps, Pending session records, Roots; §13 Upkeep): an
// upkeep part that cuts the bound contexts of open attempts that went idle
// (30 min) or whose transcript was archived, and attaches their pending
// session records to the still-open attempt in one commit that binds nothing.
// A later cut replaces a record only on strictly further, successful reach.
// Seam 1: the part runs through the upkeep scheduler against real git; real
// Claude Code transcripts from the seam-2 fixtures stand in for the clients'.
import path from 'node:path';
import { utimes } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { recordRevealedRoot } from '../../src/capture/transcript-roots';
import { seenHereRows, type SeenHereRow } from '../../src/capture/seen-here';
import { sweepOrder } from '../../src/core/sweep';
import { putMachineSetting } from '../../src/core/settings';
import { MachineLocalStore } from '../../src/machine-local';
import { runUpkeep, type PartRun } from '../../src/upkeep';
import { excerptSweep, type SweepOptions } from '../../src/upkeep/sweep';
import { agentContext, fetchTracker, pushTracker, trackerTip, TRACKER_REF } from './support';
import {
  CLAUDE_AGENT,
  CLAUDE_SESSION,
  DEBRIEF,
  SUBAGENT_CALL,
  claimed,
  claudeCall,
  created,
  sessionRecords,
  test,
} from './capture-support';

/** Runs one upkeep pass of the sweep alone, as `grimoire mcp` would at its start; returns the sweep's run. */
async function sweepNow(root: string, options: SweepOptions): Promise<PartRun> {
  const report = await runUpkeep({ root, parts: [excerptSweep(options)], force: true });
  const run = report.runs.find((r) => r.part === 'excerpt-sweep')!;
  expect(run.status, JSON.stringify(run)).toBe('ran');
  return run;
}

/** Half an hour and a bit after the fixture sessions' last steps (2026-10-11T03:27:22Z). */
const IDLE = new Date('2026-10-11T04:00:00.000Z');

describe('a sweep', () => {
  test('cuts an idle bound context and attaches its pending record to the open attempt, in one commit that binds nothing; its row notes the reach', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Swept while open');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    expect(await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT))).toMatchObject({ ok: true });
    const before = (await trackerTip(world.a))!;

    const run = await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });

    expect(run.result).toMatchObject({ attached: 2 });
    expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    const message = await world.a.git(['log', '-1', '--format=%B', TRACKER_REF]);
    expect(message).toContain('Grimoire-Op: capture');
    expect(message).not.toContain('Grimoire-Attempt');
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => r.fields.context).sort()).toEqual([CLAUDE_AGENT, 'main'].sort());
    const subagent = records.find((r) => r.fields.context === CLAUDE_AGENT)!;
    expect(subagent.fields).toMatchObject({ session: CLAUDE_SESSION, excerpt: 'cut', facts: 'scanned', cut_at: IDLE.toISOString(), reach: { at: '2026-10-11T03:27:22.005Z' } });
    expect(subagent.body).toContain('tool mcp__grimoire__show');
    // The attempt is still open: end.md isn't written.
    expect((await world.a.git(['ls-tree', '-r', '--name-only', TRACKER_REF])).split('\n').some((f) => f.includes(attempt) && f.endsWith('end.md'))).toBe(false);
    const rows = await seenHereRows(new MachineLocalStore(path.join(world.a.dir, '.git')), { handle: attempt });
    expect(rows.map((row) => row.reach?.at).sort()).toEqual([expect.any(String), '2026-10-11T03:27:22.005Z'].sort());
  });

  test('attaches nothing when nothing reached further since the last sweep', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Swept twice');
    await claimed(core, grimoire.ctx, id);
    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    const tip = await trackerTip(world.a);

    const again = await sweepNow(world.a.dir, { capture: capture.options, clock: () => new Date(IDLE.getTime() + 60_000) });

    expect(again.result).toMatchObject({ attached: 0 });
    expect(await trackerTip(world.a)).toBe(tip);
  });

  test('doesn’t read again a transcript unchanged since its last cut; once it changes, the context is cut again', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Unchanged since');
    const attempt = await claimed(core, grimoire.ctx, id);
    const first = await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    expect(first.result).toMatchObject({ attached: 1, cut: 1 });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const transcript = path.join(capture.configDir, 'projects', 'C--Users-user-proj', `${CLAUDE_SESSION}.jsonl`);
    const [row] = await seenHereRows(machine, { handle: attempt });
    expect(row!.swept).toMatchObject({ at: IDLE.toISOString(), stamp: { file: transcript } });

    const again = await sweepNow(world.a.dir, { capture: capture.options, clock: () => new Date(IDLE.getTime() + 60_000) });
    expect(again.result).toMatchObject({ attached: 0, cut: 0, unchanged: 1 });

    const later = new Date(IDLE.getTime() + 120_000);
    await utimes(transcript, later, later);
    const changed = await sweepNow(world.a.dir, { capture: capture.options, clock: () => later });
    expect(changed.result).toMatchObject({ attached: 0, cut: 1, unchanged: 1 });
  });

  test('notes when it cut each row, a failed cut too, but not one the budget overtook: the next sweep cuts the longest uncut first', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Nowhere to be found');
    const attempt = await claimed(core, grimoire.ctx, id);
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const elsewhere = { ...capture.options, claudeConfigDir: path.join(capture.configDir, 'nothing-here') };

    await sweepNow(world.a.dir, { capture: elsewhere, clock: () => IDLE, budgetMs: 0 });
    expect((await seenHereRows(machine, { handle: attempt }))[0]).toMatchObject({ swept: null });
    const missed = await sweepNow(world.a.dir, { capture: elsewhere, clock: () => IDLE });

    expect(missed.result).toMatchObject({ attached: 0, cut: 1 });
    expect((await seenHereRows(machine, { handle: attempt }))[0]).toMatchObject({ reach: null, swept: { at: IDLE.toISOString(), stamp: null } });
  });

  test('leaves a context that was active in the last 30 min for a later sweep', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Still working');
    const attempt = await claimed(core, grimoire.ctx, id);
    const tip = await trackerTip(world.a);

    const early = await sweepNow(world.a.dir, { capture: capture.options, clock: () => new Date('2026-10-11T03:40:00.000Z') });

    expect(early.result).toMatchObject({ attached: 0 });
    expect(await trackerTip(world.a)).toBe(tip);
    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    expect(await sessionRecords(world.a, id, attempt)).toHaveLength(1);
  });

  test('a cut that runs out of budget attaches nothing and keeps the row for the next sweep', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Out of time');
    const attempt = await claimed(core, grimoire.ctx, id);
    const tip = await trackerTip(world.a);

    const run = await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE, budgetMs: 0 });

    expect(run.result).toMatchObject({ attached: 0, budget: 1 });
    expect(await trackerTip(world.a)).toBe(tip);
    const [row] = await seenHereRows(new MachineLocalStore(path.join(world.a.dir, '.git')), { handle: attempt });
    expect(row).toMatchObject({ handle: attempt, reach: null });
  });

  test('never writes into a sealed attempt, and prunes the seen-here rows of sealed attempts', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Closed already');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    expect(await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    expect(await seenHereRows(machine, { handle: attempt })).toHaveLength(1);
    const tip = await trackerTip(world.a);

    const run = await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });

    expect(run.result).toMatchObject({ attached: 0, pruned: 1 });
    expect(await trackerTip(world.a)).toBe(tip);
    expect(await seenHereRows(machine, { handle: attempt })).toEqual([]);
  });

  test('a later sweep searches the roots hooks revealed: a transcript outside the default config folder is found there', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Elsewhere on disk');
    const attempt = await claimed(core, grimoire.ctx, id);
    // Some other session's hook revealed a transcript under the fixture config folder; the default folder is empty.
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const project = path.join(capture.configDir, 'projects', 'C--Users-user-proj');
    await recordRevealedRoot(machine, { client: 'claude-code', session: 'another-session', transcriptPath: path.join(project, 'another-session.jsonl') });

    await sweepNow(world.a.dir, { capture: { ...capture.options, claudeConfigDir: path.join(capture.configDir, 'nothing-here') }, clock: () => IDLE });

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({ session: CLAUDE_SESSION, excerpt: 'cut' });
  });

  test('this machine’s cap lowers only its own sessions: the other clone’s sweep still commits text', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    await putMachineSetting(path.join(world.a.dir, '.git'), 'capture.excerpts_max', 'facts');
    const onA = await created(core, grimoire.ctx, 'Capped on a');
    const attemptA = await claimed(core, grimoire.ctx, onA);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const ctxB = agentContext(world.b);
    const onB = await created(core, ctxB, 'Not capped on b');
    const attemptB = await claimed(core, ctxB, onB);

    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    await sweepNow(world.b.dir, { capture: capture.options, clock: () => IDLE });

    const [capped] = await sessionRecords(world.a, onA, attemptA);
    expect(capped!.fields).toMatchObject({ excerpt: 'off', excerpt_notes: expect.arrayContaining(['capped']), facts: 'scanned', characters: 0 });
    expect(capped!.body).toBe('');
    const [full] = await sessionRecords(world.b, onB, attemptB);
    expect(full!.fields).toMatchObject({ excerpt: 'cut' });
    expect(full!.body).not.toBe('');
  });

  test('an attempt-ending call in the same process cancels a running sweep, which then commits nothing; the call isn’t held up', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Cancelled');
    const attempt = await claimed(core, grimoire.ctx, id);
    const other = await created(core, grimoire.ctx, 'Ended meanwhile');
    const otherAttempt = await claimed(core, grimoire.ctx, other);
    capture.at('2026-10-11T03:27:30.000Z');
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cutOnce = new Promise<void>((resolve) => (reached = resolve));
    // The sweep pauses after its first cut, until the ending call is done.
    const afterCut = () => {
      reached();
      return gate;
    };
    const sweeping = runUpkeep({ root: world.a.dir, parts: [excerptSweep({ capture: capture.options, clock: () => IDLE, afterCut })], force: true });
    await cutOnce;

    const closed = await core.call('close', { id: other, reason: 'done', attempt: otherAttempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    const tip = await trackerTip(world.a);
    release();
    const report = await sweeping;

    expect(closed).toMatchObject({ ok: true });
    expect(report.runs.find((r) => r.part === 'excerpt-sweep')).toMatchObject({ status: 'ran', result: { cancelled: true, attached: 0 } });
    expect(await trackerTip(world.a)).toBe(tip);
    expect(await sessionRecords(world.a, id, attempt)).toEqual([]);
  });
});

describe('the sweep order', () => {
  const row = (handle: string, at: string, swept: string | null): SeenHereRow => ({
    handle,
    issue: 'gr-1',
    client: 'claude-code',
    session: handle,
    context: 'main',
    call: null,
    spawn_env: null,
    nonce: 'n',
    source: null,
    pending_hint: null,
    worktree: '/w',
    at,
    last_at: at,
    path: null,
    reach: null,
    swept: swept === null ? null : { at: swept, stamp: null },
  });

  it('cuts the rows never swept first, by their first binding, then the rest by when a sweep last cut them', () => {
    const rows = [
      row('a', '2026-10-11T01:00:00.000Z', '2026-10-11T03:00:00.000Z'),
      row('b', '2026-10-11T02:00:00.000Z', null),
      row('c', '2026-10-11T00:00:00.000Z', '2026-10-11T02:30:00.000Z'),
      row('d', '2026-10-11T01:30:00.000Z', null),
    ];

    expect(sweepOrder(rows).map((r) => r.handle)).toEqual(['d', 'b', 'c', 'a']);
  });
});
