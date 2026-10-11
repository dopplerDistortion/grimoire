// The upkeep parts this release ships (spec §13): content pointer-file
// refresh (per worktree), copy pruning and pending syncs (clone-wide). Later
// slices add theirs: excerpt sweeps, skill reconcile and stub refresh, and
// generated-output removal from pin-less worktrees.
import { actorOf } from '../core/context';
import { autoSync, syncPending, syncRequestOf } from '../core/sync';
import { GrimoireError } from '../errors';
import { openTracker } from '../tracker';
import { pruneCopies } from '../installer/copies';
import { refreshContentPointers } from '../installer/refresh';
import type { Json } from '../machine-local';
import { noteRefreshed, refreshNotice } from './refreshed';
import type { UpkeepPart } from './run';

/** Content pointer files that drifted from the pinned release's shipped text are rewritten, and reported to commit. */
export const pointerRefresh: UpkeepPart = {
  name: 'pointer-refresh',
  scope: 'worktree',
  async run({ store, worktree, own }) {
    const root = worktree!;
    const { refreshed, skipped } = await refreshContentPointers(root);
    await noteRefreshed(store, root, refreshed);
    const where = own ? null : root;
    return {
      result: { refreshed, skipped: skipped.map((entry) => ({ path: entry.path, why: entry.why })) },
      notices: [
        ...(refreshed.length > 0 ? [refreshNotice(refreshed.length, where)] : []),
        ...skipped.map((entry) => `grimoire left ${entry.path}${where ? ` in ${where}` : ''} alone: ${entry.why}`),
      ],
    };
  },
};

/**
 * Version copies nothing needs go through `pkg/.trash/` under the pruning
 * rules (spec §11), and the copy this process runs always stays. An install
 * holding the lock leaves it to a later pass: upkeep never waits for one.
 */
export const pruneCopiesPart: UpkeepPart = {
  name: 'prune-copies',
  scope: 'clone',
  async run({ store, version }) {
    try {
      const { removed, kept } = await pruneCopies(store, { keep: [version], waitMs: 0 });
      return { result: { removed, kept: kept.map((entry) => ({ version: entry.version, why: [...entry.why] })) } };
    } catch (error) {
      if (error instanceof GrimoireError && error.code === 'BUSY') return { skipped: 'install' };
      throw error;
    }
  },
};

/**
 * A tip left sync-pending (a detached child killed by its sandbox, a failed
 * push) goes out as an automatic sync: the auto-sync setting, the backoff and
 * the sync lease govern it as they govern every other (spec §4).
 */
export const pendingSync: UpkeepPart = {
  name: 'pending-sync',
  scope: 'clone',
  async run({ store, root, context }) {
    if (!(await syncPending(store.commonDir))) return { result: { pending: false } };
    const ctx = await context();
    const tracker = await openTracker(root);
    try {
      const outcome = await autoSync(tracker, syncRequestOf(ctx, actorOf(ctx)));
      if ('skipped' in outcome) return { result: { pending: true, skipped: outcome.skipped } };
      const result: { [key: string]: Json } = { pending: outcome.state === 'pending', state: outcome.state };
      if (outcome.reason) result.reason = outcome.reason;
      if (outcome.failure) result.failure = { class: outcome.failure.class, message: outcome.failure.message };
      return { result };
    } finally {
      await tracker.close();
    }
  },
};

/** Every part this release ships, in the order a pass runs them. */
export const UPKEEP_PARTS: readonly UpkeepPart[] = [pendingSync, pruneCopiesPart, pointerRefresh];
