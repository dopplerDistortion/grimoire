// Attempts (spec §8 claim, release, close; §19): exclusive claims and the
// attempt lifecycle, as compare-and-set writes on the tracker.
import { GrimoireError, invalid } from '../errors';
import type { SecretScanner } from '../scanner';
import {
  ATTEMPT_PATTERN,
  bareId,
  parseWriteRef,
  type AttemptEnding,
  type AttemptRecord,
  type IssueRecord,
  type TrackerDraft,
  type TrackerView,
  type Verdict,
} from '../tracker';
import { referencedFacts, type ReferencedCommit } from '../capture/commit-facts';
import { afterSeal, cutForEnding, sealCaptures } from './capture';
import { openingSkillFacts } from './skills';
import { humanSurface, type Actor } from './context';
import { fieldConflict, namesIssue, openAttemptsOf, stateConflict, type OpenAttemptFacts } from './derive';
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

/**
 * Refuses to open an attempt on an issue that isn't claimable, in the order a
 * claim checks (spec §9): ALREADY_CLAIMED, STATE_CONFLICT, NOT_OPEN, then
 * HAS_OPEN_CHILDREN. `person` is the caller's, for `held_by_you`.
 */
export function checkClaimable(view: TrackerView, id: string, person: string): void {
  const issue = view.issue(id)!;
  const open = openAttemptsOf(view, id);
  if (open.length > 0) throw alreadyClaimed(id, open, person);
  const conflict = fieldConflict(view, id);
  if (conflict) throw stateConflict(id, conflict, 'it can’t be claimed');
  if (issue.status !== 'open') throw new GrimoireError('NOT_OPEN', `${id} is ${issue.status}, not open`);
  const openChildren = view.issues().filter((kid) => kid.parent !== null && namesIssue(view, kid.parent, id) && kid.status === 'open');
  if (openChildren.length > 0) {
    throw new GrimoireError(
      'HAS_OPEN_CHILDREN',
      `${id} has open sub-issues (${openChildren.map((kid) => kid.id).join(', ')}); claim the leaf you will work`,
    );
  }
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
    'Claim an open, unassigned grimoire issue to work it yourself: opens an attempt and returns its handle. Claim only the leaf you are about to work; ALREADY_CLAIMED means move on.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
  issueWrite: true,
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    idempotency_key: s.optional(s.string(oneLine)),
  }),
  async run(input, { ctx, tracker, actor, scanner }): Promise<ClaimResult> {
    const author = writer(ctx);
    const ref = parseWriteRef(input.id, 'id');
    const key = input.idempotency_key;
    const spec = { op: 'claim', author, actor, ...(key ? { idempotency: { key, fingerprint: { issue: ref } } } : {}) };
    // What the claiming checkout offered, read once before the round: files on disk never wait inside it.
    const skills = await openingSkillFacts(await tracker.read(), scanner, ctx.repo.root);
    const write = await tracker.transact(spec, (draft) => {
      const id = draft.resolveWrite(ref, 'id');
      checkClaimable(draft, id, author.email);
      const attempt = draft.openAttempt(id, {
        assignee: author.email,
        actor: recordedActor(author.email, actor),
        opened: 'claim',
        wiki_exposed: actor.chore_exposure !== undefined,
        ...skills,
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

/** What ending an attempt will do, checked without writing; or the replay of an ending already made. */
type EndPlan =
  | { readonly replay: EndResult }
  | {
      readonly replay?: undefined;
      readonly id: string;
      /** The attempt named; undefined for an unclaimed close, whose instant attempt the commit opens. */
      readonly record: AttemptRecord | undefined;
      /** Undefined only for your own open handle on an issue deleted elsewhere. */
      readonly issue: IssueRecord | undefined;
      readonly parentEdit: { record: IssueRecord; body: string; noops: readonly number[] } | null;
    };

/**
 * Validates an ending against `view` without writing (spec §14, step 1): the
 * handle, NOT_ASSIGNEE, DEBRIEF_REQUIRED and the `parent_patch`
 * preconditions. Run once before the cut and again inside the round.
 */
function planEnd(view: TrackerView, request: EndRequest, me: string, ctx: OpEnv['ctx'], actor: Actor): EndPlan {
  const { ending } = request;
  let id = request.id;
  let record: AttemptRecord | undefined;
  if (request.attempt !== undefined) {
    record = view.attempt(request.attempt);
    // A fold that kept an id collision apart moved the attempt to `<id>~<hash4>`: the bare id it was claimed by still names it.
    if (record && bareId(id) === id && bareId(record.issue) === id) id = record.issue;
    if (!record || record.issue !== id) {
      view.resolveWrite(id, 'id');
      throw notAssignee(`${request.attempt} is not an attempt on ${id}`);
    }
    if (record.end) {
      if (replays(record, ending, me)) return { replay: replayOf(record) };
      const yours = openAttemptsOf(view, id).find((open) => open.assignee === me);
      if (yours) throw attemptOpen(id, yours, me);
      throw notAssignee(`${record.id} already ended (${record.end.ended}); nobody holds it now`);
    }
    // Only a human surface may release another person's attempt as abandoned (spec §7, §8).
    const othersAbandoned = ending === 'release-abandoned' && humanSurface(ctx);
    if (record.start.assignee !== me && !othersAbandoned) {
      throw notAssignee(
        ending === 'release-abandoned'
          ? `${record.id} is held by ${record.start.assignee}; only a human can release another person’s attempt as abandoned, from the dashboard or a terminal`
          : `${record.id} is held by ${record.start.assignee}, not by you`,
      );
    }
  } else {
    id = view.resolveWrite(id, 'id');
    const open = openAttemptsOf(view, id);
    if (open.length > 0) throw attemptOpen(id, open.find((a) => a.assignee === me) ?? open[0]!, me);
    const status = view.issue(id)!.status;
    if (status !== 'open') {
      const latest = view.attempts(id).at(-1);
      if (latest && latest.start.opened === 'unclaimed-close' && replays(latest, ending, me)) {
        return { replay: replayOf(latest) };
      }
      throw new GrimoireError('NOT_OPEN', `${id} is ${status}, not open`);
    }
  }
  const issue = view.issue(id);
  if (actor.kind === 'agent' && (ending === 'done' || ending === 'release') && !request.debrief) {
    throw new GrimoireError(
      'DEBRIEF_REQUIRED',
      `${ending === 'done' ? 'closing as done' : 'releasing'} needs a debrief: {asked, tried, failed, worked, next}`,
    );
  }
  let parentEdit: { record: IssueRecord; body: string; noops: readonly number[] } | null = null;
  if (request.parentPatch && issue) {
    if (issue.parent === null) throw invalid({ parent_patch: `${id} has no parent` });
    const parent = view.issue(issue.parent) ?? view.issue(view.resolveWrite(issue.parent, 'parent_patch'))!;
    const patched = applyPatch(parent.body, request.parentPatch);
    parentEdit = { record: parent, body: patched.body, noops: patched.noops };
  }
  return { id, record, issue, parentEdit };
}

/**
 * Ends an attempt (spec §14 Cut at attempt end; §8, Close order): validates
 * without writing, cuts the bound contexts, then commits once: `parent_patch`,
 * the comment and the debrief, the session records, the close, the seal and
 * the outcome. A replay never cuts again. Ending your own open handle always
 * works; on an issue that is no longer open it seals as `superseded`.
 */
async function endAttempt(request: EndRequest, env: OpEnv): Promise<EndResult> {
  const { ctx, tracker, actor, scanner } = env;
  const author = writer(ctx);
  const me = author.email;
  const by = recordedActor(me, actor);
  const { ending } = request;
  const binds = ending !== 'release-abandoned';
  checkDebrief(request.debrief);
  const view = await tracker.read();
  const checked = planEnd(view, request, me, ctx, actor);
  if (checked.replay) return checked.replay;
  const capture = await cutForEnding(env, view, { issue: checked.id, attempt: checked.record ?? null, op: request.op, binds });
  // An unclaimed close opens its instant attempt in the ending commit: what this checkout offered, read before the round.
  const opening = checked.record ? {} : await openingSkillFacts(view, scanner, ctx.repo.root);
  let sealed: { handle: string; keys: string[] } | null = null;
  const write = await tracker.transact({ op: request.op, author, actor }, async (draft) => {
    sealed = null;
    const plan = planEnd(draft, request, me, ctx, actor);
    if (plan.replay) return { result: plan.replay };
    const { id, issue, parentEdit } = plan;
    const now = draft.now.toISOString();
    const record =
      plan.record ??
      draft.openAttempt(id, {
        assignee: me,
        actor: by,
        opened: 'unclaimed-close',
        wiki_exposed: actor.chore_exposure !== undefined,
        ...opening,
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
    // The round names the attempt the cut was made for (another one open now would be ATTEMPT_OPEN, or NOT_ASSIGNEE).
    sealed = { handle, keys: await sealCaptures(draft, handle, capture) };

    const superseded = !issue || issue.status !== 'open';
    const ended = superseded ? 'superseded' : ending;
    const closes = issue !== undefined && !superseded && (ending === 'done' || ending === 'canceled');
    if (closes) draft.putIssue({ ...issue, status: ending, updated_at: now });
    const verdict = sealOpenAttempt(draft, handle, {
      ended,
      by,
      binds,
      debrief,
      fields: closes ? ['status'] : [],
      ...(superseded ? { requested: ending } : {}),
      referenced: capture.referenced,
    });
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
  const done = sealed as { handle: string; keys: string[] } | null;
  if (done) await afterSeal(env, done.handle, capture, done.keys, write.commit);
  return write.result;
}

/** How an attempt is sealed. */
export interface Seal {
  readonly ended: AttemptEnding;
  /** The recorded actor ending it. */
  readonly by: Readonly<Record<string, unknown>>;
  /** Whether the ending write binds (it names the handle as the worker's own write). */
  readonly binds: boolean;
  readonly debrief?: string | null;
  /** Issue fields this ending changes (a close's status). */
  readonly fields?: readonly string[];
  /** For a superseded seal: the ending the call asked for. */
  readonly requested?: string;
  /** The referenced commits the ending found (spec §14 Facts: Commits), for `end.md`. */
  readonly referenced?: readonly ReferencedCommit[];
}

/**
 * Seals an open attempt and records grimoire's verdict for how it ended
 * (spec §19, Outcomes): `end.md` with the worker kind, the wiki-exposed OR and
 * the fields changed during the attempt, then the outcome. Returns the verdict.
 */
export function sealOpenAttempt(draft: TrackerDraft, handle: string, seal: Seal): Verdict {
  const sealing = draft.attempt(handle)!;
  const fieldChanges = new Set(
    sealing.activity.flatMap((entry) => (entry.detail?.kind === 'update' ? entry.detail.fields : [])),
  );
  for (const field of seal.fields ?? []) fieldChanges.add(field);
  const binding = [...bindingActors(sealing), ...(seal.binds ? [seal.by] : [])];
  const assignee = sealing.start.assignee;
  const workerKind = binding.some((a) => a.person === assignee && a.kind === 'agent') ? 'agent' : 'human';
  draft.sealAttempt(handle, {
    ended: seal.ended,
    ended_by: seal.by,
    debrief: seal.debrief ?? null,
    worker_kind: workerKind,
    wiki_exposed: sealing.start.wiki_exposed || binding.some((a) => a.chore_exposure !== undefined),
    field_changes: [...fieldChanges].sort(),
    commits: referencedFacts(seal.referenced ?? [], workerKind),
    ...(seal.requested !== undefined ? { requested: seal.requested } : {}),
  });
  const verdict = VERDICT[seal.ended]!;
  draft.putOutcome(handle, { verdict, reason: seal.ended, set_by: 'grimoire' });
  return verdict;
}

export const close = define({
  name: 'close',
  description:
    'Close a grimoire issue as done or canceled, ending your attempt: name its handle as `attempt` (without one, the issue must be open and unclaimed). Agents closing as done give a debrief. parent_patch (anchored edits to the parent’s body), comment and close land in one commit. Replay-safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'attempt-and-reason',
  issueWrite: true,
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
    'Release your claim on a grimoire issue, giving up your attempt without closing the issue: its outcome is fail. Agents give a debrief. `abandoned: true` gives up an attempt of your own person that a crashed session or a stale claim left: no debrief, and it binds nothing (another person’s attempt: human-only). Replay-safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'attempt-and-reason',
  issueWrite: true,
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    attempt: handleInput,
    debrief: s.optional(debriefInput),
    abandoned: s.optional(s.boolean('true: give up your own person’s attempt that a crashed session or stale claim left (no debrief; another person’s: human-only)')),
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
