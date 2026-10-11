// Stale claims (spec §19): an open attempt whose last activity is older than
// the machine's `dashboard.stale_after` (default 24h). Display-only: attempts
// never time out.
import { MachineLocalStore } from '../machine-local';

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** A duration setting in ms: a number of ms, or text like `24h`, `90m`, `2d`. Null when it is neither. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(value);
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2]!.toLowerCase()]!;
  return ms > 0 ? ms : null;
}

/**
 * The instant (epoch ms) before which an open attempt's last activity makes it
 * stale on this machine. Reading the setting is a records read, so a machine
 * marker outside this release's range gives UPGRADE_REQUIRED.
 */
export async function staleCutoff(commonDir: string, now: Date): Promise<number> {
  const setting = await new MachineLocalStore(commonDir).records.read('machine-settings', 'dashboard.stale_after');
  return now.getTime() - (parseDuration(setting) ?? DEFAULT_STALE_AFTER_MS);
}
