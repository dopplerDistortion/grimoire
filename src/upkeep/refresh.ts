// A served-set change's refresh (spec §15 Refresh scope, Reaching others):
// the process that sees the change (a decision, a skill edit, a delivery
// switch, a fold that changed a current version) refreshes every registered
// worktree whose pin matches its own, at once. Long-lived processes trigger
// their upkeep loop, forced; a short-lived CLI call runs this, after it
// answered: only the skill reconcile, waiting a little for a worktree whose
// lease another process holds right now.
import type { Surface } from '../core/context';
import { skillReconcile } from './parts';
import { runUpkeep, type UpkeepReport } from './run';

export interface RefreshOptions {
  /** Any checkout of the clone. */
  readonly root: string;
  readonly surface?: Surface;
  readonly nonce?: string;
  /** The version this process runs (default: this build's). */
  readonly version?: string;
  /** How long to wait for a worktree's lease (default 10 s). */
  readonly leaseWaitMs?: number;
}

/** Reconciles every registered worktree on this process's version now, whatever the throttles say. */
export function refreshGeneratedOutput(options: RefreshOptions): Promise<UpkeepReport> {
  return runUpkeep({
    root: options.root,
    parts: [skillReconcile],
    force: true,
    leaseWaitMs: options.leaseWaitMs ?? 10_000,
    ...(options.surface ? { surface: options.surface } : {}),
    ...(options.nonce ? { nonce: options.nonce } : {}),
    ...(options.version ? { version: options.version } : {}),
  });
}
