// The machine-local half of chore runs (spec §6 Records; §16 Serving, Failures
// and replays): open chore runs, the served-item log of each, and the
// chore-exposure marks. None of it is ever committed: only a run that ended
// gets a chore-run record on the tracker (written by its submit), and expired
// and abandoned runs stay here.
//
// A run's lease is its last chore call: one with no chore call for 60 minutes
// has expired. It consumed nothing, the chore is due again, and a later call
// on it still works unless a newer run of its kind started meanwhile.
import { createHash } from 'node:crypto';
import type { MachineLocalStore } from '../../machine-local';
import type { ChoreKind } from '../../tracker';

/** Records kinds (spec §6, Records: under the machine marker's rule). */
export const OPEN_RUNS = 'chore-runs';
export const SERVED_LOGS = 'chore-served';
export const EXPOSURE_MARKS = 'chore-exposure';

/** A run expires after this long without a chore call (spec §16, Lease). */
export const LEASE_MS = 60 * 60_000;
/** Exposure marks are pruned after 30 days (spec §6). */
export const EXPOSURE_TTL_MS = 30 * 24 * 60 * 60_000;

/** How admission isolated a chore run (spec §16, the admission table). */
export type Isolation = 'claude-chore-agent' | 'codex-subagent' | 'codex-root' | 'unidentified' | 'runner';
/** Where a run came from (spec §16, Origin). */
export type ChoreOrigin = 'session' | 'manual' | 'runner' | 'scheduled';

/** One batch pair as the run took it. */
export interface RunPair {
  readonly pair: string;
  readonly trace: string;
  readonly outcome: string;
}

/** An open (or abandoned, or ended) chore run on this machine. */
export interface OpenRun {
  readonly id: string;
  readonly kind: ChoreKind;
  readonly origin: ChoreOrigin;
  readonly isolation: Isolation;
  readonly manual: boolean;
  /** The context that holds it (its chore-context key): only that context may page, submit or abandon it. */
  readonly context: string;
  /** The person (an email). */
  readonly person: string;
  readonly started_at: string;
  /** The latest chore call: the lease runs from here. */
  readonly last_call_at: string;
  readonly state: 'open' | 'abandoned' | 'ended';
  readonly ended_at: string | null;
  /** An abandon's reason: the agent's text, kept on this machine only. */
  readonly reason: string | null;
  /** Wiki Maintainer: the batch. */
  readonly batch: readonly RunPair[];
  /** Wiki Maintainer: conflicted pages to reconcile. */
  readonly conflicted: readonly string[];
  /** Skill Proposer: the compiles it would consume. */
  readonly compiles: readonly string[];
  /** The items paged in order without `item`. */
  readonly manifest: readonly string[];
}

/** One served item, as the run's served-item log keeps it. */
export interface ServedEntry {
  readonly item: string;
  /** sha256 of the whole item as served. */
  readonly hash: string;
  readonly at: string;
}

export interface ServedLog {
  readonly run: string;
  readonly items: readonly ServedEntry[];
}

/** A chore-exposure mark: a session or a server process that ran a chore outside an isolated context. */
export interface ExposureMark {
  readonly basis: 'session' | 'process';
  readonly run: string;
  readonly at: string;
}

/** Whether `run` is open with its lease lapsed at `now`. */
export function lapsed(run: OpenRun, now: Date): boolean {
  return run.state === 'open' && Date.parse(run.last_call_at) + LEASE_MS < now.getTime();
}

/** Whether `run` holds its lease at `now`: open, and called within the last 60 minutes. */
export function live(run: OpenRun, now: Date): boolean {
  return run.state === 'open' && !lapsed(run, now);
}

export function readRun(store: MachineLocalStore, id: string): Promise<OpenRun | undefined> {
  return store.records.read<OpenRun>(OPEN_RUNS, id);
}

export async function listRuns(store: MachineLocalStore): Promise<OpenRun[]> {
  return (await store.records.list<OpenRun>(OPEN_RUNS)).map((entry) => entry.value);
}

export function writeRun(store: MachineLocalStore, run: OpenRun): Promise<void> {
  return store.records.write(OPEN_RUNS, run.id, run as never);
}

/** Drops the run `id` (a start that didn't complete); false if it wasn't there. */
export function removeRun(store: MachineLocalStore, id: string): Promise<boolean> {
  return store.records.remove(OPEN_RUNS, id);
}

/** The live run the context `key` holds, or undefined. */
export async function liveRunOf(store: MachineLocalStore, key: string, now: Date): Promise<OpenRun | undefined> {
  return (await listRuns(store)).find((run) => run.context === key && live(run, now));
}

/** How long a run that ended, was abandoned or expired stays on this machine, with its served-item log. */
export const RUN_KEEP_MS = 30 * 24 * 60 * 60_000;

/** Drops runs (and their served-item logs) that stopped more than 30 days before `now`. */
export async function pruneRuns(store: MachineLocalStore, now: Date): Promise<void> {
  for (const run of await listRuns(store)) {
    if (live(run, now)) continue;
    const stopped = Date.parse(run.ended_at ?? run.last_call_at);
    if (now.getTime() - stopped <= RUN_KEEP_MS) continue;
    await store.records.remove(OPEN_RUNS, run.id).catch(() => false);
    await store.records.remove(SERVED_LOGS, run.id).catch(() => false);
  }
}

/** sha256 of a served item's JSON. */
export function itemHash(item: unknown): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

/** Adds what a page served to the run's log; an item already logged with the same hash is logged once. */
export async function logServed(store: MachineLocalStore, run: string, served: readonly { item: string; hash: string }[], at: Date): Promise<void> {
  if (served.length === 0) return;
  await store.records.update<ServedLog>(SERVED_LOGS, run, (current) => {
    const items = [...(current?.items ?? [])];
    const seen = new Set(items.map((entry) => `${entry.item}\n${entry.hash}`));
    for (const { item, hash } of served) {
      if (seen.has(`${item}\n${hash}`)) continue;
      seen.add(`${item}\n${hash}`);
      items.push({ item, hash, at: at.toISOString() });
    }
    return { run, items };
  });
}

export async function servedLog(store: MachineLocalStore, run: string): Promise<ServedLog> {
  return (await store.records.read<ServedLog>(SERVED_LOGS, run)) ?? { run, items: [] };
}

const markKey = (basis: ExposureMark['basis'], id: string) => `${basis}/${id}`;

/**
 * Marks a session or a server process as chore-exposed, pruning marks older
 * than 30 days, and returns an undo that puts back what the mark replaced.
 */
export async function markExposure(store: MachineLocalStore, basis: ExposureMark['basis'], id: string, run: string, now: Date): Promise<() => Promise<void>> {
  const key = markKey(basis, id);
  const prior = await store.records.read<ExposureMark>(EXPOSURE_MARKS, key);
  await store.records.write<ExposureMark>(EXPOSURE_MARKS, key, { basis, run, at: now.toISOString() });
  try {
    for (const entry of await store.records.list<ExposureMark>(EXPOSURE_MARKS)) {
      if (now.getTime() - Date.parse(entry.value.at) > EXPOSURE_TTL_MS) await store.records.remove(EXPOSURE_MARKS, entry.key).catch(() => false);
    }
  } catch {
    // Pruning is housekeeping: the next mark tries again.
  }
  return async () => {
    if (prior === undefined) await store.records.remove(EXPOSURE_MARKS, key);
    else await store.records.write<ExposureMark>(EXPOSURE_MARKS, key, prior);
  };
}

/**
 * The chore-exposure basis of a call (spec §14 Wiki-exposed): `session` when
 * its session is marked, else `process` when its server process is; undefined
 * when neither is (or the mark is older than 30 days).
 */
export async function exposureOf(store: MachineLocalStore, call: { session?: string; nonce: string }, now: Date): Promise<'session' | 'process' | undefined> {
  const fresh = (mark: ExposureMark | undefined) => mark !== undefined && now.getTime() - Date.parse(mark.at) <= EXPOSURE_TTL_MS;
  if (call.session !== undefined && fresh(await store.records.read<ExposureMark>(EXPOSURE_MARKS, markKey('session', call.session)))) return 'session';
  if (fresh(await store.records.read<ExposureMark>(EXPOSURE_MARKS, markKey('process', call.nonce)))) return 'process';
  return undefined;
}
