// `update` (spec §8): edits one issue's fields all-or-nothing, as one commit,
// and reports the requested changes that were already in place.
import { GrimoireError, invalid } from '../errors';
import { issueRevision, parseWriteRef, sortedUnique, type IssueLink, type IssueRecord } from '../tracker';
import { fieldConflict, findCycle, stateConflict } from './derive';
import { linkTarget } from './links';
import { heldAttempt, parseHandle, recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { applyPatch, patchOps } from './patch';
import { s } from './schema';

/** A requested change that changed nothing, by its input field (`labels_add[0]`). */
export interface Noop {
  field: string;
  reason: string;
}

export interface UpdateResult {
  /** The issue's revision after the update (unchanged when every change was a no-op). */
  revision: string;
  noops: Noop[];
}

const label = s.string(oneLine);

/** Applies add/remove deltas to a sorted set, recording no-ops. */
function applyDeltas(
  current: readonly string[],
  adds: readonly string[],
  removes: readonly string[],
  names: { add: string; remove: string },
  noops: Noop[],
): string[] {
  const set = new Set(current);
  adds.forEach((value, i) => {
    if (set.has(value)) noops.push({ field: `${names.add}[${i}]`, reason: 'already set' });
    else set.add(value);
  });
  removes.forEach((value, i) => {
    if (!set.delete(value)) noops.push({ field: `${names.remove}[${i}]`, reason: 'not set' });
  });
  return sortedUnique(set);
}

function overlapping(adds: readonly string[], removes: readonly string[], field: string): Record<string, string> {
  const added = new Set(adds);
  const errors: Record<string, string> = {};
  removes.forEach((value, i) => {
    if (added.has(value)) errors[`${field}[${i}]`] = `"${value}" is also being added`;
  });
  return errors;
}

/** The fields an update changed, by name. */
function changedFields(before: IssueRecord, after: IssueRecord): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return (['title', 'body', 'labels', 'parent', 'blocked_by', 'links'] as const).filter(
    (field) => !same(before[field], after[field]),
  );
}

export const update = define({
  name: 'update',
  description:
    'Edit a grimoire issue, all or nothing: title, the whole body (needs if_revision) or anchored body_patch ops, labels and blockers (add/remove deltas), parent, links (added as a set). Returns the new revision and the requested changes that were already in place.',
  kind: 'write',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    title: s.optional(s.string(oneLine)),
    body: s.optional(s.string({ description: 'the whole new body; needs if_revision' })),
    body_patch: s.optional(patchOps),
    labels_add: s.optional(s.array(label)),
    labels_remove: s.optional(s.array(label)),
    parent: s.optional(s.nullable(s.string(oneLine), 'the parent’s full id, or null for none')),
    blocked_by_add: s.optional(s.array(s.string(oneLine), 'full ids of issues that block this one')),
    blocked_by_remove: s.optional(s.array(s.string(oneLine))),
    links_add: s.optional(
      s.array(
        s.object({
          target: s.string({ description: 'a URL, a repo-relative path or a git ref' }),
          title: s.optional(s.string({ singleLine: true })),
        }),
        'links to add; links are a set',
      ),
    ),
    if_revision: s.optional(s.string({ ...oneLine, description: 'the revision you read; the update fails with REVISION_CONFLICT if it moved' })),
    attempt: s.optional(s.string({ ...oneLine, description: 'your open attempt’s handle: names the update as work on it' })),
  }),
  async run(input, { ctx, tracker, actor }): Promise<UpdateResult> {
    const author = writer(ctx);
    const id = parseWriteRef(input.id, 'id');
    const attempt = input.attempt === undefined ? undefined : parseHandle(input.attempt);
    const labelsAdd = input.labels_add ?? [];
    const labelsRemove = input.labels_remove ?? [];
    const parent = input.parent === undefined || input.parent === null ? input.parent : parseWriteRef(input.parent, 'parent');
    const blockersAdd = (input.blocked_by_add ?? []).map((ref, i) => parseWriteRef(ref, `blocked_by_add[${i}]`));
    const blockersRemove = (input.blocked_by_remove ?? []).map((ref, i) => parseWriteRef(ref, `blocked_by_remove[${i}]`));
    const linksAdd: IssueLink[] = (input.links_add ?? []).map((link, i) => ({
      target: linkTarget(link.target, `links_add[${i}].target`),
      title: link.title ?? '',
    }));
    const problems = {
      ...overlapping(labelsAdd, labelsRemove, 'labels_remove'),
      ...overlapping(blockersAdd, blockersRemove, 'blocked_by_remove'),
    };
    if (input.body !== undefined && input.body_patch !== undefined) {
      problems.body_patch = 'cannot be combined with body: replace the whole body or patch it';
    } else if (input.body !== undefined && input.if_revision === undefined) {
      problems.if_revision = 'is required to replace the whole body (or patch it with body_patch)';
    }
    if (Object.keys(problems).length > 0) throw invalid(problems);

    const write = await tracker.transact({ op: 'update', author, actor }, (draft) => {
      draft.resolveWrite(id, 'id');
      if (attempt !== undefined) heldAttempt(draft, id, attempt, author.email);
      const current = draft.issue(id)!;
      const currentRevision = issueRevision(current);
      if (input.if_revision !== undefined && input.if_revision !== currentRevision) {
        throw new GrimoireError('REVISION_CONFLICT', `${id} changed since revision ${input.if_revision}; show it again`, {
          revision: currentRevision,
        });
      }
      const conflict = fieldConflict(draft, id);
      if (conflict) {
        if (input.body !== undefined) throw stateConflict(id, conflict, 'the whole body can’t be replaced');
        const written = [...(input.title !== undefined ? ['title'] : []), ...(input.parent !== undefined ? ['parent'] : [])];
        const blocked = written.filter((field) => conflict.fields.includes(field));
        if (blocked.length > 0) throw stateConflict(id, conflict, `${blocked.join(' and ')} can’t be changed`);
      }
      const noops: Noop[] = [];
      let title = current.title;
      if (input.title !== undefined) {
        if (input.title === current.title) noops.push({ field: 'title', reason: 'unchanged' });
        else title = input.title;
      }
      let body = current.body;
      if (input.body !== undefined) {
        if (input.body === current.body) noops.push({ field: 'body', reason: 'unchanged' });
        else body = input.body;
      }
      if (input.body_patch !== undefined) {
        const patched = applyPatch(body, input.body_patch);
        for (const op of patched.noops) {
          const reason = input.body_patch[op]!.op === 'replace' ? 'unchanged' : 'text already present';
          noops.push({ field: `body_patch[${op}]`, reason });
        }
        body = patched.body;
      }
      const labels = applyDeltas(
        current.labels,
        labelsAdd,
        labelsRemove,
        { add: 'labels_add', remove: 'labels_remove' },
        noops,
      );
      let nextParent = current.parent;
      if (parent !== undefined) {
        if (parent !== null) draft.resolveWrite(parent, 'parent');
        if (parent === current.parent) noops.push({ field: 'parent', reason: 'unchanged' });
        else nextParent = parent;
      }
      blockersAdd.forEach((blocker, i) => draft.resolveWrite(blocker, `blocked_by_add[${i}]`));
      const blockedBy = applyDeltas(
        current.blocked_by,
        blockersAdd,
        blockersRemove,
        { add: 'blocked_by_add', remove: 'blocked_by_remove' },
        noops,
      );
      const links = [...current.links];
      linksAdd.forEach((link, i) => {
        if (links.some((l) => l.target === link.target && l.title === link.title)) {
          noops.push({ field: `links_add[${i}]`, reason: 'already set' });
        } else links.push(link);
      });
      const next: IssueRecord = { ...current, title, body, labels, parent: nextParent, blocked_by: blockedBy, links };
      const addsEdges =
        (nextParent !== null && nextParent !== current.parent) || blockedBy.some((b) => !current.blocked_by.includes(b));
      const cycle = addsEdges
        ? findCycle(
            draft.issues().map((issue) => (issue.id === id ? next : issue)),
            id,
          )
        : null;
      if (cycle) {
        throw new GrimoireError(
          'CYCLE',
          `that would make a cycle (each waits for the next): ${cycle.join(' → ')}`,
          { path: cycle },
        );
      }
      const revision = issueRevision(next);
      if (revision !== currentRevision) {
        draft.putIssue({ ...next, updated_at: draft.now.toISOString() });
        draft.addActivity(id, {
          actor: recordedActor(author.email, actor),
          ...(attempt !== undefined ? { attempt } : {}),
          fields: changedFields(current, next),
        });
      }
      return { result: { revision, noops }, issue: id, ...(attempt !== undefined ? { attempt } : {}) };
    });
    return write.result;
  },
});
