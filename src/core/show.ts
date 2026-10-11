// `show` (spec §8): one issue with its derived facts, its relations' states
// and its newest comments, cut under the result budget with a cursor that
// continues a long body, then pages to older comments.
import { invalid } from '../errors';
import { issueRevision, type IssueComment, type IssueLink, type TrackerView } from '../tracker';
import { decodeCursor, encodeCursor, jsonBytes, longestPrefix, RESULT_BUDGET } from './budget';
import { derivations, type RelationState } from './derive';
import { dashboardPort, localLink } from './local-link';
import { define, oneLine } from './op';
import { s } from './schema';

export interface RelatedIssue {
  id: string;
  /** Null when the record is gone (a dangling id). */
  title: string | null;
  status: RelationState;
}

export interface ShownComment {
  id: string;
  at: string;
  kind: string;
  actor: Record<string, unknown>;
  attempt?: string;
  body: string;
}

export interface ShowResult {
  id: string;
  seq: number;
  title: string;
  status: string;
  labels: string[];
  parent: string | null;
  blocked_by: string[];
  links: IssueLink[];
  created_at: string;
  created_by: string;
  updated_at: string;
  /**
   * The body, byte for byte as written; only a part of it when the result was
   * cut (continue with `cursor`). Absent on a page of older comments.
   */
  body?: string;
  /** Where this part of the body starts, when it doesn't start at 0. */
  body_from?: number;
  /** Opaque; changes exactly when the title, status, labels, relations, links, body or unknown keys change. */
  revision: string;
  link: string;
  /** This issue in the dashboard on this machine. */
  local_link: string;
  /** Sub-issues, by (seq, id). */
  children: RelatedIssue[];
  blockers: RelatedIssue[];
  /** Claimable: open, unclaimed, unconflicted, unblocked and with no open sub-issue. */
  ready: boolean;
  conflict: null;
  comment_count: number;
  /** A page of comments, oldest first: the newest ones (or those before the cursor). */
  comments: ShownComment[];
  /** Continues the body, then pages to older comments; null when nothing is left. */
  cursor: string | null;
  /** True when the ~24 KB cut left something out of this result. */
  truncated?: true;
}

type Position = { body: number } | { before: string | null };

const DEFAULT_COMMENTS = 20;
/** A comment is cut to fit only when at least this many bytes of its body would show. */
const MIN_COMMENT_ROOM = 1_000;

function shownComment(comment: IssueComment): ShownComment {
  return {
    id: comment.id,
    at: comment.at,
    kind: comment.kind,
    actor: { ...comment.actor },
    ...(comment.attempt !== undefined ? { attempt: comment.attempt } : {}),
    body: comment.body,
  };
}

function related(view: TrackerView, id: string, state: RelationState): RelatedIssue {
  return { id, title: view.issue(id)?.title ?? null, status: state };
}

/** The bytes a string adds to a JSON document (its quoted, escaped form). */
const stringBytes = (text: string) => jsonBytes(text) - 2;

export const show = define({
  name: 'show',
  description:
    'Show one issue: a full id, a unique prefix of 3+ characters, or a link. Returns its fields, body, revision, sub-issues and blockers with their state, and the newest comments; pass back `cursor` for the rest.',
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    ref: s.string(oneLine),
    comments: s.optional(
      s.either(
        s.literal(['none', 'all']),
        s.integer({ min: 0, max: 200 }),
        'how many of the newest comments to include (default 20)',
      ),
    ),
    cursor: s.optional(s.string({ ...oneLine, description: 'a cursor from an earlier show of this issue' })),
  }),
  async run(input, { tracker }): Promise<ShowResult> {
    const view = await tracker.read();
    const id = view.resolveRead(input.ref, 'ref');
    const record = view.issue(id)!;
    const revision = issueRevision(record);
    const position = input.cursor === undefined ? { body: 0 } : readCursor(input.cursor, id, revision);
    const derived = derivations(view);
    const facts = derived.of(id);
    const entries = view.comments(id);
    const port = await dashboardPort(tracker.location.commonDir);

    const result: ShowResult = {
      id: record.id,
      seq: record.seq,
      title: record.title,
      status: record.status,
      labels: [...record.labels],
      parent: record.parent,
      blocked_by: [...record.blocked_by],
      links: record.links.map((link) => ({ ...link })),
      created_at: record.created_at,
      created_by: record.created_by,
      updated_at: record.updated_at,
      revision,
      link: view.link(id),
      local_link: localLink(port, id),
      children: facts.children.map((kid) => related(view, kid.id, derived.state(kid.id))),
      blockers: record.blocked_by.map((b) => related(view, b, derived.state(b))),
      ready: facts.ready,
      conflict: facts.conflict,
      comment_count: entries.length,
      comments: [],
      cursor: null,
    };
    const cursorRoom = encodeCursor('show', { i: id, r: revision, b: Number.MAX_SAFE_INTEGER }).length + 2;
    const fixed = () => jsonBytes({ ...result, truncated: true }) + cursorRoom;
    // Only a vast number of relations can fill the budget on their own; keep the first ones.
    while (fixed() > RESULT_BUDGET && (result.children.length > 0 || result.blockers.length > 0)) {
      if (result.children.length >= result.blockers.length) result.children.pop();
      else result.blockers.pop();
      result.truncated = true;
    }

    if ('body' in position) {
      const rest = record.body.slice(position.body);
      const room = RESULT_BUDGET - fixed() - jsonBytes({ body: '', body_from: position.body });
      const part = stringBytes(rest) <= room ? rest : longestPrefix(rest, (p) => stringBytes(p) <= room) || [...rest][0]!;
      result.body = part;
      if (position.body > 0) result.body_from = position.body;
      if (part.length < rest.length) {
        result.cursor = encodeCursor('show', { i: id, r: revision, b: position.body + part.length });
        result.truncated = true;
        return orderKeys(result);
      }
    }

    const wanted = input.comments === 'none' ? 0 : input.comments === 'all' ? Infinity : (input.comments ?? DEFAULT_COMMENTS);
    if (wanted > 0) {
      const end = 'before' in position && position.before !== null ? entries.findIndex((e) => e.id === position.before) : entries.length;
      const page = entries.slice(Math.max(0, end - wanted), end);
      let room = RESULT_BUDGET - fixed();
      const shown: ShownComment[] = [];
      for (let i = page.length - 1; i >= 0; i--) {
        let comment = shownComment(await view.readComment(id, page[i]!.id));
        const size = jsonBytes(comment) + (shown.length > 0 ? 1 : 0);
        if (size > room) {
          const bodyRoom = room - jsonBytes({ ...comment, body: '' });
          // Only a comment over budget on a page of its own is cut; otherwise it waits for the next page.
          if (shown.length > 0 || bodyRoom < MIN_COMMENT_ROOM) break;
          comment = { ...comment, body: longestPrefix(comment.body, (b) => stringBytes(b) <= bodyRoom) };
          result.truncated = true;
        }
        shown.unshift(comment);
        room -= size;
      }
      result.comments = shown;
      const older = end - shown.length;
      if (shown.length < page.length) result.truncated = true;
      if (older > 0) {
        // Older comments continue before the oldest shown; with none shown, from where this page began.
        const before = shown[0]?.id ?? ('before' in position ? position.before : null);
        result.cursor = encodeCursor('show', { i: id, c: before });
      }
    }
    return orderKeys(result);
  },
});

/** Where a cursor continues for this issue at this revision. */
function readCursor(cursor: string, id: string, revision: string): Position {
  const state = decodeCursor(cursor, 'show') as Record<string, unknown> | null;
  if (state && typeof state === 'object' && state.i === id) {
    if (typeof state.b === 'number' && Number.isInteger(state.b) && state.b >= 0) {
      if (state.r !== revision) {
        throw invalid({ cursor: 'is stale: the issue changed since that show; show it again from the start' });
      }
      return { body: state.b };
    }
    if (typeof state.c === 'string' || state.c === null) return { before: state.c };
  }
  throw invalid({ cursor: `is not a cursor from a show of ${id}` });
}

/** The result with `body` and `body_from` right before `revision`, where readers expect them. */
function orderKeys(result: ShowResult): ShowResult {
  const ordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'body' || key === 'body_from') continue;
    if (key === 'revision') {
      if (result.body !== undefined) ordered.body = result.body;
      if (result.body_from !== undefined) ordered.body_from = result.body_from;
    }
    ordered[key] = value;
  }
  return ordered as unknown as ShowResult;
}
