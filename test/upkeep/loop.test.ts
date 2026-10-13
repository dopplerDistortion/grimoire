// Upkeep inside a long-lived process (spec §13 Where it runs, How it runs):
// a pass at once and then on a timer, a forced pass on demand, and never a
// delayed tool call: the process serves calls while a part works. Seam 1:
// the loop and a core in one process, as `grimoire mcp` hosts them.
import { describe, expect } from 'vitest';
import { startUpkeep, type UpkeepPart, type UpkeepReport } from '../../src/upkeep';
import { coreTest } from '../core/support';

/** A clone-wide part that runs until `release()`, counting its runs. */
function gatedPart(): { part: UpkeepPart; started: Promise<void>; release: () => void; runs: () => number; finished: () => boolean } {
  let runs = 0;
  let finished = false;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const part: UpkeepPart = {
    name: 'gated',
    scope: 'clone',
    async run() {
      runs += 1;
      markStarted();
      await gate;
      finished = true;
      return {};
    },
  };
  return { part, started, release, runs: () => runs, finished: () => finished };
}

describe('the upkeep loop', () => {
  coreTest('a tool call issued while a part works is answered without waiting for it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    expect((await core.call('list', {}, ctx)).ok).toBe(true);
    const gated = gatedPart();
    const loop = startUpkeep({ root: world.a.dir, parts: [gated.part] });
    try {
      await gated.started;

      // No clock: the part can't finish until it is let go below, so a call that waited for it would never return.
      const created = await core.call('create', { title: 'made during upkeep' }, ctx);

      expect(created.ok).toBe(true);
      expect(gated.finished()).toBe(false);
    } finally {
      gated.release();
      await loop.stop();
    }
    expect(gated.runs()).toBe(1);
  });

  coreTest('runs a pass at once and on its timer, and a forced pass on demand; stop ends it', async ({ world }) => {
    let runs = 0;
    const counting: UpkeepPart = { name: 'counting', scope: 'clone', intervalMs: 0, run: async () => (runs++, {}) };
    const reports: UpkeepReport[] = [];
    const loop = startUpkeep({ root: world.a.dir, parts: [counting], everyMs: 200, onReport: (report) => reports.push(report) });
    try {
      await expect.poll(() => runs, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      const forced = await loop.trigger({ force: true });
      expect(forced.runs).toEqual([expect.objectContaining({ part: 'counting', status: 'ran' })]);
    } finally {
      await loop.stop();
    }
    const after = runs;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(runs).toBe(after);
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });
});
