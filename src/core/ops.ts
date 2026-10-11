// The issue operations of the tracer slice: create, show, labels (spec §8).
import { GrimoireError } from '../errors';
import { issueRevision, parseWriteRef, sortedUnique, type IssueLink, type TrackerStore } from '../tracker';
import type { Actor, CallContext } from './context';
import { s, type Schema } from './schema';

/** Who may call an op from which surface (spec §2.1, §7). */
export type SurfacePolicy = 'agent' | 'human-only' | 'human-read' | 'internal';

export interface OpEnv {
  readonly ctx: CallContext;
  readonly tracker: TrackerStore;
  readonly actor: Actor;
}

export interface OpDefinition<I, R> {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly policy: SurfacePolicy;
  /** How a retried call replays (spec §8, Replays). */
  readonly replay: 'none' | 'idempotency-key';
  readonly input: Schema<I, false>;
  run(input: I, env: OpEnv): Promise<R>;
}

function define<I, R>(op: OpDefinition<I, R>): OpDefinition<I, R> {
  return op;
}

/** The person a write is made by: author, committer and `created_by`. */
function writer(ctx: CallContext): { name: string; email: string } {
  const { name, email } = ctx.person;
  if (!email) {
    throw new GrimoireError('NO_GIT_IDENTITY', `git user.email is not set in ${ctx.repo.root}`, { name, email });
  }
  return { name: name ?? email, email };
}

const oneLine = { nonBlank: true, singleLine: true } as const;

export interface CreateResult {
  id: string;
  /** False when an idempotency key replayed an earlier create. */
  created: boolean;
}

export const create = define({
  name: 'create',
  description: 'Create an issue. Pass an idempotency_key to make retries safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
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
        if (parent) draft.resolveWrite(parent, 'parent');
        for (const blocker of blockers) draft.resolveWrite(blocker.id, blocker.field);
        const id = await draft.mintIssueId();
        const at = draft.now.toISOString();
        draft.putIssue({
          id,
          seq: draft.nextSeq(),
          title: input.title,
          status: 'open',
          labels: sortedUnique(input.labels ?? []),
          parent,
          blocked_by: sortedUnique(blockers.map((b) => b.id)),
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

export interface ShowResult {
  id: string;
  seq: number;
  title: string;
  status: string;
  labels: readonly string[];
  parent: string | null;
  blocked_by: readonly string[];
  links: readonly IssueLink[];
  created_at: string;
  created_by: string;
  updated_at: string;
  /** The body, byte for byte as written. */
  body: string;
  /** Opaque; changes exactly when the title, status, labels, relations, links or body change. */
  revision: string;
  link: string;
}

export const show = define({
  name: 'show',
  description: 'Show one issue: a full id, a unique prefix of 3+ characters, or a link.',
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({ ref: s.string(oneLine) }),
  async run(input, { tracker }): Promise<ShowResult> {
    const view = await tracker.read();
    const id = view.resolveRead(input.ref, 'ref');
    const record = view.issue(id)!;
    return {
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
      body: record.body,
      revision: issueRevision(record),
      link: view.link(id),
    };
  },
});

export interface LabelsResult {
  /** Every label on a live issue, with how many issues carry it, by name. */
  labels: { name: string; count: number }[];
}

export const labels = define({
  name: 'labels',
  description: 'List the labels in use, with counts.',
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
}
