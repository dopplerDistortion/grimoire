// Derivations over the tracker view (spec §2.1: the core owns every
// derivation; surfaces only render them): children, blocker states, ready, and
// the relation cycles writes refuse.
import type { IssueRecord, TrackerView } from '../tracker';

/** A blocker's state as a reader sees it: a dangling id reads as `unknown`, and it blocks. */
export type RelationState = 'open' | 'done' | 'canceled' | 'unknown';

/** Facts derived for one live issue. */
export interface Derived {
  /** Live sub-issues, ordered by (seq, id). */
  readonly children: readonly IssueRecord[];
  readonly openChildCount: number;
  /** Blockers that block: open, or unknown (dangling). */
  readonly openBlockerCount: number;
  /** People holding an open attempt (none until claims land). */
  readonly assignees: readonly string[];
  /** Has an open attempt. */
  readonly claimed: boolean;
  /** An open attempt has shown no activity past the stale threshold. */
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

const memo = new WeakMap<TrackerView, Derivations>();

function stateOf(issue: IssueRecord | undefined): RelationState {
  if (!issue) return 'unknown';
  return issue.status === 'done' || issue.status === 'canceled' ? issue.status : 'open';
}

/** The derivations of a view, computed once per view (views are immutable). */
export function derivations(view: TrackerView): Derivations {
  let found = memo.get(view);
  if (found) return found;
  const children = new Map<string, IssueRecord[]>();
  for (const issue of view.issues()) {
    if (issue.parent === null) continue;
    let list = children.get(issue.parent);
    if (!list) children.set(issue.parent, (list = []));
    list.push(issue);
  }
  const cache = new Map<string, Derived>();
  const state = (id: string) => stateOf(view.issue(id));
  found = {
    state,
    of(id) {
      let derived = cache.get(id);
      if (derived) return derived;
      const issue = view.issue(id);
      const kids = children.get(id) ?? [];
      const openChildCount = kids.filter((kid) => stateOf(kid) === 'open').length;
      const openBlockerCount = (issue?.blocked_by ?? []).filter((b) => {
        const s = state(b);
        return s === 'open' || s === 'unknown';
      }).length;
      // Attempts and fold conflicts arrive with later slices; until then nothing is claimed or conflicted.
      const claimed = false;
      const conflict = null;
      const ready =
        issue !== undefined &&
        stateOf(issue) === 'open' &&
        !claimed &&
        conflict === null &&
        openChildCount === 0 &&
        openBlockerCount === 0;
      derived = { children: kids, openChildCount, openBlockerCount, assignees: [], claimed, stale: false, conflict, ready };
      cache.set(id, derived);
      return derived;
    },
  };
  memo.set(view, found);
  return found;
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
