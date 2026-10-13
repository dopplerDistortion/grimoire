// `start` watches for new worktrees (spec §15 Refresh scope): a linked worktree
// that appears while it runs gets its per-worktree upkeep (the generated
// output's reconcile) at once, not at the next 30-minute pass. Seam 1, real
// worktrees; the watcher's poll is driven by hand.
import { realpath } from 'node:fs/promises';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { findGitDirs } from '../../src/machine-local';
import { startUpkeep, watchNewWorktrees, type UpkeepPart } from '../../src/upkeep';
import { pin } from './support';

/** A per-worktree part that notes each worktree it ran on. */
function notingPart(ran: string[]): UpkeepPart {
  return { name: 'noting', scope: 'worktree', run: async ({ worktree }) => (ran.push(worktree!), {}) };
}

describe('start watches for new worktrees', () => {
  gitTest('a linked worktree that appears gets its per-worktree upkeep once it pins; the ones there before get none', async ({ world }) => {
    await pin(world.a.dir);
    const ran: string[] = [];
    const loop = startUpkeep({ root: world.a.dir, parts: [notingPart(ran)], everyMs: 3_600_000 });
    const { commonDir } = (await findGitDirs(world.a.dir))!;
    const watcher = watchNewWorktrees({ commonDir, loop, everyMs: 3_600_000 });
    try {
      // The launch pass covers the main checkout; the watcher's first look is its baseline.
      await loop.trigger();
      await watcher.poll();
      ran.length = 0;

      // Seen mid-checkout, before its config.yml: nothing yet, and it is looked at again.
      const added = await world.a.addWorktree('feature');
      expect(await watcher.poll()).toEqual([]);
      await pin(added.dir);
      const fresh = await watcher.poll();
      await loop.trigger();

      const linked = await realpath(added.dir);
      expect(fresh).toEqual([linked]);
      expect(ran).toEqual([linked]);
      // Once seen, it is no longer new.
      expect(await watcher.poll()).toEqual([]);
    } finally {
      watcher.stop();
      await loop.stop();
    }
  });
});
