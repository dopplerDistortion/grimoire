// `list` (spec §8): filtered issue rows with their derived fields, ordered by
// (seq, id), paged by limit and cursor, and cut under the result budget.
import { GrimoireError, invalid } from '../errors';
import { parseWriteRef, type IssueRecord, type TrackerView } from '../tracker';
import { decodeCursor, encodeCursor, jsonBytes, longestPrefix, RESULT_BUDGET } from './budget';
import type { CallContext } from './context';
import { derivations, type Derivations } from './derive';
import { listedOpenAttempt, type ListedOpenAttempt } from './attempts';
import { define, oneLine } from './op';
import { staleCutoff } from './stale';
import { s } from './schema';

export interface ListRow {
  id: string;
  seq: number;
  title: string;
  status: string;
  labels: string[];
  /** The person holding the open attempt, or null. */
  assignee: string | null;
  parent: string | null;
  blocked_by: string[];
  /** Blockers that still block: open, or unknown (dangling). */
  open_blocker_count: number;
  open_child_count: number;
  /** Claimable: open, unclaimed, unconflicted, unblocked and with no open sub-issue. */
  ready: boolean;
  /** Open attempts (two only after a cross-clone fold). */
  open_attempts: ListedOpenAttempt[];
  conflict: null;
  comment_count: number;
  last_comment_at: string | null;
  created_at: string;
  updated_at: string;
  link: string;
}

export interface ListResult {
  rows: ListRow[];
  /** How many issues match the filters, across every page. */
  total: number;
  /** Pass it back to get the next page; null on the last one. */
  cursor: string | null;
  /** True when the ~24 KB cut ended this page before `limit` rows. */
  truncated?: true;
}

const VIEWS = ['open', 'ready', 'claimed', 'stale', 'blocked', 'conflicts', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];

function inView(view: View, issue: IssueRecord, d: ReturnType<Derivations['of']>): boolean {
  switch (view) {
    case 'open':
      return issue.status === 'open';
    case 'ready':
      return d.ready;
    case 'claimed':
      return d.claimed;
    case 'stale':
      return d.stale;
    case 'blocked':
      return issue.status === 'open' && d.openBlockerCount > 0;
    case 'conflicts':
      return d.conflict !== null;
    case 'closed':
      return issue.status !== 'open';
    case 'all':
      return true;
  }
}

/** A parent filter: any read ref, or a full id whose record is gone (its sub-issues still name it). */
function parentFilter(view: TrackerView, ref: string): string {
  try {
    return view.resolveRead(ref, 'parent');
  } catch (error) {
    if (!(error instanceof GrimoireError) || error.code !== 'NOT_FOUND') throw error;
    try {
      return parseWriteRef(ref, 'parent');
    } catch {
      throw error;
    }
  }
}

function rowOf(
  view: TrackerView,
  d: ReturnType<Derivations['of']>,
  issue: IssueRecord,
  person: string | null,
  staleBefore: number,
): ListRow {
  const comments = view.comments(issue.id);
  return {
    id: issue.id,
    seq: issue.seq,
    title: issue.title,
    status: issue.status,
    labels: [...issue.labels],
    assignee: d.assignees[0] ?? null,
    parent: issue.parent,
    blocked_by: [...issue.blocked_by],
    open_blocker_count: d.openBlockerCount,
    open_child_count: d.openChildCount,
    ready: d.ready,
    open_attempts: d.openAttempts.map((a) => listedOpenAttempt(a, person, staleBefore)),
    conflict: d.conflict,
    comment_count: comments.length,
    last_comment_at: comments.length > 0 ? comments[comments.length - 1]!.at : null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    link: view.link(issue.id),
  };
}

const after = (issue: IssueRecord, seq: number, id: string) => issue.seq > seq || (issue.seq === seq && issue.id > id);

export const list = define({
  name: 'list',
  description:
    'List grimoire issues in (seq, id) order. Filters combine (AND). `ready: true` is the frontier: open, unclaimed, unblocked issues with no open sub-issue. Pages by limit and cursor.',
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    status: s.optional(s.literal(['open', 'done', 'canceled'])),
    label: s.optional(s.array(s.string(oneLine), 'issues carrying every one of these labels')),
    without_label: s.optional(s.array(s.string(oneLine), 'issues carrying none of these labels')),
    unlabeled: s.optional(s.boolean('true: only issues without labels; false: only labeled ones')),
    parent: s.optional(s.string({ ...oneLine, description: 'sub-issues of this issue' })),
    assignee: s.optional(s.string({ ...oneLine, description: 'a person’s email, `me` or `none`' })),
    ready: s.optional(s.boolean('true: only claimable issues; false: only the rest')),
    view: s.optional(s.literal(VIEWS, 'a preset filter (default `all`)')),
    limit: s.optional(s.integer({ min: 1, max: 200, description: 'rows per page (default 50)' })),
    cursor: s.optional(s.string(oneLine)),
  }),
  async run(input, { ctx, tracker }): Promise<ListResult> {
    const start = input.cursor === undefined ? null : afterCursor(input.cursor);
    const view = await tracker.read();
    const staleBefore = await staleCutoff(tracker.location.commonDir, tracker.now());
    const derived = derivations(view, staleBefore);
    const parent = input.parent === undefined ? undefined : parentFilter(view, input.parent);
    const assignee = assigneeFilter(input.assignee, ctx);
    const matches = view.issues().filter((issue) => {
      const d = derived.of(issue.id);
      if (input.status !== undefined && issue.status !== input.status) return false;
      if (input.label && !input.label.every((l) => issue.labels.includes(l))) return false;
      if (input.without_label && input.without_label.some((l) => issue.labels.includes(l))) return false;
      if (input.unlabeled !== undefined && (issue.labels.length === 0) !== input.unlabeled) return false;
      if (parent !== undefined && issue.parent !== parent) return false;
      if (assignee !== undefined && !(assignee === null ? d.assignees.length === 0 : d.assignees.includes(assignee))) {
        return false;
      }
      if (input.ready !== undefined && d.ready !== input.ready) return false;
      return inView(input.view ?? 'all', issue, d);
    });
    const remaining = start ? matches.filter((issue) => after(issue, start.seq, start.id)) : matches;
    const limit = input.limit ?? 50;
    const page = remaining.slice(0, limit);

    const rows: ListRow[] = [];
    // Room for the result's own fields, a cursor and `truncated`.
    let bytes = jsonBytes({ rows: [], total: matches.length, cursor: encodeCursor('list', [Number.MAX_SAFE_INTEGER, 'gr-xxxxxxxx']), truncated: true });
    for (const issue of page) {
      let row = rowOf(view, derived.of(issue.id), issue, ctx.person.email, staleBefore);
      const size = jsonBytes(row) + (rows.length > 0 ? 1 : 0);
      if (bytes + size > RESULT_BUDGET) {
        if (rows.length > 0) break;
        // A single row over budget: only a huge title can do that; cut it.
        const room = RESULT_BUDGET - bytes - jsonBytes({ ...row, title: '' });
        row = { ...row, title: longestPrefix(row.title, (t) => jsonBytes(t) - 2 <= room) };
      }
      rows.push(row);
      bytes += size;
    }
    const cut = rows.length < page.length;
    const more = rows.length < remaining.length;
    const last = rows[rows.length - 1];
    return {
      rows,
      total: matches.length,
      cursor: more && last ? encodeCursor('list', [last.seq, last.id]) : null,
      ...(cut ? { truncated: true as const } : {}),
    };
  },
});

function afterCursor(cursor: string): { seq: number; id: string } {
  const state = decodeCursor(cursor, 'list');
  if (Array.isArray(state) && typeof state[0] === 'number' && typeof state[1] === 'string') {
    return { seq: state[0], id: state[1] };
  }
  throw invalid({ cursor: 'is not a cursor from list; pass the cursor a previous result returned' });
}

/** undefined: no filter; null: unassigned; otherwise the person's email. */
function assigneeFilter(assignee: string | undefined, ctx: CallContext): string | null | undefined {
  if (assignee === undefined) return undefined;
  if (assignee === 'none') return null;
  if (assignee === 'me') return ctx.person.email ?? '';
  return assignee;
}
