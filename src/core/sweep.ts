// Sweeps in the core (spec §14 Sweeps, Pending session records; §13 Upkeep):
// capture never waits for a session to end. A sweep cuts the bound contexts of
// open attempts that went idle (30 min) or whose transcript was archived or
// compressed, oldest uncut first, within a budget, and attaches the pending
// records in one commit that binds nothing. A record is replaced only by a
// successful cut reaching strictly further, checked inside the compare-and-set
// round while the attempt is still open. Each attachment triggers a sync.
// Upkeep runs it under the part's lease: one sweep at a time per live store.
import { captureAtEnd, CUT_BUDGET_MS, type CaptureOptions, type SkillReadEvent } from '../capture/end';
import { noteCutReach, SEEN_HERE, sessionKey, type SeenHereRow } from '../capture/seen-here';
import { cutSucceeded, parseSessionRecord, replaces, serializeSessionRecord, withoutText, type SessionRecord } from '../capture/session-record';
import { registerSweep } from '../capture/sweeps';
import { compareReach } from '../tracker/fold-records';
import type { MachineLocalStore } from '../machine-local';
import { bundledRules, createScanner, type SecretScanner } from '../scanner';
import type { AttemptRecord, TrackerStore } from '../tracker';
import { captureMode } from './capture';
import { actorOf, type CallContext } from './context';
import { writer } from './op';
import { lowerMode, storeExcerptMode } from './settings';
import { SKILL_READS } from './skills';
import { autoSync, syncRequestOf } from './sync';

/** A context is swept once it was idle this long (spec §14: 30 min). */
export const IDLE_MS = 30 * 60_000;
/** A seen-here row of an attempt this tracker doesn't know (purged, another tracker) goes after this long. */
const UNKNOWN_ROW_MS = 30 * 24 * 60 * 60_000;

export interface SweepOptions {
  /** Where capture looks (default: the clients' own folders). */
  readonly capture?: CaptureOptions;
  /** The clock idleness and cut times are judged by (default: the system clock). */
  readonly clock?: () => Date;
  /** The whole sweep's budget (default: the cut's 10 s). */
  readonly budgetMs?: number;
  readonly scanner?: SecretScanner;
  /** Whether the commit asks for an automatic sync (default true). */
  readonly sync?: boolean;
  /** Called after each context's cut (a test's pause point). */
  readonly afterCut?: () => Promise<void> | void;
}

export interface SweepReport {
  /** Records attached to open attempts. */
  attached: number;
  /** Contexts cut. */
  cut: number;
  /** Contexts the budget overtook: their rows stay for the next sweep. */
  budget: number;
  /** Contexts whose cut reached no further than the last one. */
  unchanged: number;
  /** Seen-here rows removed: their attempts were sealed, or unknown for 30 days. */
  pruned: number;
  /** An attempt-ending call in this process cancelled the sweep: it committed nothing. */
  cancelled: boolean;
  commit: string | null;
}

interface Fresh {
  readonly handle: string;
  readonly key: string;
  readonly record: SessionRecord;
}

/** The session key of the context a row names (the key its coordination entry carries). */
function rowKey(row: SeenHereRow): string {
  return sessionKey({
    client: row.client,
    nonce: row.nonce,
    ...(row.session !== null ? { session: row.session } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  });
}

/** A transcript the client archived or compressed: its session is over, idle or not. */
function archived(row: SeenHereRow): boolean {
  return row.path !== null && (/[\\/]archived_sessions[\\/]/.test(row.path) || /\.zst$/i.test(row.path));
}

/**
 * One sweep of the machine-local rows against the tracker in `tracker`. Never
 * throws for a capture problem: those are statuses, and a context it can't
 * cut keeps its row for the next sweep.
 */
export async function sweepContexts(
  tracker: TrackerStore,
  store: MachineLocalStore,
  context: () => Promise<CallContext>,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const report: SweepReport = { attached: 0, cut: 0, budget: 0, unchanged: 0, pruned: 0, cancelled: false, commit: null };
  const entries = await store.coordination.list<SeenHereRow>(SEEN_HERE);
  if (entries.length === 0) return report;
  const now = (options.clock ?? (() => new Date()))();
  const view = await tracker.read();

  // Rows are hints only: those of sealed attempts have nothing left to cut.
  const open = new Map<string, { attempt: AttemptRecord; rows: SeenHereRow[] }>();
  for (const { key, value: row } of entries) {
    const attempt = view.attempt(row.handle);
    const stale = attempt ? attempt.end !== null : now.getTime() - Date.parse(row.last_at) > UNKNOWN_ROW_MS;
    if (stale) {
      if (await store.coordination.remove(SEEN_HERE, key).catch(() => false)) report.pruned++;
      continue;
    }
    if (!attempt) continue;
    if (now.getTime() - Date.parse(row.last_at) < IDLE_MS && !archived(row)) continue;
    const group = open.get(row.handle) ?? { attempt, rows: [] };
    group.rows.push(row);
    open.set(row.handle, group);
  }
  if (open.size === 0) return report;

  // Oldest uncut first: never-cut rows, by their first binding, then the rest by their last cut.
  const age = (row: SeenHereRow) => (row.reach === null ? Date.parse(row.at) - 1e15 : Date.parse(row.reach.at));
  const groups = [...open.values()].map((group) => ({ ...group, rows: group.rows.sort((x, y) => age(x) - age(y)) }));
  groups.sort((x, y) => age(x.rows[0]!) - age(y.rows[0]!));

  const abort = new AbortController();
  const unregister = registerSweep(() => abort.abort());
  const fresh: Fresh[] = [];
  let mode: Awaited<ReturnType<typeof captureMode>>['mode'];
  try {
    const { commonDir, root } = tracker.location;
    const cap = await captureMode(view, commonDir);
    mode = cap.mode;
    const skillReads = await store.records
      .list<SkillReadEvent>(SKILL_READS)
      .then((entries) => entries.map((entry) => entry.value))
      .catch(() => []);
    const scanner = options.scanner ?? createScanner(bundledRules);
    const deadline = Date.now() + (options.budgetMs ?? CUT_BUDGET_MS);
    const ctx = await context();
    for (const { attempt, rows: picked } of groups) {
      if (abort.signal.aborted) break;
      const byKey = new Map(picked.map((row) => [rowKey(row), row]));
      const captures = await captureAtEnd({
        repoRoot: root,
        worktree: ctx.repo.root,
        store,
        view,
        issue: attempt.issue,
        attempt,
        call: { op: 'sweep', actor: actorOf(ctx), source: null, pendingHint: null, binds: false, at: now.toISOString() },
        mode,
        capped: cap.capped,
        skillReads,
        scanner,
        ...(options.capture ? { options: options.capture } : {}),
        deadline,
        sweep: { only: new Set(byKey.keys()), signal: abort.signal, ...(options.afterCut ? { afterCut: options.afterCut } : {}) },
      });
      for (const { key, record } of captures) {
        const row = byKey.get(key)!;
        report.cut++;
        if (record.excerpt === 'budget' || record.facts === 'budget') {
          report.budget++;
          continue;
        }
        // Only a good cut that scanned a window is attached; the seal settles the rest.
        if (!cutSucceeded(record) || record.facts === 'partial') continue;
        if (row.reach !== null && compareReach(record.reach, row.reach) <= 0 && record.reach!.ref === row.reach.ref) {
          report.unchanged++;
          continue;
        }
        // Still active in the last 30 min (its last step), unless the client archived it: a later sweep.
        if (!archived(row) && now.getTime() - Date.parse(record.reach!.at) < IDLE_MS) continue;
        fresh.push({ handle: attempt.id, key, record });
      }
    }
  } finally {
    unregister();
  }
  if (abort.signal.aborted) {
    report.cancelled = true;
    return report;
  }
  if (fresh.length === 0) return report;

  const ctx = await context();
  const actor = actorOf(ctx);
  const cutMode = mode!;
  const write = await tracker.transact({ op: 'capture', author: writer(ctx), actor }, async (draft) => {
    const written: Fresh[] = [];
    // A mode tightened since the cut drops the text.
    const commits = lowerMode(storeExcerptMode(draft), cutMode);
    for (const item of fresh) {
      if (draft.attempt(item.handle)?.end !== null) continue;
      if ((await draft.purgedSessions(item.handle)).has(item.key)) continue;
      const stored = await draft.sessionRecord(item.handle, item.key);
      if (!replaces(item.record, stored === null ? null : parseSessionRecord(stored))) continue;
      draft.putSessionRecord(item.handle, item.key, serializeSessionRecord(commits === 'excerpts' ? item.record : withoutText(item.record)));
      written.push(item);
    }
    return { result: written };
  });
  report.attached = write.result.length;
  report.commit = write.commit;
  for (const { handle, key, record } of write.result) await noteCutReach(store, handle, key, record.reach!).catch(() => false);
  // Each attachment triggers a sync (spec §14).
  if (write.commit !== null && options.sync !== false) await autoSync(tracker, syncRequestOf(ctx, actor));
  return report;
}
