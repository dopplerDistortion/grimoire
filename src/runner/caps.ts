// The runner's caps (spec §16 Caps): at most 6 runs a day, and a 6 h pause
// after 2 consecutive failures, both shown in status. The counters are
// coordination data (spec §6): version-free, so the caps hold across pins.
// One iteration (a spawn plus its fix-up respawn) counts as one run; "a day"
// is the last 24 hours.
import { GrimoireError } from '../errors';
import type { MachineLocalStore } from '../machine-local';

export const RUNS_PER_DAY = 6;
export const FAILURES_BEFORE_PAUSE = 2;
const HOUR = 3_600_000;
export const PAUSE_MS = 6 * HOUR;
const DAY_MS = 24 * HOUR;

const KIND = 'runner';
const KEY = 'counters';

/** How the last run ended, as status shows it. */
export interface LastRun {
  readonly at: string;
  readonly run: string | null;
  readonly kind: string | null;
  /** `compiled`, `proposed`, `no_action`, `failed`, or `error`. */
  readonly result: string;
  /** Why a failed run failed: reason codes or a short cause, never model text. */
  readonly reason?: string;
  /** The auth method the billing guard saw before the run. */
  readonly auth_method?: string;
}

/** The bytes on disk (coordination: no version field). */
interface Counters {
  /** When each run of the last 24 hours started. */
  runs: string[];
  consecutive_failures: number;
  paused_until: string | null;
  last: LastRun | null;
}

const EMPTY: Counters = { runs: [], consecutive_failures: 0, paused_until: null, last: null };

function parse(value: Partial<Counters> | undefined, now: Date): Counters {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const since = now.getTime() - DAY_MS;
  return {
    runs: (Array.isArray(value.runs) ? value.runs : []).filter((at): at is string => typeof at === 'string' && Date.parse(at) > since),
    consecutive_failures: typeof value.consecutive_failures === 'number' ? value.consecutive_failures : 0,
    paused_until: typeof value.paused_until === 'string' ? value.paused_until : null,
    last: value.last && typeof value.last === 'object' ? value.last : null,
  };
}

/** What status shows of the caps. */
export interface CapState {
  readonly runs_today: number;
  readonly runs_per_day: number;
  /** When the next run may start under the daily cap, or null when one may start now. */
  readonly next_run_at: string | null;
  readonly consecutive_failures: number;
  /** The end of the 6 h pause, or null when not paused. */
  readonly paused_until: string | null;
  readonly last: LastRun | null;
}

export async function capState(store: MachineLocalStore, now: Date): Promise<CapState> {
  const counters = parse(await store.coordination.read<Partial<Counters>>(KIND, KEY), now);
  const paused = counters.paused_until !== null && Date.parse(counters.paused_until) > now.getTime() ? counters.paused_until : null;
  const oldest = [...counters.runs].sort()[0];
  const full = counters.runs.length >= RUNS_PER_DAY && oldest !== undefined;
  return {
    runs_today: counters.runs.length,
    runs_per_day: RUNS_PER_DAY,
    next_run_at: full ? new Date(Date.parse(oldest) + DAY_MS).toISOString() : null,
    consecutive_failures: counters.consecutive_failures,
    paused_until: paused,
    last: counters.last,
  };
}

/** NOT_DUE while the runner is paused or has used its runs for the day. */
export async function checkCaps(store: MachineLocalStore, now: Date): Promise<CapState> {
  const state = await capState(store, now);
  if (state.paused_until !== null) {
    const why = `the runner is paused until ${state.paused_until} after ${FAILURES_BEFORE_PAUSE} consecutive failed runs`;
    throw new GrimoireError('NOT_DUE', `no chore to run: ${why}`, { why, paused_until: state.paused_until });
  }
  if (state.next_run_at !== null) {
    const why = `the runner has used its ${RUNS_PER_DAY} runs for the day; the next may start at ${state.next_run_at}`;
    throw new GrimoireError('NOT_DUE', `no chore to run: ${why}`, { why, next_run_at: state.next_run_at });
  }
  return state;
}

/** Counts a run as started now (one iteration: a spawn and its fix-up respawn). */
export async function countRun(store: MachineLocalStore, now: Date): Promise<void> {
  await store.coordination.update<Partial<Counters>>(KIND, KEY, (current) => {
    const counters = parse(current, now);
    return { ...counters, runs: [...counters.runs, now.toISOString()] };
  });
}

/** Records how a run ended: a success clears the failure count; a second failure in a row pauses the runner for 6 h. */
export async function recordRun(store: MachineLocalStore, now: Date, last: LastRun, succeeded: boolean): Promise<void> {
  await store.coordination.update<Partial<Counters>>(KIND, KEY, (current) => {
    const counters = parse(current, now);
    if (succeeded) return { ...counters, consecutive_failures: 0, last };
    const failures = counters.consecutive_failures + 1;
    if (failures >= FAILURES_BEFORE_PAUSE) {
      return { ...counters, consecutive_failures: 0, paused_until: new Date(now.getTime() + PAUSE_MS).toISOString(), last };
    }
    return { ...counters, consecutive_failures: failures, last };
  });
}
