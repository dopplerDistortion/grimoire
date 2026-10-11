// `show` (spec §8): one issue with its derived facts, its relations' states
// and its newest comments, cut under the result budget with a cursor that
// continues a long body, then pages to older comments.
import { invalid } from '../errors';
import { issueRevision, type AttemptRecord, type IssueComment, type IssueLink, type TrackerView } from '../tracker';
import { decodeCursor, encodeCursor, jsonBytes, longestPrefix, RESULT_BUDGET } from './budget';
import { listedOpenAttempt, type ListedOpenAttempt } from './attempts';
import { derivations, relatedIssue, type IssueConflict, type RelationState } from './derive';
import { dashboardPort, localLink } from './local-link';
import { define, oneLine } from './op';
import { staleCutoff } from './stale';
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
  /** The person holding the open attempt, or null. */
  assignee: string | null;
  /** Open attempts (two only after a cross-clone fold). */
  open_attempts: ListedOpenAttempt[];
  /** Ended attempts with their outcomes, oldest first (the oldest are left out when the ~24 KB cut needs room). */
  past_attempts: PastAttempt[];
  /** The assignee of the attempt that ended last, or null. */
  last_assignee: string | null;
  /** Claimable: open, unclaimed, unconflicted, unblocked and with no open sub-issue. */
  ready: boolean;
  /** The fold conflict, or null: `{fields, theirs, base}`; a conflicted issue isn't ready. */
  conflict: IssueConflict | null;
  comment_count: number;
  /** A page of comments, oldest first: the newest ones (or those before the cursor). */
  comments: ShownComment[];
  /** Continues the body, then pages to older comments; null when nothing is left. */
  cursor: string | null;
  /** True when the ~24 KB cut left something out of this result. */
  truncated?: true;
}

/** An ended attempt, as `show` lists it. */
export interface PastAttempt {
  attempt: string;
  assignee: string;
  /** How it opened: claim, assign or unclaimed-close. */
  opened: string;
  since: string;
  /** How it ended: done, canceled, release, release-abandoned, reassign or superseded. */
  ended: string;
  ended_at: string;
  /** The person who ended it. */
  ended_by: string;
  /** `agent` when an agent of the assignee made any of its binding writes, else `human`. */
  worker_kind: string;
  /** The latest verdict, or null when none was recorded. */
  outcome: { verdict: string; reason: string; set_by: string; at: string } | null;
  /** The id of its debrief comment, or null. */
  debrief: string | null;
  /**
   * When two clones ended it differently: the endings the fold set aside
   * (`theirs.end`, oldest first) beside the one that stands; else null.
   */
  conflict: AttemptConflict | null;
}

/** An attempt sealed twice across clones. */
export interface AttemptConflict {
  fields: ['end'];
  theirs: { end: { ended: string; ended_at: string; ended_by: string }[] };
  base: { end: null };
}

function pastAttempt(record: AttemptRecord): PastAttempt {
  const end = record.end!;
  const endedBy = end.ended_by.person;
  return {
    attempt: record.id,
    assignee: record.start.assignee,
    opened: record.start.opened,
    since: record.start.at,
    ended: end.ended,
    ended_at: end.at,
    ended_by: typeof endedBy === 'string' ? endedBy : '',
    worker_kind: end.worker_kind,
    outcome: record.outcome
      ? { verdict: record.outcome.verdict, reason: record.outcome.reason, set_by: record.outcome.set_by, at: record.outcome.at }
      : null,
    debrief: end.debrief,
    conflict:
      record.setAside.length === 0
        ? null
        : {
            fields: ['end'],
            theirs: {
              end: record.setAside.map((other) => ({
                ended: other.ended,
                ended_at: other.at,
                ended_by: typeof other.ended_by.person === 'string' ? other.ended_by.person : '',
              })),
            },
            base: { end: null },
          },
  };
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
  return { id, title: relatedIssue(view, id)?.title ?? null, status: state };
}

/** The bytes a string adds to a JSON document (its quoted, escaped form). */
const stringBytes = (text: string) => jsonBytes(text) - 2;

export const show = define({
  name: 'show',
  description:
    'Show one grimoire issue by ref: a full id, a unique prefix of 3+ characters, or a link. Returns its fields, body, revision, sub-issues and blockers with their state, and the newest comments; pass back `cursor` for the rest.',
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
  async run(input, { ctx, tracker }): Promise<ShowResult> {
    const view = await tracker.read();
    const id = view.resolveRead(input.ref, 'ref');
    const record = view.issue(id)!;
    const revision = issueRevision(record);
    const position = input.cursor === undefined ? { body: 0 } : readCursor(input.cursor, id, revision);
    const staleBefore = await staleCutoff(tracker.location.commonDir, tracker.now());
    const derived = derivations(view, staleBefore);
    const facts = derived.of(id);
    const entries = view.comments(id);
    const ended = view.attempts(id).filter((a) => a.end !== null);
    const lastEnded = ended.reduce<AttemptRecord | undefined>(
      (last, a) => (!last || a.end!.at > last.end!.at || (a.end!.at === last.end!.at && a.id > last.id) ? a : last),
      undefined,
    );
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
      assignee: facts.assignees[0] ?? null,
      open_attempts: facts.openAttempts.map((a) => listedOpenAttempt(a, ctx.person.email, staleBefore)),
      past_attempts: ended.map(pastAttempt),
      last_assignee: lastEnded?.start.assignee ?? null,
      ready: facts.ready,
      conflict: facts.conflict,
      comment_count: entries.length,
      comments: [],
      cursor: null,
    };
    const cursorRoom = encodeCursor('show', { i: id, r: revision, b: Number.MAX_SAFE_INTEGER }).length + 2;
    const fixed = () => jsonBytes({ ...result, truncated: true }) + cursorRoom;
    // Only a vast number of relations can fill the budget on their own; keep the first ones.
    while (fixed() > RESULT_BUDGET && result.past_attempts.length > 0) {
      result.past_attempts.shift();
      result.truncated = true;
    }
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
