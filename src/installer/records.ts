// The machine-local records the runtime reads (spec §6): join records, which
// the launcher checks before it runs a copy, and upgrade-in-progress records,
// which keep a copy from being pruned. Both shapes are frozen by the cross-pin
// contract (join-record schema; coordination class) and only gain fields.
import type { MachineLocalStore } from '../machine-local';

/** Records kind: one join record per pin, keyed by the pin. The launcher reads `records/join/<pin>.json`. */
export const JOIN_RECORDS = 'join';

export interface JoinRecord {
  /** The excerpt mode the join's disclosure showed. */
  readonly excerpt_mode: string;
  /** The Codex hook-group hash last announced on this machine, or null. */
  readonly codex_hook_hash: string | null;
  /** Epoch ms. */
  readonly joined_at: number;
}

/** Records that this clone joined `pin`. */
export async function writeJoinRecord(store: MachineLocalStore, pin: string, record: JoinRecord): Promise<void> {
  await store.records.write<JoinRecord>(JOIN_RECORDS, pin, record);
}

/** This clone's join record for `pin`, or undefined when it hasn't joined that pin. */
export function readJoinRecord(store: MachineLocalStore, pin: string): Promise<JoinRecord | undefined> {
  return store.records.read<JoinRecord>(JOIN_RECORDS, pin);
}

/** Coordination kind: one upgrade-in-progress record per worktree, keyed by its path (spec §21 step 2). */
export const UPGRADE_RECORDS = 'upgrade-in-progress';

export interface UpgradeRecord {
  readonly worktree: string;
  /** The pin being left. */
  readonly from: string;
  /** The pin being moved to. */
  readonly to: string;
  /** Epoch ms. */
  readonly started_at: number;
  /** Which run wrote it (random): a run only ever undoes or clears its own record (additive; other pins ignore it). */
  readonly token?: string;
}
