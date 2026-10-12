// Human-only issue operations (spec §7, §3 Delete, §19): assign, reassign,
// reopen, delete and outcome overrides. They are never MCP tools; the core's
// surface gate admits them only from the dashboard and from a person's own
// terminal (checkSurface in op.ts).
import { GrimoireError, invalid } from '../errors';
import { parseWriteRef, type AttemptRecord, type IssueRecord, type TrackerDraft, type TrackerView } from '../tracker';
import { checkClaimable, parseHandle, recordedActor, sealOpenAttempt } from './attempts';
import { afterSeal, cutDeadline, cutForEnding, sealCaptures, type EndingCapture } from './capture';
import { fieldConflict, issueConflict, namesIssue, openAttemptsOf, relatedIssue, stateConflict } from './derive';
import { define, oneLine, writer } from './op';
import { s } from './schema';

const idInput = s.string({ ...oneLine, description: 'the issue’s full id' });
const personInput = s.string({ ...oneLine, description: 'the person’s git email (user.email)' });

/** A person's git identity as an assignee: an email, kept as written (trimmed). */
function parseAssignee(input: string): string {
  const email = input.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid({ assignee: `"${input}" is not an email; an assignee is a person’s git user.email` });
  return email;
}

export interface AssignResult {
  id: string;
  /** The attempt opened on the assignee's behalf: their agents name this handle. */
  attempt: string;
  assignee: string;
  since: string;
}

export const assign = define({
  name: 'assign',
  description:
    'Assign an open, unclaimed issue to a person: opens an attempt on their behalf, which their agents then work under. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput, assignee: personInput }),
  async run(input, { ctx, tracker, actor }): Promise<AssignResult> {
    const author = writer(ctx);
    const ref = parseWriteRef(input.id, 'id');
    const assignee = parseAssignee(input.assignee);
    const write = await tracker.transact({ op: 'assign', author, actor }, (draft) => {
      const id = draft.resolveWrite(ref, 'id');
      checkClaimable(draft, id, author.email);
      const attempt = draft.openAttempt(id, {
        assignee,
        actor: recordedActor(author.email, actor),
        opened: 'assign',
        wiki_exposed: false,
      });
      return { result: { id, attempt: attempt.id, assignee, since: attempt.start.at }, issue: id };
    });
    return write.result;
  },
});

export interface ReassignResult extends AssignResult {
  /** The attempt the reassign ended (outcome fail). */
  ended: string;
}

export const reassign = define({
  name: 'reassign',
  description:
    'Hand a claimed issue to another person: ends its open attempt as reassign (its outcome is fail) and opens one on their behalf, in one commit. With two open attempts (claims made on different clones), release one as abandoned first. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput, assignee: personInput }),
  async run(input, env): Promise<ReassignResult> {
    const { ctx, tracker, actor } = env;
    const author = writer(ctx);
    const by = recordedActor(author.email, actor);
    const ref = parseWriteRef(input.id, 'id');
    const assignee = parseAssignee(input.assignee);
    // Validate without writing, cut the bound contexts, then commit once (spec §14 Cut at attempt end).
    const view = await tracker.read();
    const checked = reassignable(view, ref);
    const capture = await cutForEnding(env, view, { issue: checked.id, attempt: checked.ending, op: 'reassign', binds: true });
    let sealed: { handle: string; keys: string[] } | null = null;
    const write = await tracker.transact({ op: 'reassign', author, actor }, async (draft) => {
      sealed = null;
      const { id, ending } = reassignable(draft, ref);
      if (ending.id === checked.ending.id) sealed = { handle: ending.id, keys: await sealCaptures(draft, ending.id, capture) };
      // An ending call binds (spec §14 Binding): the commit names the attempt it ended, never the one it opens.
      sealOpenAttempt(draft, ending.id, { ended: 'reassign', by, binds: true, ...(ending.id === checked.ending.id ? { referenced: capture.referenced } : {}) });
      checkClaimable(draft, id, author.email);
      const attempt = draft.openAttempt(id, { assignee, actor: by, opened: 'assign', wiki_exposed: false });
      return {
        result: { id, ended: ending.id, attempt: attempt.id, assignee, since: attempt.start.at },
        issue: id,
        attempt: ending.id,
      };
    });
    const done = sealed as { handle: string; keys: string[] } | null;
    if (done) await afterSeal(env, done.handle, capture, done.keys, write.commit);
    return write.result;
  },
});

/** The one open attempt a reassign ends; INVALID with none, STATE_CONFLICT with two (claims made on different clones). */
function reassignable(view: TrackerView, ref: string): { id: string; ending: AttemptRecord } {
  const id = view.resolveWrite(ref, 'id');
  const open = openAttemptsOf(view, id);
  if (open.length === 0) throw invalid({ id: `nobody holds ${id}; assign it instead` });
  if (open.length > 1) {
    // A reassign ends one attempt and opens another (spec §19); which claim yields is the human's call.
    const holders = open.map((attempt) => `${attempt.record.id} (${attempt.assignee})`).join(', ');
    throw new GrimoireError(
      'STATE_CONFLICT',
      `${id} has ${open.length} open attempts, claimed on different clones: ${holders}; release one as abandoned first, then reassign the other`,
      { conflict: issueConflict(view, id, open) },
    );
  }
  return { id, ending: open[0]!.record };
}

/** An issue a reopen makes wait again. */
export interface Reblocked {
  id: string;
  title: string;
  /** `blocked_by`: it lists the reopened issue as a blocker; `parent`: it is the reopened issue's parent. */
  via: 'blocked_by' | 'parent';
}

export interface ReopenResult {
  id: string;
  status: 'open';
  /** The reopen's comment. */
  comment: string;
  /** The closing attempt's outcome flip, or null when there was no pass to flip. */
  outcome: { attempt: string; from: 'pass'; to: 'fail' } | null;
  /** Open issues that wait for this one again. */
  reblocked: Reblocked[];
}

/** The attempt whose end closed the issue: the latest done or canceled one. */
function closingAttempt(draft: TrackerDraft, id: string): AttemptRecord | undefined {
  let closing: AttemptRecord | undefined;
  for (const attempt of draft.attempts(id)) {
    const end = attempt.end;
    if (!end || (end.ended !== 'done' && end.ended !== 'canceled')) continue;
    if (!closing || end.at > closing.end!.at || (end.at === closing.end!.at && attempt.id > closing.id)) closing = attempt;
  }
  return closing;
}

export const reopen = define({
  name: 'reopen',
  description:
    'Reopen a done or canceled issue, with a comment saying why: it becomes open and unassigned, the closing attempt’s pass flips to fail, and the result lists the issues that wait for it again. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    id: idInput,
    comment: s.string({ nonBlank: true, description: 'why it is reopened (required)' }),
  }),
  async run(input, env): Promise<ReopenResult> {
    const { ctx, tracker, actor } = env;
    const author = writer(ctx);
    const by = recordedActor(author.email, actor);
    const ref = parseWriteRef(input.id, 'id');
    // An attempt left open on the closed issue (after a fold) is superseded: it is cut first, like any ending (spec §14).
    // One ending, one budget: the attempts it supersedes share it.
    const view = await tracker.read();
    const checked = reopenable(view, ref);
    const captures = new Map<string, EndingCapture>();
    const deadline = cutDeadline(env);
    for (const open of openAttemptsOf(view, checked.id)) {
      captures.set(open.record.id, await cutForEnding(env, view, { issue: checked.id, attempt: open.record, op: 'reopen', binds: false, deadline }));
    }
    const sealed: { handle: string; keys: string[] }[] = [];
    const write = await tracker.transact({ op: 'reopen', author, actor }, async (draft) => {
      sealed.length = 0;
      const { id, issue } = reopenable(draft, ref);
      // Open and unassigned with no attempt.
      for (const open of openAttemptsOf(draft, id)) {
        const capture = captures.get(open.record.id);
        if (capture) sealed.push({ handle: open.record.id, keys: await sealCaptures(draft, open.record.id, capture) });
        sealOpenAttempt(draft, open.record.id, { ended: 'superseded', by, binds: false, ...(capture ? { referenced: capture.referenced } : {}) });
      }
      const closing = closingAttempt(draft, id);
      let outcome: ReopenResult['outcome'] = null;
      // A human's override beats every rule, the reopen flip included.
      if (closing?.outcome?.verdict === 'pass' && !closing.outcome.set_by.startsWith('human:')) {
        draft.putOutcome(closing.id, { verdict: 'fail', reason: 'reopened', set_by: 'grimoire' });
        outcome = { attempt: closing.id, from: 'pass', to: 'fail' };
      }
      draft.putIssue({ ...issue, status: 'open', updated_at: draft.now.toISOString() });
      const comment = draft.addComment(id, { actor: by, kind: 'comment', body: input.comment });
      const reblocked: Reblocked[] = draft
        .issues()
        .filter((other) => other.status === 'open' && other.blocked_by.some((blocker) => namesIssue(draft, blocker, id)))
        .map((other) => ({ id: other.id, title: other.title, via: 'blocked_by' }));
      const parent = issue.parent === null ? undefined : relatedIssue(draft, issue.parent);
      if (parent?.status === 'open') reblocked.push({ id: parent.id, title: parent.title, via: 'parent' });
      return { result: { id, status: 'open' as const, comment: comment.id, outcome, reblocked }, issue: id };
    });
    for (const { handle, keys } of sealed) await afterSeal(env, handle, captures.get(handle)!, keys, write.commit);
    return write.result;
  },
});

/** The closed issue a reopen opens again: INVALID when it is open, STATE_CONFLICT when a fold set its status aside (spec §4). */
function reopenable(view: TrackerView, ref: string): { id: string; issue: IssueRecord } {
  const id = view.resolveWrite(ref, 'id');
  const issue = view.issue(id)!;
  if (issue.status === 'open') throw invalid({ id: `${id} is already open` });
  // A reopen writes status: a status the fold set aside is resolved first (spec §4).
  const conflict = fieldConflict(view, id);
  if (conflict?.fields.includes('status')) throw stateConflict(id, conflict, 'it can’t be reopened');
  return { id, issue };
}

export interface DeleteResult {
  id: string;
  deleted: true;
  /** Every other issue whose `blocked_by` lost the id, with what it lists now. */
  blocked_by_stripped: { id: string; blocked_by: string[] }[];
}

/**
 * Deletes a live issue inside a write round (spec §3, Delete): refused with an
 * open attempt (ATTEMPT_OPEN) or any sub-issue, open or closed (INVALID).
 * Strips the id from every other issue's `blocked_by`, then removes the
 * issue's directory and writes its tombstone.
 */
export function removeIssue(draft: TrackerDraft, id: string, person: string, by: Readonly<Record<string, unknown>>): DeleteResult {
  const open = openAttemptsOf(draft, id);
  if (open.length > 0) {
    const holders = open.map((attempt) => `${attempt.record.id} (${attempt.assignee})`).join(', ');
    throw new GrimoireError('ATTEMPT_OPEN', `${id} has an open attempt, ${holders}; end it before deleting the issue`, {
      attempt: open[0]!.record.id,
    });
  }
  const children = draft.issues().filter((kid) => kid.parent !== null && namesIssue(draft, kid.parent, id));
  if (children.length > 0) {
    const kids = children.map((kid) => kid.id);
    throw new GrimoireError('INVALID', `${id} has sub-issues (${kids.join(', ')}); delete or re-parent them first`, {
      fields: { id: 'has sub-issues' },
      sub_issues: kids,
    });
  }
  const now = draft.now.toISOString();
  const stripped: DeleteResult['blocked_by_stripped'] = [];
  for (const other of draft.issues()) {
    // A bare id written before a collision, whose forwarding record maps it here, goes too.
    const blockedBy = other.blocked_by.filter((blocker) => !namesIssue(draft, blocker, id));
    if (other.id === id || blockedBy.length === other.blocked_by.length) continue;
    draft.putIssue({ ...other, blocked_by: blockedBy, updated_at: now });
    draft.addActivity(other.id, { actor: by, fields: ['blocked_by'] });
    stripped.push({ id: other.id, blocked_by: blockedBy });
  }
  draft.deleteIssue(id, person);
  return { id, deleted: true, blocked_by_stripped: stripped };
}

export const deleteIssue = define({
  name: 'delete',
  description:
    'Delete an issue in one commit: its record and comments go, a tombstone stays, and the id leaves every other issue’s blocked_by (listed). Refused with any sub-issue or an open attempt. Its attempts and outcomes stay, and the id is never reused. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput }),
  async run(input, { ctx, tracker, actor }): Promise<DeleteResult> {
    const author = writer(ctx);
    const by = recordedActor(author.email, actor);
    const ref = parseWriteRef(input.id, 'id');
    const write = await tracker.transact({ op: 'delete', author, actor }, (draft) => {
      const id = draft.resolveWrite(ref, 'id');
      return { result: removeIssue(draft, id, author.email, by), issue: id };
    });
    return write.result;
  },
});

export interface OutcomeSetResult {
  attempt: string;
  issue: string;
  verdict: string;
  reason: string;
  /** `human:<email>`. */
  set_by: string;
  at: string;
}

export const outcomeSet = define({
  name: 'outcome_set',
  description:
    'Override an ended attempt’s outcome (pass, fail or none), with a reason. A human’s verdict beats every rule, grimoire’s verdicts on other clones included. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    attempt: s.string({ ...oneLine, description: 'the attempt handle (at-…)' }),
    verdict: s.literal(['pass', 'fail', 'none']),
    reason: s.string({ nonBlank: true, description: 'why (required)' }),
  }),
  async run(input, { ctx, tracker, actor }): Promise<OutcomeSetResult> {
    const author = writer(ctx);
    const handle = parseHandle(input.attempt);
    const setBy = `human:${author.email}`;
    const write = await tracker.transact({ op: 'outcome-set', author, actor }, (draft) => {
      const record = draft.attempt(handle);
      if (!record) throw new GrimoireError('NOT_FOUND', `no attempt ${handle}`, { field: 'attempt', ref: handle });
      if (!record.end) throw invalid({ attempt: `${handle} is still open; an attempt gets its outcome when it ends` });
      draft.putOutcome(handle, { verdict: input.verdict, reason: input.reason, set_by: setBy });
      const result: OutcomeSetResult = {
        attempt: handle,
        issue: record.issue,
        verdict: input.verdict,
        reason: input.reason,
        set_by: setBy,
        at: draft.now.toISOString(),
      };
      return { result, issue: record.issue };
    });
    return write.result;
  },
});
