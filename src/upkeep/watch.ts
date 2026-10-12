// `start` watches for new worktrees (spec §15 Refresh scope): a worktree
// registered while it runs gets its per-worktree upkeep (the generated
// output's reconcile, the pointer refresh) at once, not at the next pass. A
// new worktree has no throttle stamp, so an ordinary pass runs the
// per-worktree parts for it alone. One `git worktree add` is caught mid-checkout
// now and then: a worktree counts as seen once it pins a version.
import { readCheckoutConfig } from '../core/host';
import { registeredWorktrees } from '../installer/worktrees';
import type { UpkeepLoop } from './loop';

/** How often `start` looks at the clone's worktree registry. */
export const WORKTREE_WATCH_MS = 5_000;

export interface WorktreeWatcher {
  /** Looks once: the worktrees new since the last look (each triggers a pass). The first look is the baseline. */
  poll(): Promise<string[]>;
  stop(): void;
}

export function watchNewWorktrees(options: { readonly commonDir: string; readonly loop: Pick<UpkeepLoop, 'trigger'>; readonly everyMs?: number }): WorktreeWatcher {
  let seen: Set<string> | null = null;
  let polling: Promise<string[]> | null = null;

  const look = async (): Promise<string[]> => {
    const { worktrees } = await registeredWorktrees(options.commonDir);
    const pinned: string[] = [];
    for (const worktree of worktrees) {
      if (seen?.has(worktree)) continue;
      const config = await readCheckoutConfig(worktree).catch(() => null);
      if (config?.pin) pinned.push(worktree);
    }
    if (seen === null) {
      seen = new Set(pinned);
      return [];
    }
    for (const worktree of pinned) seen.add(worktree);
    if (pinned.length > 0) void options.loop.trigger().catch(() => {});
    return pinned;
  };
  const poll = (): Promise<string[]> => {
    polling ??= look()
      .catch(() => [])
      .finally(() => (polling = null));
    return polling;
  };

  const timer = setInterval(() => void poll(), options.everyMs ?? WORKTREE_WATCH_MS);
  timer.unref();
  void poll();
  return { poll, stop: () => clearInterval(timer) };
}
