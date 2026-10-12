// The registry's result types, and the tracer slice's create and labels (spec §8).
import { parseWriteRef, sortedUnique } from '../tracker';
import type { ClaimResult, EndResult } from './attempts';
import type { CommentResult } from './comment';
import type { ListResult } from './list';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import type { ShowResult } from './show';
import type { UpdateResult } from './update';
import type { AssignResult, DeleteResult, OutcomeSetResult, ReassignResult, ReopenResult } from './human-ops';
import type { ResolveResult } from './resolve';
import type { SettingsResult, SettingsSetResult } from './settings';
import type { SkillEditResult, SkillListResult, SkillReadResult, SkillShowResult } from './skills';
import type { SkillDiscardResult, SkillRecordResult, SkillStraysResult } from './stray-edits';
import type { WikiEditResult, WikiListResult, WikiShowResult } from './wiki';
import type { QuarantineResult } from './quarantine';
import type { PurgeSessionResult, PurgeTraceResult } from './purge';
import type { SyncResult, SyncStatusResult } from './sync';
import type { ChoreAbandonResult, ChoreBrief, ChoreReadResult } from './chores';
import type { ChoreSubmitResult } from './chore-submit';
import type { ActivityResult } from './activity';

export type { SurfacePolicy, OpDefinition, OpEnv } from './op';
export type { ShowResult } from './show';

export interface CreateResult {
  id: string;
  /** False when an idempotency key replayed an earlier create. */
  created: boolean;
}

export const create = define({
  name: 'create',
  description: 'Create a grimoire issue. Pass an idempotency_key to make retries safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
  issueWrite: true,
  input: s.object({
    title: s.string(oneLine),
    body: s.optional(s.string()),
    labels: s.optional(s.array(s.string(oneLine))),
    parent: s.optional(s.string({ description: 'the parent issue’s full id' })),
    blocked_by: s.optional(s.array(s.string(), 'full ids of the issues that block this one')),
    idempotency_key: s.optional(s.string(oneLine)),
  }),
  async run(input, { ctx, tracker, actor }): Promise<CreateResult> {
    const author = writer(ctx);
    const parent = input.parent === undefined ? null : parseWriteRef(input.parent, 'parent');
    const blockers = (input.blocked_by ?? []).map((ref, i) => ({
      field: `blocked_by[${i}]`,
      id: parseWriteRef(ref, `blocked_by[${i}]`),
    }));
    const write = await tracker.transact(
      {
        op: 'create',
        author,
        actor,
        ...(input.idempotency_key
          ? { idempotency: { key: input.idempotency_key, fingerprint: { title: input.title, parent } } }
          : {}),
      },
      async (draft) => {
        const parentId = parent === null ? null : draft.resolveWrite(parent, 'parent');
        const blockerIds = blockers.map((blocker) => draft.resolveWrite(blocker.id, blocker.field));
        const id = await draft.mintIssueId();
        const at = draft.now.toISOString();
        draft.putIssue({
          id,
          seq: draft.nextSeq(),
          title: input.title,
          status: 'open',
          labels: sortedUnique(input.labels ?? []),
          parent: parentId,
          blocked_by: sortedUnique(blockerIds),
          links: [],
          created_at: at,
          created_by: author.email,
          updated_at: at,
          body: input.body ?? '',
          extra: {},
        });
        return { result: { id }, issue: id };
      },
    );
    return { id: write.result.id, created: !write.replayed };
  },
});

export interface LabelsResult {
  /** Every label on a live issue, with how many issues carry it, by name. */
  labels: { name: string; count: number }[];
}

export const labels = define({
  name: 'labels',
  description: 'List the labels in use on grimoire issues, with counts.',
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({}),
  async run(_input, { tracker }): Promise<LabelsResult> {
    const view = await tracker.read();
    const counts = new Map<string, number>();
    for (const issue of view.issues()) {
      for (const label of issue.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return {
      labels: sortedUnique(counts.keys()).map((name) => ({ name, count: counts.get(name)! })),
    };
  },
});

export interface OpResults {
  create: CreateResult;
  show: ShowResult;
  labels: LabelsResult;
  update: UpdateResult;
  comment: CommentResult;
  list: ListResult;
  claim: ClaimResult;
  release: EndResult;
  close: EndResult;
  settings_get: SettingsResult;
  assign: AssignResult;
  reassign: ReassignResult;
  reopen: ReopenResult;
  delete: DeleteResult;
  resolve: ResolveResult;
  outcome_set: OutcomeSetResult;
  settings_set: SettingsSetResult;
  skill_list: SkillListResult;
  skill_read: SkillReadResult;
  skill_edit: SkillEditResult;
  skill_show: SkillShowResult;
  skill_strays: SkillStraysResult;
  skill_record: SkillRecordResult;
  skill_discard: SkillDiscardResult;
  wiki_list: WikiListResult;
  wiki_show: WikiShowResult;
  wiki_edit: WikiEditResult;
  quarantine: QuarantineResult;
  unquarantine: QuarantineResult;
  purge_trace: PurgeTraceResult;
  purge_session: PurgeSessionResult;
  chore_start: ChoreBrief;
  chore_read: ChoreReadResult;
  chore_submit: ChoreSubmitResult;
  chore_abandon: ChoreAbandonResult;
  sync: SyncResult;
  sync_status: SyncStatusResult;
  activity: ActivityResult;
}
