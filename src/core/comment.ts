// `comment` (spec §8): adds a write-once comment to an issue, replay-safe with
// an idempotency key.
import { createHash } from 'node:crypto';
import { keyHash, parseWriteRef } from '../tracker';
import { jsonBytes, longestPrefix, RESULT_BUDGET } from './budget';
import { heldAttempt, parseHandle, recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { s } from './schema';

export interface CommentResult {
  /** The comment's id: `<utc-ms>-<n>-<rand4>`. */
  id: string;
  issue: string;
  at: string;
  kind: string;
  actor: Record<string, unknown>;
  /** The attempt handle the comment named. */
  attempt?: string;
  body: string;
  /** True when an idempotency key replayed an earlier comment. */
  replayed?: true;
  /** True when `body` is only the start of the comment (the ~24 KB cut); the stored comment is whole. */
  truncated?: true;
}

/** The result under the budget: a body too long to return is cut, never the stored comment. */
function withinBudget(result: CommentResult): CommentResult {
  const room = RESULT_BUDGET - jsonBytes({ ...result, body: '', replayed: true, truncated: true });
  if (jsonBytes(result.body) - 2 <= room) return result;
  return { ...result, body: longestPrefix(result.body, (b) => jsonBytes(b) - 2 <= room), truncated: true };
}

export const comment = define({
  name: 'comment',
  description:
    'Comment on an issue. Comments are write-once: never edited or deleted. Pass an idempotency_key to make retries safe.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
  input: s.object({
    id: s.string({ ...oneLine, description: 'the issue’s full id' }),
    body: s.string({ nonBlank: true, description: 'the comment, stored byte for byte' }),
    idempotency_key: s.optional(s.string(oneLine)),
    attempt: s.optional(s.string({ ...oneLine, description: 'your open attempt’s handle: names the comment as work on it' })),
  }),
  async run(input, { ctx, tracker, actor }): Promise<CommentResult> {
    const author = writer(ctx);
    const id = parseWriteRef(input.id, 'id');
    const key = input.idempotency_key;
    const attempt = input.attempt === undefined ? undefined : parseHandle(input.attempt);
    const bodyHash = createHash('sha256').update(input.body, 'utf8').digest('hex');
    const write = await tracker.transact(
      {
        op: 'comment',
        author,
        actor,
        ...(key ? { idempotency: { key, fingerprint: { issue: id, body: bodyHash } } } : {}),
      },
      (draft) => {
        draft.resolveWrite(id, 'id');
        if (attempt !== undefined) heldAttempt(draft, id, attempt, author.email);
        const added = draft.addComment(id, {
          actor: recordedActor(author.email, actor),
          kind: 'comment',
          body: input.body,
          ...(attempt !== undefined ? { attempt } : {}),
          ...(key ? { key: keyHash(key) } : {}),
        });
        const result: CommentResult = {
          id: added.id,
          issue: id,
          at: added.at,
          kind: added.kind,
          actor: { ...added.actor },
          ...(attempt !== undefined ? { attempt } : {}),
          body: added.body,
        };
        return { result: withinBudget(result), issue: id, ...(attempt !== undefined ? { attempt } : {}) };
      },
    );
    return write.replayed ? { ...write.result, replayed: true } : write.result;
  },
});
