// The capture doctor stats (spec §6 Records): machine-local counts of what
// capture lost on this machine, for `doctor` to show. A fold that drops a late
// session record (one cut after the attempt's end on another clone, spec §14)
// counts it here when a write commits that fold.
import { MachineLocalStore } from '../machine-local';

/** The records kind (spec §6: capture doctor stats). */
export const CAPTURE_STATS = 'capture-stats';
/** Late cuts a fold dropped: `{count, last_at, last}`. */
export const LATE_CUT_DROPS = 'late-cut-drops';

export interface LateCutDrops {
  readonly count: number;
  /** When the latest drop was counted (ISO 8601). */
  readonly last_at: string;
  /** The latest dropped records, as `<attempt>/<session-key>`, newest last (at most 20). */
  readonly last: readonly string[];
}

/** Counts `drops` (each `<attempt>/<session-key>`) in this machine's doctor stats. */
export async function countLateDrops(commonDir: string, drops: readonly string[], now: Date = new Date()): Promise<void> {
  if (drops.length === 0) return;
  await new MachineLocalStore(commonDir).records.update<LateCutDrops>(CAPTURE_STATS, LATE_CUT_DROPS, (current) => ({
    count: (current?.count ?? 0) + drops.length,
    last_at: now.toISOString(),
    last: [...(current?.last ?? []), ...drops].slice(-20),
  }));
}
