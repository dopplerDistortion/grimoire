// Derivations over the tracker view (spec §2.1: the core owns every
// derivation; surfaces only render them): children, blocker states, open
// attempts and their assignees, stale claims, ready, and the relation cycles
// writes refuse.
import type { AttemptRecord, IssueRecord, TrackerView } from '../tracker';

/** A blocker's state as a reader sees it: a dangling id reads as `unknown`, and it blocks. */
export type RelationState = 'open' | 'done' | 'canceled' | 'unknown';

/** What a reader learns about one open attempt. */
export interface OpenAttemptFacts {
  readonly record: AttemptRecord;
  /** The person holding it. */
  readonly assignee: string;
  readonly since: string;
  /** The latest write on the issue during the attempt (its opening at the least). */
  readonly lastActivityAt: string;
  /** The clients of its binding writes: the opening, and every write that named the handle. */
  readonly clientsSeen: readonly string[];
}

/** Facts derived for one live issue. */
export interface Derived {
  /** Live sub-issues, ordered by (seq, id). */
  readonly children: readonly IssueRecord[];
  readonly openChildCount: number;
  /** Blockers that block: open, or unknown (dangling). */
  readonly openBlockerCount: number;
  /** Open attempts, in the order they opened (two only after a cross-clone fold). */
  readonly openAttempts: readonly OpenAttemptFacts[];
  /** People holding an open attempt. */
  readonly assignees: readonly string[];
  /** Has an open attempt. */
  readonly claimed: boolean;
  /** An open attempt has shown no activity since the stale cutoff. */
  readonly stale: boolean;
  /** The fold conflict, or null (`{fields, theirs, base}` once folds land). */
  readonly conflict: null;
  /** Ready = claimable: open, unclaimed, unconflicted, unblocked and with no open sub-issue. */
  readonly ready: boolean;
}

export interface Derivations {
  of(id: string): Derived;
  state(id: string): RelationState;
}

function stateOf(issue: IssueRecord | undefined): RelationState {
  if (!issue) return 'unknown';
  return issue.status === 'done' || issue.status === 'canceled' ? issue.status : 'open';
}

/** The facts of an open attempt. */
export function openAttemptFacts(record: AttemptRecord): OpenAttemptFacts {
  let lastActivityAt = record.start.at;
  const clients = new Set<string>();
  const client = record.start.actor.client;
  if (typeof client === 'string') clients.add(client);
  for (const entry of record.activity) {
    if (entry.at > lastActivityAt) lastActivityAt = entry.at;
    const by = entry.detail?.actor.client;
    if (entry.detail?.attempt === record.id && typeof by === 'string') clients.add(by);
  }
  return {
    record,
    assignee: record.start.assignee,
    since: record.start.at,
    lastActivityAt,
    clientsSeen: [...clients].sort(),
  };
}

/** The issue's open attempts, in the order they opened. */
export function openAttemptsOf(view: TrackerView, id: string): OpenAttemptFacts[] {
  return view
    .attempts(id)
    .filter((attempt) => attempt.end === null)
    .map(openAttemptFacts);
}

const memo = new WeakMap<TrackerView, { staleBefore: number; derivations: Derivations }>();

/**
 * The derivations of a view (views are immutable, so they are computed once
 * per view and cutoff). An open attempt is stale when its last activity is
 * before `staleBefore` (epoch ms; by default nothing is stale).
 */
export function derivations(view: TrackerView, staleBefore = Number.NEGATIVE_INFINITY): Derivations {
  const found = memo.get(view);
  if (found && found.staleBefore === staleBefore) return found.derivations;
  const children = new Map<string, IssueRecord[]>();
  for (const issue of view.issues()) {
    if (issue.parent === null) continue;
    let list = children.get(issue.parent);
    if (!list) children.set(issue.parent, (list = []));
    list.push(issue);
  }
  const cache = new Map<string, Derived>();
  const state = (id: string) => stateOf(view.issue(id));
  const derived: Derivations = {
    state,
    of(id) {
      let facts = cache.get(id);
      if (facts) return facts;
      const issue = view.issue(id);
      const kids = children.get(id) ?? [];
      const openChildCount = kids.filter((kid) => stateOf(kid) === 'open').length;
      const openBlockerCount = (issue?.blocked_by ?? []).filter((b) => {
        const s = state(b);
        return s === 'open' || s === 'unknown';
      }).length;
      const openAttempts = openAttemptsOf(view, id);
      const claimed = openAttempts.length > 0;
      // Fold conflicts arrive with the fold slice; until then nothing is conflicted.
      const conflict = null;
      const ready =
        issue !== undefined &&
        stateOf(issue) === 'open' &&
        !claimed &&
        conflict === null &&
        openChildCount === 0 &&
        openBlockerCount === 0;
      facts = {
        children: kids,
        openChildCount,
        openBlockerCount,
        openAttempts,
        assignees: [...new Set(openAttempts.map((a) => a.assignee))],
        claimed,
        stale: openAttempts.some((a) => Date.parse(a.lastActivityAt) < staleBefore),
        conflict,
        ready,
      };
      cache.set(id, facts);
      return facts;
    },
  };
  memo.set(view, { staleBefore, derivations: derived });
  return derived;
}

/**
 * A relation cycle through `start` in `issues`, as the path of ids from
 * `start` back to it, or null. It follows "waits for" edges: an issue waits
 * for each of its blockers, and a parent waits for each of its sub-issues (it
 * isn't claimable while one is open). So pure parent cycles, pure blocker
 * cycles, and a sub-issue blocked by its own ancestor (neither could ever be
 * ready) are all cycles.
 */
export function findCycle(issues: readonly IssueRecord[], start: string): string[] | null {
  const waitsFor = new Map<string, string[]>();
  const edge = (from: string, to: string) => {
    let list = waitsFor.get(from);
    if (!list) waitsFor.set(from, (list = []));
    list.push(to);
  };
  for (const issue of issues) {
    for (const blocker of issue.blocked_by) edge(issue.id, blocker);
    if (issue.parent !== null) edge(issue.parent, issue.id);
  }
  const visited = new Set<string>();
  const path: string[] = [start];
  const walk = (node: string): boolean => {
    for (const next of waitsFor.get(node) ?? []) {
      if (next === start) {
        path.push(start);
        return true;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  };
  return walk(start) ? path : null;
}
