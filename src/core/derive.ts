// Derivations over the tracker view (spec §2.1: the core owns every
// derivation; surfaces only render them): children, blocker states, open
// attempts and their assignees, stale claims, ready, and the relation cycles
// writes refuse.
import { GrimoireError } from '../errors';
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

/**
 * A fold conflict as reads and STATE_CONFLICT show it: the conflicted fields,
 * the value each had before both changes (`base`), and the one the fold set
 * aside (`theirs`); the issue itself holds the value that stands.
 */
export interface IssueConflict {
  fields: string[];
  theirs: Record<string, unknown>;
  base: Record<string, unknown>;
}

/** The field the conflict of two open attempts (after a cross-clone fold) names. */
export const OPEN_ATTEMPTS_FIELD = 'open_attempts';

/**
 * The issue's field conflicts from its fold records, or null. Later records
 * win `theirs`; the earliest one keeps `base`. This is what blocks claims,
 * full-body replaces and writes to a conflicted field.
 */
export function fieldConflict(view: TrackerView, id: string): IssueConflict | null {
  const records = view.conflicts(id);
  if (records.length === 0) return null;
  const fields = new Set<string>();
  const theirs: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};
  for (const record of records) {
    for (const field of record.fields) {
      if (!fields.has(field)) base[field] = record.base[field] ?? null;
      fields.add(field);
      theirs[field] = record.theirs[field] ?? null;
    }
  }
  return { fields: [...fields].sort(), theirs, base };
}

/** STATE_CONFLICT: the write needs the conflict resolved first (a human op). */
export function stateConflict(id: string, conflict: IssueConflict, what: string): GrimoireError {
  return new GrimoireError(
    'STATE_CONFLICT',
    `${id} has a fold conflict on ${conflict.fields.join(', ')}: ${what} until a human resolves it; comments and anchored patches still work`,
    { conflict },
  );
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
  /** The fold conflict, or null: field conflicts, and two open attempts (`open_attempts`). */
  readonly conflict: IssueConflict | null;
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

/**
 * The live issue a stored relation (`parent`, `blocked_by`) names: the id
 * itself, or for the bare id of a resolved collision, the record its
 * forwarding record names. Undefined for a dangling id.
 */
export function relatedIssue(view: TrackerView, id: string): IssueRecord | undefined {
  const issue = view.issue(id);
  if (issue) return issue;
  const forward = view.forwardOf(id);
  return forward === undefined ? undefined : view.issue(forward);
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
  const state = (id: string) => stateOf(relatedIssue(view, id));
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
      let conflict = fieldConflict(view, id);
      if (openAttempts.length > 1) {
        // Two open attempts (claims made on two clones) count as a conflict.
        conflict = {
          fields: [...(conflict?.fields ?? []), OPEN_ATTEMPTS_FIELD].sort(),
          theirs: { ...conflict?.theirs, [OPEN_ATTEMPTS_FIELD]: openAttempts.map((a) => a.record.id) },
          base: { ...conflict?.base, [OPEN_ATTEMPTS_FIELD]: [] },
        };
      }
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
