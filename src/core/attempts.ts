// Attempts (spec §8 claim, release, close; §19): exclusive claims and the
// attempt lifecycle, as compare-and-set writes on the tracker.
import { GrimoireError, invalid } from '../errors';
import type { SecretScanner } from '../scanner';
import { ATTEMPT_PATTERN, parseWriteRef, type AttemptRecord, type IssueRecord, type TrackerView, type Verdict } from '../tracker';
import type { Actor } from './context';
import { fieldConflict, openAttemptsOf, stateConflict, type OpenAttemptFacts } from './derive';
import { define, oneLine, writer, type OpEnv } from './op';
import { applyPatch, patchOps, type PatchOp } from './patch';
import { s } from './schema';
import type { Noop } from './update';

/** The actor a record stores: the person, plus the agent facts when an agent wrote it. */
export function recordedActor(person: string, actor: Actor): Record<string, unknown> {
  return { person, ...actor };
}

/** One open attempt as an error's details or a read shows it. */
export interface OpenAttempt {
  attempt: string;
  assignee: string;
  since: string;
  last_activity_at: string;
  clients_seen: string[];
  /** Held by the caller's own person (another session of yours, perhaps). */
  held_by_you: boolean;
}

export function shownOpenAttempt(facts: OpenAttemptFacts, person: string | null): OpenAttempt {
  return {
    attempt: facts.record.id,
    assignee: facts.assignee,
    since: facts.since,
    last_activity_at: facts.lastActivityAt,
    clients_seen: [...facts.clientsSeen],
    held_by_you: facts.assignee === person,
  };
}

/** An open attempt as `show` and `list` show it: with its stale flag. */
export interface ListedOpenAttempt extends OpenAttempt {
  /** No activity since this machine's stale threshold (`dashboard.stale_after`). Display-only. */
  stale: boolean;
}

export function listedOpenAttempt(facts: OpenAttemptFacts, person: string | null, staleBefore: number): ListedOpenAttempt {
  return { ...shownOpenAttempt(facts, person), stale: Date.parse(facts.lastActivityAt) < staleBefore };
}

function alreadyClaimed(id: string, open: readonly OpenAttemptFacts[], person: string): GrimoireError {
  const holders = open.map((a) => `${a.assignee} (${a.record.id})`).join(', ');
  return new GrimoireError('ALREADY_CLAIMED', `${id} is already claimed by ${holders}; move on to another issue`, {
    open_attempts: open.map((a) => shownOpenAttempt(a, person)),
  });
}

export interface ClaimResult {
  id: string;
  /** The attempt handle: name it on update, comment, close and release. */
  attempt: string;
  since: string;
  /** True when an idempotency key replayed an earlier claim. */
  replayed?: true;
}

export const claim = define({
  name: 'claim',
  description:
    'Claim an open, unassigned issue to work it yourself: opens an attempt and returns its handle. Claim only the leaf you are about to work; ALREADY_CLAIMED means move on.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    idempotency_key: s.optional(s.string(oneLine)),
  }),
  async run(input, { ctx, tracker, actor }): Promise<ClaimResult> {
    const author = writer(ctx);
    const id = parseWriteRef(input.id, 'id');
    const key = input.idempotency_key;
    const spec = { op: 'claim', author, actor, ...(key ? { idempotency: { key, fingerprint: { issue: id } } } : {}) };
    const write = await tracker.transact(spec, (draft) => {
      draft.resolveWrite(id, 'id');
      const issue = draft.issue(id)!;
      const open = openAttemptsOf(draft, id);
      if (open.length > 0) throw alreadyClaimed(id, open, author.email);
      const conflict = fieldConflict(draft, id);
      if (conflict) throw stateConflict(id, conflict, 'it can’t be claimed');
      if (issue.status !== 'open') throw new GrimoireError('NOT_OPEN', `${id} is ${issue.status}, not open`);
      const openChildren = draft.issues().filter((kid) => kid.parent === id && kid.status === 'open');
      if (openChildren.length > 0) {
        throw new GrimoireError(
          'HAS_OPEN_CHILDREN',
          `${id} has open sub-issues (${openChildren.map((kid) => kid.id).join(', ')}); claim the leaf you will work`,
        );
      }
      const attempt = draft.openAttempt(id, {
        assignee: author.email,
        actor: recordedActor(author.email, actor),
        opened: 'claim',
        wiki_exposed: actor.chore_exposure !== undefined,
      });
      return { result: { id, attempt: attempt.id, since: attempt.start.at }, issue: id, attempt: attempt.id };
    });
    return write.replayed ? { ...write.result, replayed: true } : write.result;
  },
});

// ---------------------------------------------------------------------------
// Ending an attempt: close and release.

/** The verdict each ending gives (spec §19, Outcomes). */
const VERDICT: Readonly<Record<string, Verdict>> = {
  done: 'pass',
  canceled: 'none',
  release: 'fail',
  'release-abandoned': 'fail',
  reassign: 'fail',
  superseded: 'none',
};

/** What an agent may end an attempt with. */
type Ending = 'done' | 'canceled' | 'release' | 'release-abandoned';

const DEBRIEF_FIELDS = ['asked', 'tried', 'failed', 'worked', 'next'] as const;
const DEBRIEF_HEADINGS: Readonly<Record<(typeof DEBRIEF_FIELDS)[number], string>> = {
  asked: 'Asked',
  tried: 'Tried',
  failed: 'Failed',
  worked: 'Worked',
  next: 'Next',
};
/** A debrief's five fields together hold at most this many characters (spec §8, Debriefs). */
export const DEBRIEF_LIMIT = 4_000;
/** What replaces a debrief field the secret scanner couldn't scan: unscanned text is never written. */
export const UNSCANNED_DEBRIEF_TEXT = '[dropped: the secret scanner could not run]';

const debriefField = (what: string) => s.string({ nonBlank: true, description: `${what}; "none" is fine` });
const debriefInput = s.object(
  {
    asked: debriefField('what you were asked to do'),
    tried: debriefField('what you tried'),
    failed: debriefField('what failed'),
    worked: debriefField('what worked'),
    next: debriefField('what the next worker should know'),
  },
  'your own short account of the attempt (at most 4,000 characters in total): report only what you saw',
);

type Debrief = NonNullable<ReturnType<typeof debriefInput.parse>>;

const handleInput = s.string({ ...oneLine, description: 'the attempt handle your claim returned (at-…)' });

/** The handle a write names, or INVALID when it isn't one. */
export function parseHandle(input: string, field = 'attempt'): string {
  const handle = input.trim().toLowerCase();
  if (!ATTEMPT_PATTERN.test(handle)) throw invalid({ [field]: `"${input}" is not an attempt handle (at- and 6 characters)` });
  return handle;
}

function checkDebrief(debrief: Debrief | undefined): void {
  if (!debrief) return;
  const total = DEBRIEF_FIELDS.reduce((sum, field) => sum + [...debrief[field]].length, 0);
  if (total > DEBRIEF_LIMIT) {
    throw invalid({ debrief: `holds ${total} characters; at most ${DEBRIEF_LIMIT.toLocaleString('en-US')} in total` });
  }
}

/** The debrief comment's body: each field under its heading, every secret replaced by its rule's marker. */
function renderDebrief(debrief: Debrief, scanner: SecretScanner): string {
  const scrub = (text: string) => {
    const redacted = scanner.redact(text);
    return redacted.status === 'scanned' ? redacted.text : UNSCANNED_DEBRIEF_TEXT;
  };
  return `${DEBRIEF_FIELDS.map((field) => `## ${DEBRIEF_HEADINGS[field]}\n${scrub(debrief[field]).trimEnd()}`).join('\n\n')}\n`;
}

export interface EndResult {
  id: string;
  attempt: string;
  /** How the attempt ended: done, canceled, release, release-abandoned or superseded. */
  ended: string;
  /** Its verdict: pass, fail or none. */
  outcome: string;
  /** `parent_patch` ops that changed nothing. */
  parent_noops?: Noop[];
  /** True when this call repeated an ending already made: nothing was written. */
  replayed?: true;
}

interface EndRequest {
  readonly op: 'close' | 'release';
  readonly id: string;
  readonly attempt?: string;
  readonly ending: Ending;
  readonly comment?: string;
  readonly debrief?: Debrief;
  readonly parentPatch?: readonly PatchOp[];
}

function notAssignee(message: string): GrimoireError {
  return new GrimoireError('NOT_ASSIGNEE', message);
}

/**
 * The attempt an `update` or `comment` names, checked inside the round: it
 * must be open on that issue and held by the caller's person, else NOT_ASSIGNEE.
 */
export function heldAttempt(view: TrackerView, id: string, handle: string, person: string): AttemptRecord {
  const record = view.attempt(handle);
  if (!record || record.issue !== id) throw notAssignee(`${handle} is not an attempt on ${id}`);
  if (record.end) throw notAssignee(`${handle} already ended (${record.end.ended}); nobody holds it now`);
  if (record.start.assignee !== person) throw notAssignee(`${handle} is held by ${record.start.assignee}, not by you`);
  return record;
}

function attemptOpen(id: string, open: OpenAttemptFacts, person: string): GrimoireError {
  const whose = open.assignee === person ? 'your open attempt' : `the open attempt ${open.assignee} holds`;
  return new GrimoireError('ATTEMPT_OPEN', `${id} has ${whose}, ${open.record.id}; name it as \`attempt\``, {
    attempt: open.record.id,
  });
}

/** Whether ending `record` with `ending` was already done by this person: the call replays. */
function replays(record: AttemptRecord, ending: Ending, person: string): boolean {
  const end = record.end;
  if (!end) return false;
  const same = end.ended === ending || (end.ended === 'superseded' && end.requested === ending);
  return same && (record.start.assignee === person || end.ended_by.person === person);
}

function replayOf(record: AttemptRecord): EndResult {
  const ended = record.end!.ended;
  return {
    id: record.issue,
    attempt: record.id,
    ended,
    outcome: record.outcome?.verdict ?? VERDICT[ended] ?? 'none',
    replayed: true,
  };
}

/** The actors of the attempt's binding writes: its opening, and every write that named its handle. */
function bindingActors(record: AttemptRecord): Readonly<Record<string, unknown>>[] {
  return [
    record.start.actor,
    ...record.activity.flatMap((entry) => (entry.detail?.attempt === record.id ? [entry.detail.actor] : [])),
  ];
}

/**
 * Ends an attempt in one commit: `parent_patch`, then the comment and the
 * debrief, then the close, the seal and the outcome (spec §8, Close order).
 * Ending your own open handle always works; on an issue that is no longer
 * open it seals as `superseded`.
 */
async function endAttempt(request: EndRequest, { ctx, tracker, actor, scanner }: OpEnv): Promise<EndResult> {
  const author = writer(ctx);
  const me = author.email;
  const by = recordedActor(me, actor);
  const { id, ending } = request;
  const binds = ending !== 'release-abandoned';
  checkDebrief(request.debrief);
  const write = await tracker.transact({ op: request.op, author, actor }, (draft) => {
    let record: AttemptRecord | undefined;
    if (request.attempt !== undefined) {
      record = draft.attempt(request.attempt);
      if (!record || record.issue !== id) {
        draft.resolveWrite(id, 'id');
        throw notAssignee(`${request.attempt} is not an attempt on ${id}`);
      }
      if (record.end) {
        if (replays(record, ending, me)) return { result: replayOf(record) };
        const yours = openAttemptsOf(draft, id).find((open) => open.assignee === me);
        if (yours) throw attemptOpen(id, yours, me);
        throw notAssignee(`${record.id} already ended (${record.end.ended}); nobody holds it now`);
      }
      const othersAbandoned = ending === 'release-abandoned' && actor.kind === 'human';
      if (record.start.assignee !== me && !othersAbandoned) {
        throw notAssignee(
          ending === 'release-abandoned'
            ? `${record.id} is held by ${record.start.assignee}; only a human can release another person’s attempt as abandoned, from the dashboard or a terminal`
            : `${record.id} is held by ${record.start.assignee}, not by you`,
        );
      }
    } else {
      draft.resolveWrite(id, 'id');
      const open = openAttemptsOf(draft, id);
      if (open.length > 0) throw attemptOpen(id, open.find((a) => a.assignee === me) ?? open[0]!, me);
      const status = draft.issue(id)!.status;
      if (status !== 'open') {
        const latest = draft.attempts(id).at(-1);
        if (latest && latest.start.opened === 'unclaimed-close' && replays(latest, ending, me)) {
          return { result: replayOf(latest) };
        }
        throw new GrimoireError('NOT_OPEN', `${id} is ${status}, not open`);
      }
    }
    // Undefined only for your own open handle on an issue deleted elsewhere.
    const issue = draft.issue(id);
    if (actor.kind === 'agent' && (ending === 'done' || ending === 'release') && !request.debrief) {
      throw new GrimoireError(
        'DEBRIEF_REQUIRED',
        `${ending === 'done' ? 'closing as done' : 'releasing'} needs a debrief: {asked, tried, failed, worked, next}`,
      );
    }
    let parentEdit: { record: IssueRecord; body: string; noops: readonly number[] } | null = null;
    if (request.parentPatch && issue) {
      if (issue.parent === null) throw invalid({ parent_patch: `${id} has no parent` });
      const parent = draft.issue(issue.parent);
      if (!parent) draft.resolveWrite(issue.parent, 'parent_patch');
      const patched = applyPatch(parent!.body, request.parentPatch);
      parentEdit = { record: parent!, body: patched.body, noops: patched.noops };
    }

    const now = draft.now.toISOString();
    record ??= draft.openAttempt(id, {
      assignee: me,
      actor: by,
      opened: 'unclaimed-close',
      wiki_exposed: actor.chore_exposure !== undefined,
    });
    const handle = record.id;
    if (parentEdit && parentEdit.body !== parentEdit.record.body) {
      draft.putIssue({ ...parentEdit.record, body: parentEdit.body, updated_at: now });
      draft.addActivity(parentEdit.record.id, { actor: by, fields: ['body'] });
    }
    const named = binds ? { attempt: handle } : {};
    if (request.comment !== undefined) draft.addComment(id, { actor: by, kind: 'comment', body: request.comment, ...named });
    const debrief = request.debrief
      ? draft.addComment(id, { actor: by, kind: 'debrief', body: renderDebrief(request.debrief, scanner), ...named }).id
      : null;

    const superseded = !issue || issue.status !== 'open';
    const ended = superseded ? 'superseded' : ending;
    const sealing = draft.attempt(handle)!;
    const fieldChanges = new Set(
      sealing.activity.flatMap((entry) => (entry.detail?.kind === 'update' ? entry.detail.fields : [])),
    );
    if (issue && !superseded && (ending === 'done' || ending === 'canceled')) {
      draft.putIssue({ ...issue, status: ending, updated_at: now });
      fieldChanges.add('status');
    }
    const binding = [...bindingActors(sealing), ...(binds ? [by] : [])];
    const assignee = sealing.start.assignee;
    draft.sealAttempt(handle, {
      ended,
      ended_by: by,
      debrief,
      worker_kind: binding.some((a) => a.person === assignee && a.kind === 'agent') ? 'agent' : 'human',
      wiki_exposed: sealing.start.wiki_exposed || binding.some((a) => a.chore_exposure !== undefined),
      field_changes: [...fieldChanges].sort(),
      ...(superseded ? { requested: ending } : {}),
    });
    const verdict = VERDICT[ended]!;
    draft.putOutcome(handle, { verdict, reason: ended, set_by: 'grimoire' });
    const parentNoops = issue
      ? (parentEdit?.noops ?? []).map((op) => ({
          field: `parent_patch[${op}]`,
          reason: request.parentPatch![op]!.op === 'replace' ? 'unchanged' : 'text already present',
        }))
      : (request.parentPatch ?? []).map((_op, i) => ({ field: `parent_patch[${i}]`, reason: `${id} was deleted` }));
    const result: EndResult = {
      id,
      attempt: handle,
      ended,
      outcome: verdict,
      ...(parentNoops.length > 0 ? { parent_noops: parentNoops } : {}),
    };
    return { result, issue: id, ...named };
  });
  return write.result;
}

export const close = define({
  name: 'close',
  description:
    'Close an issue as done or canceled, ending your attempt: name its handle as `attempt` (without one, the issue must be open and unclaimed). Agents closing as done give a debrief. parent_patch (anchored edits to the parent’s body), comment and close land in one commit. Replay-safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'attempt-and-reason',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    reason: s.literal(['done', 'canceled']),
    attempt: s.optional(handleInput),
    comment: s.optional(s.string({ nonBlank: true, description: 'a comment posted with the close' })),
    debrief: s.optional(debriefInput),
    parent_patch: s.optional(patchOps),
  }),
  async run(input, env): Promise<EndResult> {
    return endAttempt(
      {
        op: 'close',
        id: parseWriteRef(input.id, 'id'),
        ending: input.reason,
        ...(input.attempt !== undefined ? { attempt: parseHandle(input.attempt) } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.debrief !== undefined ? { debrief: input.debrief } : {}),
        ...(input.parent_patch !== undefined ? { parentPatch: input.parent_patch } : {}),
      },
      env,
    );
  },
});

export const release = define({
  name: 'release',
  description:
    'Give up your attempt without closing the issue: its outcome is fail. Agents give a debrief. `abandoned: true` recovers a dead claim of your own person: no debrief, and it binds nothing. Replay-safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'attempt-and-reason',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    attempt: handleInput,
    debrief: s.optional(debriefInput),
    abandoned: s.optional(s.boolean('true: recover a dead claim (no debrief)')),
    comment: s.optional(s.string({ nonBlank: true, description: 'a comment posted with the release' })),
  }),
  async run(input, env): Promise<EndResult> {
    if (input.abandoned && input.debrief !== undefined) {
      throw invalid({ debrief: 'an abandoned release takes no debrief' });
    }
    return endAttempt(
      {
        op: 'release',
        id: parseWriteRef(input.id, 'id'),
        attempt: parseHandle(input.attempt),
        ending: input.abandoned ? 'release-abandoned' : 'release',
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.debrief !== undefined ? { debrief: input.debrief } : {}),
      },
      env,
    );
  },
});
