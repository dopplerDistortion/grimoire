// The upkeep scheduler (spec §13; §2 module 10): runs grimoire's mechanical
// background work in `grimoire mcp`, `start` and `init`, never in a short-lived
// CLI call and never in a hook.
//
// - A clone-wide part takes its own non-blocking, expiring machine-local lease
//   (`upkeep-<part>`) and skips while another process holds it. It runs at
//   most once per its interval across the clone: a stamp in the coordination
//   class records when it last ran, written before the lease is let go, so
//   two processes starting together run it exactly once.
// - The per-worktree part runs, for each registered worktree that pins this
//   process's version, under that worktree's (live store, worktree) lease,
//   the one `init` and `doctor --fix` take, at most once per 5 min per
//   worktree unless forced (a decision triggers it).
// - Skips: a worktree mid-merge, rebase, cherry-pick, revert or bisect; one
//   that pins another version; one whose upgrade-in-progress record names
//   another pin (with the finish-or-discard line), each checked again under
//   the lease. Clone-wide parts carry on through all of these while the
//   machine marker is readable; the per-worktree part, which records what it
//   did, needs it too.
//
// Nothing here throws: a failing part is reported, and the next part runs.
import { randomBytes } from 'node:crypto';
import type { CallContext, ClientInfo, Surface } from '../core/context';
import { readCheckoutConfig, readPerson } from '../core/host';
import { registeredWorktrees } from '../installer/worktrees';
import { findGitDirs, MachineLocalStore, type Json, type Lease } from '../machine-local';
import { VERSION } from '../version';
import { operationInProgress, upgradeInProgress, upgradeSkipNotice, worktreeKey } from './checkout';
import { UPKEEP_PARTS } from './parts';

/** A clone-wide part runs for the whole clone; a worktree part runs per registered worktree on this pin. */
export type PartScope = 'clone' | 'worktree';

/** What a part is handed. */
export interface PartInput {
  readonly store: MachineLocalStore;
  /** The checkout this process runs from. */
  readonly root: string;
  /** For a worktree part: the worktree it works on. Null for a clone-wide part. */
  readonly worktree: string | null;
  /** Whether `worktree` is the one this process runs from. */
  readonly own: boolean;
  /** The version this process runs. */
  readonly version: string;
  /** The call context for work done on the tracker (a sync's actor and request). */
  readonly context: () => Promise<CallContext>;
}

/** What a part reports. */
export interface PartOutcome {
  /** Details for the report and for `status`. */
  readonly result?: Json;
  /** Lines a person should see. */
  readonly notices?: readonly string[];
  /** The part couldn't do its work now (why): it isn't throttled, so the next pass tries again. */
  readonly skipped?: string;
}

/** One kind of mechanical background work. Later slices add their own (sweeps, reconcile, …). */
export interface UpkeepPart {
  /** Lowercase letters, digits and dashes: its lease is `upkeep-<name>`. */
  readonly name: string;
  readonly scope: PartScope;
  /** Clone-wide parts: the least time between two runs across the clone (default 5 min). */
  readonly intervalMs?: number;
  /** How long its lease lasts: a run that takes longer may be taken over (default 10 min). */
  readonly ttlMs?: number;
  run(input: PartInput): Promise<PartOutcome>;
}

/** How a part went: `held` (another process holds its lease), `throttled` (it ran recently), `skipped` (`why`). */
export type PartStatus = 'ran' | 'held' | 'throttled' | 'skipped' | 'failed';

export interface PartRun {
  readonly part: string;
  /** For a worktree part: the worktree. */
  readonly worktree?: string;
  readonly status: PartStatus;
  /** Why it skipped: `markers`, `pin`, `upgrade`, a git operation, `stopped`. */
  readonly why?: string;
  readonly result?: Json;
  /** A failure's message. */
  readonly error?: string;
}

export interface UpkeepReport {
  readonly runs: PartRun[];
  /** Lines a person should see, in the order the parts gave them. */
  readonly notices: string[];
}

export interface UpkeepOptions {
  /** The checkout this process runs from (any worktree of the clone). */
  readonly root: string;
  /** The version this process runs (default: this build's). */
  readonly version?: string;
  /** The parts to run (default: every part this release ships). */
  readonly parts?: readonly UpkeepPart[];
  /** Run every part now, whatever the throttles say; leases still apply. `init` and decisions force it. */
  readonly force?: boolean;
  /** This process's surface, for the actor of tracker work (default `mcp`). */
  readonly surface?: Surface;
  /** This process's nonce. */
  readonly nonce?: string;
  /** The agent client this process serves, once known. */
  readonly client?: () => ClientInfo | null;
  /** One line per part's outcome, for GRIMOIRE_DEBUG. */
  readonly debug?: (line: string) => void;
  /** Once aborted, the parts not yet started are skipped (`stopped`). */
  readonly signal?: AbortSignal;
}

/** The per-worktree part runs at most this often per worktree, unless forced. */
export const WORKTREE_INTERVAL_MS = 5 * 60_000;
/** A clone-wide part's default interval. */
export const CLONE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TTL_MS = 10 * 60_000;

/** Coordination kind of the stamps that throttle upkeep: version-free `{at}`. */
export const UPKEEP_STAMPS = 'upkeep-runs';

interface Stamp {
  /** When the part last ran (epoch ms). */
  readonly at: number;
  readonly pid?: number;
  readonly version?: string;
}

/** The (live store, worktree) lease name: shared by upkeep's per-worktree part, `init`, `doctor --fix` and `init --upgrade`. */
export async function worktreeLeaseName(worktree: string): Promise<string> {
  return `worktree:${await worktreeKey(worktree)}`;
}

/** A clone-wide part's lease name. */
export function partLeaseName(part: string): string {
  return `upkeep-${part}`;
}

async function stampFresh(store: MachineLocalStore, key: string, intervalMs: number): Promise<boolean> {
  const stamp = await store.coordination.read<Stamp>(UPKEEP_STAMPS, key).catch(() => undefined);
  return typeof stamp?.at === 'number' && Date.now() - stamp.at < intervalMs && stamp.at <= Date.now();
}

async function writeStamp(store: MachineLocalStore, key: string, version: string): Promise<void> {
  await store.coordination.write<Stamp>(UPKEEP_STAMPS, key, { at: Date.now(), pid: process.pid, version }).catch(() => {});
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One upkeep pass: the clone-wide parts, then the per-worktree part for each
 * registered worktree on this version. Resolves with what each part did.
 */
export async function runUpkeep(options: UpkeepOptions): Promise<UpkeepReport> {
  const runs: PartRun[] = [];
  const notices: string[] = [];
  const report = (run: PartRun) => {
    runs.push(run);
    options.debug?.(`upkeep ${run.part}${run.worktree ? ` ${run.worktree}` : ''}: ${run.status}${run.why ? ` (${run.why})` : ''}${run.error ? `: ${run.error}` : ''}`);
  };
  const dirs = await findGitDirs(options.root).catch(() => null);
  if (!dirs) return { runs, notices };
  const store = new MachineLocalStore(dirs.commonDir, dirs.worktree);
  const version = options.version ?? VERSION;
  const parts = options.parts ?? UPKEEP_PARTS;
  const nonce = options.nonce ?? randomBytes(8).toString('hex');
  let context: Promise<CallContext> | null = null;
  const input = (worktree: string | null, own: boolean): PartInput => ({
    store,
    root: dirs.worktree,
    worktree,
    own,
    version,
    context: () => (context ??= contextOf(dirs.worktree, options.surface ?? 'mcp', nonce, options.client)),
  });
  const stopped = () => options.signal?.aborted === true;
  /** Runs one part; false when it skipped (then nothing throttles it). */
  const ran = async (part: UpkeepPart, worktree: string | null, own: boolean): Promise<boolean> => {
    const where = worktree ? { worktree } : {};
    try {
      const outcome = await part.run(input(worktree, own));
      notices.push(...(outcome.notices ?? []));
      const result = outcome.result !== undefined ? { result: outcome.result } : {};
      if (outcome.skipped !== undefined) {
        report({ part: part.name, ...where, status: 'skipped', why: outcome.skipped, ...result });
        return false;
      }
      report({ part: part.name, ...where, status: 'ran', ...result });
    } catch (error) {
      report({ part: part.name, ...where, status: 'failed', error: messageOf(error) });
    }
    return true;
  };

  // Clone-wide parts: while the machine marker is readable.
  const cloneParts = parts.filter((part) => part.scope === 'clone');
  const markers = await store.marker.check().then(
    () => null,
    (error: unknown) => messageOf(error),
  );
  for (const part of cloneParts) {
    if (stopped()) {
      report({ part: part.name, status: 'skipped', why: 'stopped' });
      continue;
    }
    if (markers !== null) {
      report({ part: part.name, status: 'skipped', why: 'markers', error: markers });
      continue;
    }
    const interval = part.intervalMs ?? CLONE_INTERVAL_MS;
    if (!options.force && (await stampFresh(store, part.name, interval))) {
      report({ part: part.name, status: 'throttled' });
      continue;
    }
    const lease = await acquire(store, partLeaseName(part.name), part.ttlMs ?? DEFAULT_TTL_MS);
    if (!lease) {
      report({ part: part.name, status: 'held' });
      continue;
    }
    try {
      // Another process may have finished it between the check and the lease.
      if (!options.force && (await stampFresh(store, part.name, interval))) {
        report({ part: part.name, status: 'throttled' });
        continue;
      }
      if (await ran(part, null, false)) await writeStamp(store, part.name, version);
    } finally {
      await lease.release().catch(() => {});
    }
  }

  // The per-worktree part: each registered worktree on this version.
  const worktreeParts = parts.filter((part) => part.scope === 'worktree');
  if (worktreeParts.length === 0) return { runs, notices };
  const ownKey = await worktreeKey(dirs.worktree);
  const { worktrees } = await registeredWorktrees(dirs.commonDir).catch(() => ({ worktrees: [dirs.worktree] }));
  for (const worktree of worktrees) {
    const own = (await worktreeKey(worktree)) === ownKey;
    const each = (status: PartStatus, why?: string) => {
      for (const part of worktreeParts) report({ part: part.name, worktree, status, ...(why ? { why } : {}) });
    };
    if (stopped()) {
      each('skipped', 'stopped');
      continue;
    }
    /** Whether the worktree is to be left alone now (reported, except a pin-less one). */
    const leaveAlone = async (): Promise<boolean> => {
      const gate = await worktreeGate(store, worktree, version);
      if (gate === null) return false;
      if (gate.skip === 'upgrade') notices.push(upgradeSkipNotice(worktree, gate.to));
      if (gate.skip !== 'pin-less') each('skipped', gate.skip);
      return true;
    };
    if (await leaveAlone()) continue;
    // Its work is recorded in records, which the machine marker governs.
    if (markers !== null) {
      for (const part of worktreeParts) report({ part: part.name, worktree, status: 'skipped', why: 'markers', error: markers });
      continue;
    }
    const key = await worktreeLeaseName(worktree);
    if (!options.force && (await stampFresh(store, key, WORKTREE_INTERVAL_MS))) {
      each('throttled');
      continue;
    }
    const lease = await acquire(store, key, DEFAULT_TTL_MS);
    if (!lease) {
      each('held');
      continue;
    }
    try {
      if (!options.force && (await stampFresh(store, key, WORKTREE_INTERVAL_MS))) {
        each('throttled');
        continue;
      }
      // Checked again under the lease, right before the work: the pin may have
      // moved (a switch, a merge, an upgrade's config.yml) or an upgrade begun.
      if (await leaveAlone()) continue;
      const operation = await operationInProgress(worktree);
      if (operation) {
        each('skipped', operation);
        continue;
      }
      let done = true;
      for (const part of worktreeParts) {
        if (stopped()) {
          report({ part: part.name, worktree, status: 'skipped', why: 'stopped' });
          done = false;
        } else if (!(await ran(part, worktree, own))) done = false;
      }
      if (done) await writeStamp(store, key, version);
    } finally {
      await lease.release().catch(() => {});
    }
  }
  return { runs, notices };
}

/** Why the per-worktree part leaves a worktree alone, before and again under its lease. */
type WorktreeGate = { readonly skip: 'pin-less' } | { readonly skip: 'pin' } | { readonly skip: 'upgrade'; readonly to: string };

/** Null when the per-worktree part may work on `worktree` in a process running `version`. */
async function worktreeGate(store: MachineLocalStore, worktree: string, version: string): Promise<WorktreeGate | null> {
  const config = await readCheckoutConfig(worktree).catch(() => undefined);
  // Pin-less, or unreadable: nothing of this release lives there.
  if (!config?.pin) return { skip: 'pin-less' };
  if (config.pin !== version) return { skip: 'pin' };
  const upgrade = await upgradeInProgress(store, worktree).catch(() => null);
  if (upgrade && upgrade.to !== version) return { skip: 'upgrade', to: upgrade.to };
  return null;
}

async function acquire(store: MachineLocalStore, name: string, ttlMs: number): Promise<Lease | null> {
  const result = await store.leases.acquire(name, { ttlMs }).catch(() => null);
  return result?.status === 'acquired' ? result.lease : null;
}

/**
 * Takes the (live store, worktree) lease for `init`, `doctor --fix` or
 * `init --upgrade`, waiting up to `waitMs` (default 30 s) while upkeep's
 * per-worktree part or another of them holds it. Null when it stayed held.
 */
export async function holdWorktreeLease(
  store: MachineLocalStore,
  worktree: string,
  options: { readonly waitMs?: number; readonly ttlMs?: number } = {},
): Promise<Lease | null> {
  const name = await worktreeLeaseName(worktree);
  const deadline = Date.now() + (options.waitMs ?? 30_000);
  for (;;) {
    const result = await store.leases.acquire(name, { ttlMs: options.ttlMs ?? DEFAULT_TTL_MS });
    if (result.status === 'acquired') return result.lease;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
  }
}

async function contextOf(root: string, surface: Surface, nonce: string, client: (() => ClientInfo | null) | undefined): Promise<CallContext> {
  const config = await readCheckoutConfig(root).catch(() => null);
  return {
    surface,
    repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
    person: await readPerson(root),
    client: client?.() ?? null,
    nonce,
  };
}
