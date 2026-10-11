// Sync in the core (spec §4 Sync, §6): the explicit `sync` op, the automatic
// sync that attempt-ending writes ask for, the sync-pending markers and the
// machine-local sync status. The tracker store does the git work; this module
// decides when, and keeps the record of how it went.
import { GrimoireError } from '../errors';
import { runGit } from '../git/run';
import { MachineLocalStore } from '../machine-local';
import {
  TRACKER_REF,
  type Person,
  type SyncFailureClass,
  type SyncOutcome,
  type SyncSpec,
  type TrackerStore,
  type TrackerView,
} from '../tracker';
import type { Actor, CallContext } from './context';
import { define, writer } from './op';
import { s } from './schema';

/** The store setting that governs every automatic sync (spec §4). Unset means on; the human-only settings change it. */
export const AUTO_SYNC_SETTING = 'auto-sync';

/** Whether a store's settings let automatic syncs run. */
export function autoSyncOn(view: Pick<TrackerView, 'setting'>): boolean {
  const value = view.setting(AUTO_SYNC_SETTING);
  return value !== false && value !== 'off' && value !== 'false';
}

/** Coordination kind of the sync-pending markers: one per local tip oid (spec §6). */
const PENDING = 'sync-pending';
/** Records kind and key of the sync status (spec §6). */
const STATUS = 'sync-status';
const STATUS_KEY = 'tracker';
/** The machine-local lease an automatic sync holds; a held lease means another process is syncing. */
const LEASE = 'sync';
const LEASE_TTL_MS = 10 * 60_000;

/** Each network step's timeout: short for automatic syncs (a detached child keeps `codex exec` waiting), long for `sync`. */
export const AUTO_STEP_TIMEOUT_MS = 20_000;
export const EXPLICIT_STEP_TIMEOUT_MS = 120_000;
/**
 * An automatic sync's time as a whole, every step and round included (spikes
 * E and F: `codex exec` and some sandboxed shells wait for the detached
 * child). What it leaves undone, the sync-pending marker keeps.
 */
export const AUTO_BUDGET_MS = 60_000;
/** Failures back off exponentially from this, up to an hour (spec §4). */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
/** A sync runs again, at most this many times in all, when writes landed while it ran. */
const DRAIN_ROUNDS = 3;

/** A sync-pending marker: coordination data, version-free. Times are epoch ms. */
interface PendingMarker {
  readonly tip: string;
  readonly at: number;
}

/** The machine-local sync status (records class). Times are epoch ms. */
export interface SyncStatusRecord {
  readonly remote: string | null;
  /** The remote's URL, userinfo stripped. */
  readonly url: string | null;
  readonly last_attempt_at: number;
  readonly last_success_at: number | null;
  readonly last_result: 'in-sync' | 'pushed' | 'no-remote' | 'no-default-branch' | 'failed';
  /** The last failure, until a sync settles: its class, the remote's message, and the client and surface whose process hit it. */
  readonly failure: {
    readonly class: SyncFailureClass;
    readonly message: string;
    readonly client: string;
    readonly surface: string;
    readonly at: number;
  } | null;
  /** Syncs in a row that left the tip pending at the remote's end (failures, no default branch). */
  readonly failures: number;
  /** Automatic syncs wait until then. */
  readonly retry_at: number | null;
}

/** Who runs a sync, and how. */
export interface SyncRequest {
  /** Author of a fold commit; null without a git identity. */
  readonly author: Person | null;
  /** The git identity as resolved (`user.name`, `user.email`), reported with NO_GIT_IDENTITY. */
  readonly identity?: { readonly name: string | null; readonly email: string | null };
  readonly actor: Actor;
  /** The client whose process runs the sync (`claude-code`, `codex-mcp-client`, `cli`, …), recorded with a failure. */
  readonly client: string;
  /** Its surface (`mcp`, `cli`, `dashboard`, …). */
  readonly surface: string;
  /** Each network step's timeout. */
  readonly timeoutMs?: number;
  /** The sync's time as a whole (default: AUTO_BUDGET_MS for automatic syncs, none for `sync`). */
  readonly budgetMs?: number;
}

/** What a custom automatic sync is handed: the sync-pending marker for `tip` is already set. */
export interface AutoSyncRequest {
  /** The host repo root of the call that wrote. */
  readonly root: string;
  readonly commonDir: string;
  /** The commit the triggering write made. */
  readonly tip: string;
  /** The call context of the write. */
  readonly ctx: CallContext;
}

/** Why an automatic sync didn't run (`error`: the store refused, for example NO_GIT_IDENTITY for a fold). */
export type SyncSkip = 'auto-sync-off' | 'backoff' | 'busy' | 'error';

/** The sync request of a call context: its person, actor, client and surface. */
export function syncRequestOf(ctx: CallContext, actor: Actor): SyncRequest {
  return {
    author: ctx.person.email ? writer(ctx) : null,
    identity: { name: ctx.person.name, email: ctx.person.email },
    actor,
    client: actor.client ?? ctx.surface,
    surface: ctx.surface,
  };
}

function machineOf(tracker: TrackerStore): MachineLocalStore {
  return new MachineLocalStore(tracker.location.commonDir);
}

/**
 * Sets the sync-pending marker for local tip `tip` (spec §6): set before any
 * sync tries, and cleared only once the remote holds that tip or a descendant.
 */
export async function markSyncPending(commonDir: string, tip: string): Promise<void> {
  const machine = new MachineLocalStore(commonDir);
  if (await machine.coordination.read<PendingMarker>(PENDING, tip)) return;
  await machine.coordination.write<PendingMarker>(PENDING, tip, { tip, at: Date.now() });
}

async function pendingMarkers(machine: MachineLocalStore): Promise<PendingMarker[]> {
  return (await machine.coordination.list<PendingMarker>(PENDING)).map((entry) => entry.value).filter((m) => typeof m?.tip === 'string');
}

/** Clears every marker whose tip the remote holds (`remoteTip` or an ancestor), or that names no commit here. */
async function clearHeld(machine: MachineLocalStore, root: string, remoteTip: string | null): Promise<void> {
  for (const marker of await pendingMarkers(machine)) {
    // With no tracker tip anywhere there is nothing to push: the marker is stale.
    const held =
      remoteTip === null ||
      marker.tip === remoteTip ||
      // 0: an ancestor; 1: not one; anything else: the commit is gone (a rewritten segment).
      (await runGit(root, ['merge-base', '--is-ancestor', marker.tip, remoteTip])).code !== 1;
    if (held) await machine.coordination.remove(PENDING, marker.tip);
  }
}

async function localTip(root: string): Promise<string | null> {
  const run = await runGit(root, ['rev-parse', '--verify', '--quiet', TRACKER_REF]);
  return run.code === 0 ? run.stdout.toString('utf8').trim() : null;
}

function backoff(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

async function recordStatus(machine: MachineLocalStore, outcome: SyncOutcome, request: SyncRequest): Promise<void> {
  await machine.records.update<SyncStatusRecord>(STATUS, STATUS_KEY, (current) => {
    const at = Date.now();
    const settled = outcome.state !== 'pending';
    const remoteEnd = outcome.reason === 'failed' || outcome.reason === 'no-default-branch';
    const failures = settled ? 0 : remoteEnd ? (current?.failures ?? 0) + 1 : (current?.failures ?? 0);
    return {
      remote: outcome.remote,
      url: outcome.url,
      last_attempt_at: at,
      last_success_at: settled ? at : (current?.last_success_at ?? null),
      last_result: settled ? (outcome.state as 'in-sync' | 'pushed') : outcome.reason!,
      failure: outcome.failure ? { ...outcome.failure, client: request.client, surface: request.surface, at } : null,
      failures,
      retry_at: remoteEnd ? at + backoff(failures) : null,
    };
  });
}

async function readStatus(machine: MachineLocalStore): Promise<SyncStatusRecord | undefined> {
  return machine.records.read<SyncStatusRecord>(STATUS, STATUS_KEY);
}

/** One sync: the tracker's fetch → fold → push, then its record and the markers settled. */
async function syncOnce(tracker: TrackerStore, machine: MachineLocalStore, request: SyncRequest, spec: SyncSpec): Promise<SyncOutcome> {
  const outcome = await tracker.sync(spec);
  // The record and the markers are best-effort: the sync itself already happened.
  await recordStatus(machine, outcome, request).catch(() => {});
  const pending = outcome.state === 'pending';
  if (pending && outcome.local) await markSyncPending(tracker.location.commonDir, outcome.local).catch(() => {});
  // A failed sync still knows what the remote held when last seen: markers for those tips settle too.
  if (!pending || outcome.remoteTip !== null) await clearHeld(machine, tracker.location.root, outcome.remoteTip).catch(() => {});
  return outcome;
}

/**
 * Syncs holding the sync lease, then again while writes landed meanwhile, at
 * most DRAIN_ROUNDS times in all and never past the budget. The check for new
 * writes comes after the lease is let go: a process whose own sync found the
 * lease held had committed its write by then, so this one sees it. A round
 * that finds the lease held leaves it to the holder, which checks the same
 * way. `explicit`: the first round runs even while the lease is held.
 */
async function syncRounds(
  tracker: TrackerStore,
  machine: MachineLocalStore,
  request: SyncRequest,
  options: { readonly explicit: boolean; readonly timeoutMs: number; readonly budgetMs?: number },
): Promise<SyncOutcome | { skipped: 'busy' }> {
  const deadline = options.budgetMs === undefined ? undefined : Date.now() + options.budgetMs;
  const spec: SyncSpec = {
    author: request.author,
    ...(request.identity ? { identity: request.identity } : {}),
    actor: request.actor,
    timeoutMs: options.timeoutMs,
    ...(deadline !== undefined ? { deadline } : {}),
  };
  let outcome: SyncOutcome | null = null;
  for (let round = 0; round < DRAIN_ROUNDS; round++) {
    if (outcome && deadline !== undefined && Date.now() >= deadline) break;
    const acquired = options.explicit
      ? await machine.leases.acquire(LEASE, { ttlMs: LEASE_TTL_MS }).catch(() => null)
      : await machine.leases.acquire(LEASE, { ttlMs: LEASE_TTL_MS });
    const lease = acquired?.status === 'acquired' ? acquired.lease : null;
    // A held lease is only efficiency: git's compare-and-set push keeps two syncs correct.
    if (!lease && !(options.explicit && round === 0)) break;
    try {
      outcome = await syncOnce(tracker, machine, request, spec);
    } finally {
      await lease?.release().catch(() => {});
    }
    if (outcome.state === 'pending' || (await localTip(tracker.location.root)) === outcome.local) break;
  }
  return outcome ?? { skipped: 'busy' };
}

/**
 * The explicit sync (`grimoire sync`, the dashboard's Sync now): always runs,
 * whatever the auto-sync setting, the backoff or another sync says. Sets the
 * pending marker for the local tip first.
 */
export async function syncNow(tracker: TrackerStore, request: SyncRequest): Promise<SyncOutcome> {
  const machine = machineOf(tracker);
  const local = await localTip(tracker.location.root);
  if (local) await markSyncPending(tracker.location.commonDir, local).catch(() => {});
  const outcome = await syncRounds(tracker, machine, request, {
    explicit: true,
    timeoutMs: request.timeoutMs ?? EXPLICIT_STEP_TIMEOUT_MS,
    ...(request.budgetMs !== undefined ? { budgetMs: request.budgetMs } : {}),
  });
  // The first round of an explicit sync always runs.
  return outcome as SyncOutcome;
}

/**
 * An automatic sync (spec §4): skipped while auto-sync is off, while failures
 * back off, or while another process holds the sync lease (that process
 * syncs again for writes that landed before it let go). Bounded by its
 * budget as a whole, so a detached child stays short. Never throws.
 */
export async function autoSync(tracker: TrackerStore, request: SyncRequest): Promise<SyncOutcome | { skipped: SyncSkip }> {
  const machine = machineOf(tracker);
  try {
    const status = await readStatus(machine).catch(() => undefined);
    if (status?.retry_at && Date.now() < status.retry_at) return { skipped: 'backoff' };
    if (!(await autoSyncAllowed(tracker))) return { skipped: 'auto-sync-off' };
    return await syncRounds(tracker, machine, request, {
      explicit: false,
      timeoutMs: request.timeoutMs ?? AUTO_STEP_TIMEOUT_MS,
      budgetMs: request.budgetMs ?? AUTO_BUDGET_MS,
    });
  } catch {
    // An automatic sync never fails anything: the marker stays for the next one.
    return { skipped: 'error' };
  }
}

/** The auto-sync setting of the store; a store that can't be read for want of a sync may sync. */
async function autoSyncAllowed(tracker: TrackerStore): Promise<boolean> {
  try {
    return autoSyncOn(await tracker.read());
  } catch (error) {
    if (error instanceof GrimoireError && error.code === 'NOT_SYNCED') return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// The ops.

export interface SyncResult {
  /** `in-sync`: the remote holds the local tip or a descendant; `pushed`: this sync pushed it; `pending`: it still doesn't. */
  state: 'in-sync' | 'pushed' | 'pending';
  /** Why it is pending: no remote, no default branch on it (nothing is pushed then), or a failure. */
  reason?: 'no-remote' | 'no-default-branch' | 'failed';
  /** The failure class (auth, network or rejected) and the remote's message. */
  failure?: { class: SyncFailureClass; message: string };
  remote: string | null;
  /** The remote's URL, userinfo stripped. */
  url: string | null;
  local: string | null;
  remote_tip: string | null;
  fetched: boolean;
  /** The fold commit this sync made, if any. */
  fold: string | null;
}

export function syncResult(outcome: SyncOutcome): SyncResult {
  return {
    state: outcome.state,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.failure ? { failure: { class: outcome.failure.class, message: outcome.failure.message } } : {}),
    remote: outcome.remote,
    url: outcome.url,
    local: outcome.local,
    remote_tip: outcome.remoteTip,
    fetched: outcome.fetched,
    fold: outcome.fold,
  };
}

export const sync = define({
  name: 'sync',
  description:
    'Fetch, fold and push grimoire/tracker now, whatever the auto-sync setting says. A failure (auth, network or rejected) comes back in the result and the sync status.',
  kind: 'write',
  // A runtime verb (the CLI's `sync`, the dashboard's Sync now), never an MCP tool.
  policy: 'internal',
  replay: 'none',
  input: s.object({}),
  async run(_input, { ctx, tracker, actor }): Promise<SyncResult> {
    return syncResult(await syncNow(tracker, syncRequestOf(ctx, actor)));
  },
});

export interface SyncStatusResult {
  remote: string | null;
  url: string | null;
  /** Whether automatic syncs run (the store's auto-sync setting); null when the store can't be read. */
  auto_sync: boolean | null;
  /** When the oldest sync-pending marker was set; null when nothing waits. */
  pending_since: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_result: SyncStatusRecord['last_result'] | null;
  /** The last failure, until a sync settles: class, the remote's message, and the client and surface whose process hit it. */
  failure: { class: SyncFailureClass; message: string; client: string; surface: string; at: string } | null;
  /** Automatic syncs wait until then after failures (exponential, up to an hour). */
  retry_at: string | null;
  /** One line for `status` and the dashboard. */
  summary: string;
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

const FAILURE_PHRASES: Readonly<Record<SyncFailureClass, string>> = {
  auth: 'authentication failed',
  network: 'the remote could not be reached',
  rejected: 'the remote rejected the push',
};

const SURFACE_NOUNS: Readonly<Record<string, string>> = {
  mcp: 'server',
  cli: 'CLI call',
  dashboard: 'dashboard',
  hook: 'hook',
  runner: 'runner',
};

export function syncSummary(status: Omit<SyncStatusResult, 'summary'>): string {
  if (status.pending_since === null) {
    if (status.last_result === null) return 'never synced on this machine';
    return status.remote ? `in sync with ${status.remote}/grimoire/tracker` : 'in sync';
  }
  const since = `sync pending since ${status.pending_since}`;
  if (status.failure) {
    const noun = SURFACE_NOUNS[status.failure.surface] ?? status.failure.surface;
    return `${since}: ${FAILURE_PHRASES[status.failure.class]} in a ${status.failure.client} ${noun}`;
  }
  if (status.last_result === 'no-default-branch') return `${since}: the remote has no default branch yet, so nothing is pushed`;
  if (status.last_result === 'no-remote') return `${since}: this clone has no remote to push to`;
  if (status.auto_sync === false) return `${since}: auto-sync is off; run \`grimoire sync\``;
  return since;
}

export const syncStatus = define({
  name: 'sync_status',
  description: 'How syncing grimoire/tracker goes on this machine: what waits, the last sync, and the last failure with the remote’s message.',
  kind: 'read',
  policy: 'internal',
  replay: 'none',
  input: s.object({}),
  async run(_input, { tracker }): Promise<SyncStatusResult> {
    const machine = machineOf(tracker);
    const record = await readStatus(machine).catch(() => undefined);
    const markers = await pendingMarkers(machine).catch(() => []);
    const oldest = markers.reduce<number | null>((min, m) => (min === null || m.at < min ? m.at : min), null);
    let auto: boolean | null = null;
    try {
      auto = autoSyncOn(await tracker.read());
    } catch {
      auto = null;
    }
    const status = {
      remote: record?.remote ?? null,
      url: record?.url ?? null,
      auto_sync: auto,
      pending_since: iso(oldest),
      last_attempt_at: iso(record?.last_attempt_at),
      last_success_at: iso(record?.last_success_at),
      last_result: record?.last_result ?? null,
      failure: record?.failure ? { ...record.failure, at: iso(record.failure.at)! } : null,
      retry_at: iso(record?.retry_at),
    };
    return { ...status, summary: syncSummary(status) };
  },
});
