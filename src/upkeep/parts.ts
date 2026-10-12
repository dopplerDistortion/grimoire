// The upkeep parts this release ships (spec §13): content pointer-file
// refresh and skill reconcile (per worktree), copy pruning, pending syncs and
// generated-output removal from pin-less worktrees, and excerpt sweeps (clone-wide).
import { actorOf } from '../core/context';
import { readCheckoutConfig } from '../core/host';
import { autoSync, syncPending, syncRequestOf } from '../core/sync';
import { GrimoireError } from '../errors';
import { openTracker } from '../tracker';
import { pruneCopies } from '../installer/copies';
import { refreshContentPointers } from '../installer/refresh';
import { registeredWorktrees } from '../installer/worktrees';
import { ledgerMayExist, mayHoldGeneratedOutput, readServedSet, reconcileNotices, reconcileResult, reconcileWorktree, type ServedSet } from '../generated';
import type { Json } from '../machine-local';
import { operationInProgress, UPKEEP_STAMPS, worktreeLeaseName } from './checkout';
import { noteRefreshed, refreshNotice } from './refreshed';
import type { PartInput, PartOutcome, UpkeepPart } from './run';
import { excerptSweep } from './sweep';

/** Content pointer files that drifted from the pinned release's shipped text are rewritten, and reported to commit. */
export const pointerRefresh: UpkeepPart = {
  name: 'pointer-refresh',
  scope: 'worktree',
  async run({ store, worktree, own }) {
    const root = worktree!;
    const { refreshed, skipped } = await refreshContentPointers(root);
    const where = own ? null : root;
    const result: { [key: string]: Json } = { refreshed, skipped: skipped.map((entry) => ({ path: entry.path, why: entry.why })) };
    // Files already rewritten are reported whatever happens to the record of them.
    await noteRefreshed(store, root, refreshed).catch((error: unknown) => {
      result.record = error instanceof Error ? error.message : String(error);
    });
    return {
      result,
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The served set, read once per pass from the tracker (after this pass's sync folded what it fetched). */
function servedOf(input: PartInput): Promise<ServedSet> {
  return input.once('served-set', () => readServedSet(input.root));
}

/**
 * Skill reconcile and stub refresh (spec §15 Reconcile): the worktree's copies
 * and stubs rewritten byte-exact from the served set, or removed. A tracker
 * that can't be read leaves everything as it is until a later pass.
 */
export const skillReconcile: UpkeepPart = {
  name: 'skill-reconcile',
  scope: 'worktree',
  async run(input): Promise<PartOutcome> {
    // No ledger anywhere and nothing generated here: nothing to write or remove.
    const ledger = await input.once('ledger', () => ledgerMayExist(input.root, input.store.commonDir));
    if (!ledger && !(await mayHoldGeneratedOutput(input.worktree!))) return { result: { served: 'none' } };
    let served: ServedSet;
    try {
      served = await servedOf(input);
    } catch (error) {
      // Not a skip: that would leave the worktree's other parts unthrottled while the tracker stays unreadable.
      return { result: { unread: messageOf(error) } };
    }
    const report = await reconcileWorktree(input.store, input.worktree!, served);
    return { result: reconcileResult(report), notices: reconcileNotices(report, input.own ? null : input.worktree) };
  },
};

/**
 * Generated output exists only where a pin is (spec §15): copies and stubs go
 * from every registered worktree that pins no release, under that worktree's
 * lease, never mid-merge or rebase, and only after their stray edits are set
 * aside. The per-worktree scheduler skips such worktrees, so this clone-wide
 * part walks them itself; any pin's upkeep runs it.
 */
export const generatedRemoval: UpkeepPart = {
  name: 'generated-removal',
  scope: 'clone',
  async run(input) {
    const { store } = input;
    const results: { [key: string]: Json }[] = [];
    const notices: string[] = [];
    const pinless = async (worktree: string) => {
      const config = await readCheckoutConfig(worktree).catch(() => undefined);
      // A config.yml that can't be read pins something: leave it.
      return config === null || (config !== undefined && config.pin === null);
    };
    const { worktrees } = await registeredWorktrees(store.commonDir);
    for (const worktree of worktrees) {
      if (!(await pinless(worktree)) || !(await mayHoldGeneratedOutput(worktree))) continue;
      const operation = await operationInProgress(worktree);
      if (operation) {
        results.push({ worktree, skipped: operation });
        continue;
      }
      const lease = await store.leases.acquire(await worktreeLeaseName(worktree), { ttlMs: 10 * 60_000 }).catch(() => null);
      if (lease?.status !== 'acquired') {
        results.push({ worktree, skipped: 'held' });
        continue;
      }
      try {
        // Checked again under the lease: a switch may have brought a pin back.
        if (!(await pinless(worktree)) || (await operationInProgress(worktree))) continue;
        let served: ServedSet;
        try {
          served = await servedOf(input);
        } catch (error) {
          // Without the ledger a changed copy can't be told from grimoire's text: nothing goes.
          results.push({ worktree, skipped: `tracker: ${messageOf(error)}` });
          continue;
        }
        const report = await reconcileWorktree(store, worktree, served, 'remove');
        results.push({ worktree, ...reconcileResult(report) });
        notices.push(...reconcileNotices(report, worktree));
        // Once a pin comes back (a switch back, a merge), its next pass reconciles at once, unthrottled.
        if (report.removed.length > 0) await store.coordination.remove(UPKEEP_STAMPS, await worktreeLeaseName(worktree)).catch(() => {});
      } catch (error) {
        results.push({ worktree, error: messageOf(error) });
      } finally {
        await lease.lease.release().catch(() => {});
      }
    }
    return { result: { worktrees: results }, notices };
  },
};

/** Every part this release ships, in the order a pass runs them. */
export const UPKEEP_PARTS: readonly UpkeepPart[] = [pendingSync, excerptSweep(), pruneCopiesPart, generatedRemoval, pointerRefresh, skillReconcile];
