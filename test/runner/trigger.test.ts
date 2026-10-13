// The runner's trigger in `start` (spec §16 The runner, Triggers), seam 1
// against real git: while a runner is configured, due-ness is re-evaluated
// once at launch, when the tracker ref moves with a trace write, an outcome
// change or a decision (read from `Grimoire-Op` trailers), and on a timer. A
// trigger that comes while a run is going queues one more evaluation.
import { describe, expect } from 'vitest';
import type { ChoreRunReport } from '../../src/runner';
import { startRunnerTrigger, type RunnerTrigger } from '../../src/runner/trigger';
import { openTracker, type TrackerStore } from '../../src/tracker';
import { terminal } from '../core/chore-support';
import { commitToTracker, coreTest } from '../core/support';
import { ok } from './scenario';

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };

interface Harness {
  readonly tracker: TrackerStore;
  /** Why each evaluation ran, in order. */
  readonly runs: string[];
  start(options?: { configured?: () => Promise<boolean>; everyMs?: number; run?: (signal: AbortSignal) => Promise<ChoreRunReport> }): RunnerTrigger;
}

const REPORT = { runner: 'claude', runs: [], why: 'nothing due', summary: 'grimoire runner: nothing ran (nothing due)', caps: {} } as unknown as ChoreRunReport;

const test = coreTest.extend('trigger', async ({ world }, { onCleanup }) => {
  const tracker = await openTracker(world.a.dir);
  const triggers: RunnerTrigger[] = [];
  const runs: string[] = [];
  onCleanup(async () => {
    for (const trigger of triggers) await trigger.stop();
    await tracker.close();
  });
  const harness: Harness = {
    tracker,
    runs,
    start(options = {}) {
      const trigger = startRunnerTrigger({
        root: world.a.dir,
        tips: () => tracker.tips(),
        configured: options.configured ?? (async () => true),
        run: options.run ?? (async () => (runs.push('run'), REPORT)),
        checkMs: 50,
        everyMs: options.everyMs ?? 60_000,
      });
      triggers.push(trigger);
      return trigger;
    },
  };
  return harness;
});

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('the runner trigger', () => {
  test('runs once at launch, then when the ref moves with a trace write, an outcome change or a decision; never for a create or a comment', async ({ world, grimoire, trigger }) => {
    const { core, ctx } = grimoire;
    trigger.start();
    await until(() => trigger.runs.length === 1, 'the launch evaluation');

    const { id } = ok(await core.call('create', { title: 'Work' }, ctx));
    ok(await core.call('comment', { id, body: 'noted' }, ctx));
    const { attempt } = ok(await core.call('claim', { id }, ctx));
    await settle();
    const quiet = trigger.runs.length;

    ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
    await until(() => trigger.runs.length === 2, 'the trace write');
    ok(await core.call('outcome_set', { attempt, verdict: 'fail', reason: 'it broke again' }, terminal(ctx)));
    await until(() => trigger.runs.length === 3, 'the outcome change');
    await commitToTracker(world.a, { 'probe.txt': 'x' }, 'grimoire: reject\n\nGrimoire-Op: reject');
    await until(() => trigger.runs.length === 4, 'the decision');

    expect(quiet).toBe(1);
  });

  test('without a configured runner nothing runs: not at launch, not on a trace write', async ({ grimoire, trigger }) => {
    const { core, ctx } = grimoire;
    let asked = 0;
    trigger.start({ configured: async () => (asked++, false) });
    const { id } = ok(await core.call('create', { title: 'Work' }, ctx));
    const { attempt } = ok(await core.call('claim', { id }, ctx));
    ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
    await until(() => asked >= 2, 'the trace write’s evaluation');

    expect(trigger.runs).toEqual([]);
  });

  test('re-evaluates on its timer', async ({ trigger }) => {
    trigger.start({ everyMs: 100 });
    await until(() => trigger.runs.length >= 3, 'two timer evaluations after the launch one');
  });

  test('a trigger during a run queues one more evaluation, however many come', async ({ trigger }) => {
    let release: () => void = () => {};
    let calls = 0;
    const handle = trigger.start({
      run: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return REPORT;
      },
    });
    await until(() => calls === 1, 'the launch run');
    handle.poke();
    handle.poke();
    handle.poke();
    release();
    await until(() => calls === 2, 'the queued evaluation');
    await settle();

    expect(calls).toBe(2);
  });

  test('stop() aborts the run under way (so its child is killed before start closes the core) and waits for it to wind down', async ({ trigger }) => {
    let signal: AbortSignal | undefined;
    let wound = false;
    const handle = trigger.start({
      run: async (given) => {
        signal = given;
        await new Promise<void>((resolve) => given.addEventListener('abort', () => resolve(), { once: true }));
        // Winding down (the abandon through the core) takes a moment after the abort.
        await new Promise((resolve) => setTimeout(resolve, 100));
        wound = true;
        return REPORT;
      },
    });
    await until(() => signal !== undefined, 'the launch run');
    expect(signal!.aborted).toBe(false);
    await handle.stop(10_000);
    expect(signal!.aborted).toBe(true);
    expect(wound).toBe(true);
  });
});
