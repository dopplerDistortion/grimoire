// `resolve` (spec §3 Ids, §4 STATE_CONFLICT, §7): a human settles what a fold
// set aside. For a field conflict the human picks whose value stands, and the
// conflict records go, so the issue is claimable again. For a cross-clone id
// collision the human names the record that keeps the bare id: a forwarding
// record (`forwards/<id>.md`) maps it there, and the other record stays
// reachable as `<id>~<hash4>`.
import { GrimoireError, invalid } from '../errors';
import { collisionSides, issueRevision, parseWriteRef, type IssueRecord, type TrackerDraft } from '../tracker';
import { fieldConflict, findCycle, namedIn, OPEN_ATTEMPTS_FIELD } from './derive';
import { removeIssue } from './human-ops';
import { recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { s } from './schema';

type Side = 'kept' | 'theirs';

export interface ResolveResult {
  id: string;
  /** An id collision: the record the bare id now names. */
  forwarded_to?: string;
  /** An id collision: the other records, still reachable as `<id>~<hash4>`. */
  others?: string[];
  /** A field conflict: whose value now stands, field by field. */
  resolved?: { field: string; took: Side }[];
  /** True when taking the other clone's delete deleted the issue. */
  deleted?: true;
  /** After a delete: the issues whose `blocked_by` lost the id. */
  blocked_by_stripped?: { id: string; blocked_by: string[] }[];
}

const side = s.literal(['kept', 'theirs']);
const COLLISION_SUFFIX = /^~?([0-9a-f]{4})$/;

/** The record `keep` names among the sides of the collision of `id`: a full `<id>~<hash4>`, or just the hash4. */
function keptSide(id: string, keep: string, sides: readonly string[]): string {
  const hash = COLLISION_SUFFIX.exec(keep.trim().toLowerCase())?.[1];
  const named = hash !== undefined ? `${id}~${hash}` : parseWriteRef(keep, 'keep');
  if (!sides.includes(named)) throw invalid({ keep: `"${keep}" is not a record of the ${id} collision; name one of ${sides.join(', ')}` });
  return named;
}

/** The value a field takes from the fold's set-aside side, checked like a write of it. */
function theirValue(draft: TrackerDraft, record: IssueRecord, field: string, value: unknown): Partial<IssueRecord> {
  const cannot = (why: string) => invalid({ [`fields.${field}`]: `can’t take theirs: ${why}` });
  switch (field) {
    case 'title':
      if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) throw cannot('it isn’t a one-line title');
      return { title: value };
    case 'status':
      if (value !== 'open' && value !== 'done' && value !== 'canceled') throw cannot('it isn’t a status');
      return { status: value };
    case 'body':
      if (typeof value !== 'string') throw cannot('it isn’t text');
      return { body: value };
    case 'parent': {
      if (value === null) return { parent: null };
      if (typeof value !== 'string') throw cannot('it isn’t an issue id');
      const parent = draft.resolveWrite(value, `fields.${field}`);
      const next = { ...record, parent };
      const cycle = findCycle(
        draft.issues().map((issue) => (issue.id === record.id ? next : issue)),
        record.id,
        namedIn(draft),
      );
      if (cycle) throw new GrimoireError('CYCLE', `that would make a cycle (each waits for the next): ${cycle.join(' → ')}`, { path: cycle });
      return { parent };
    }
    default:
      throw cannot('this release doesn’t know the field');
  }
}

export const resolve = define({
  name: 'resolve',
  description:
    'Settle what a fold set aside. A field conflict: say whose value stands, `take` for every field and/or `fields` one by one (kept: the value the issue shows; theirs: the one set aside); the issue is claimable again. An id collision: name the bare id and `keep`, the record that keeps it. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the conflicted issue, or the bare id of a collision' }),
    keep: s.optional(s.string({ ...oneLine, description: 'an id collision: the record that keeps the bare id (<id>~<hash4>, or the hash4)' })),
    take: s.optional(s.literal(['kept', 'theirs'], 'a field conflict: whose value stands for every conflicted field not named in `fields`')),
    fields: s.optional(
      s.object(
        { title: s.optional(side), status: s.optional(side), parent: s.optional(side), body: s.optional(side), deleted: s.optional(side) },
        'a field conflict: whose value stands, per field',
      ),
    ),
  }),
  async run(input, { ctx, tracker, actor }): Promise<ResolveResult> {
    const author = writer(ctx);
    const by = recordedActor(author.email, actor);
    const ref = parseWriteRef(input.id, 'id');
    if (input.keep !== undefined && (input.take !== undefined || input.fields !== undefined)) {
      throw invalid({ keep: 'settles an id collision; take and fields settle a field conflict, so don’t combine them' });
    }
    const write = await tracker.transact({ op: 'resolve', author, actor }, (draft) => {
      const live = draft.issues().map((issue) => issue.id);
      const sides = ref.includes('~') ? [] : collisionSides(ref, live);
      if (input.keep !== undefined) {
        if (sides.length < 2) throw invalid({ id: `${ref} is not an id collision; keep names the record that keeps a collided id` });
        const kept = keptSide(ref, input.keep, sides);
        draft.putForward(ref, kept, author.email);
        return { result: { id: ref, forwarded_to: kept, others: sides.filter((other) => other !== kept) }, issue: kept };
      }
      if (sides.length >= 2 && draft.forwardOf(ref) === undefined) {
        throw new GrimoireError(
          'INVALID',
          `${ref} is an id collision between ${sides.join(' and ')}: name the record that keeps the bare id as keep`,
          { fields: { keep: 'is required for an id collision' }, candidates: sides },
        );
      }
      const id = draft.resolveWrite(ref, 'id');
      const record = draft.issue(id)!;
      const conflict = fieldConflict(draft, id);
      if (!conflict) {
        const open = draft.attempts(id).filter((attempt) => attempt.end === null).length;
        throw invalid({
          id: open > 1 ? `${id} has no field conflict; its ${OPEN_ATTEMPTS_FIELD} conflict ends when one of them is released` : `${id} has no fold conflict to resolve`,
        });
      }
      const named = Object.entries(input.fields ?? {}).filter(([, value]) => value !== undefined) as [string, Side][];
      const stray = named.filter(([field]) => !conflict.fields.includes(field));
      if (stray.length > 0) throw invalid(Object.fromEntries(stray.map(([field]) => [`fields.${field}`, 'is not in conflict'])));
      const picks = new Map(named);
      const resolved = conflict.fields.map((field) => ({ field, took: picks.get(field) ?? input.take }));
      const missing = resolved.filter((pick) => pick.took === undefined).map((pick) => pick.field);
      if (missing.length > 0) {
        throw invalid({ take: `say whose value stands for ${missing.join(', ')}: kept or theirs (take, or fields one by one)` });
      }
      const result: ResolveResult = { id, resolved: resolved as { field: string; took: Side }[] };
      if (picks.get('deleted') === 'theirs' || (input.take === 'theirs' && conflict.fields.includes('deleted') && !picks.has('deleted'))) {
        // The other clone's delete stands, with every rule of a delete.
        const removed = removeIssue(draft, id, author.email, by);
        return { result: { ...result, deleted: true as const, blocked_by_stripped: removed.blocked_by_stripped }, issue: id };
      }
      let next: IssueRecord = record;
      for (const { field, took } of resolved) {
        if (took === 'theirs' && field !== 'deleted') next = { ...next, ...theirValue(draft, next, field, conflict.theirs[field]) };
      }
      draft.clearConflicts(id);
      if (issueRevision(next) !== issueRevision(record)) {
        draft.putIssue({ ...next, updated_at: draft.now.toISOString() });
        const changed = resolved.filter((pick) => pick.took === 'theirs' && pick.field !== 'deleted').map((pick) => pick.field);
        draft.addActivity(id, { actor: by, fields: changed });
      }
      return { result, issue: id };
    });
    return write.result;
  },
});

