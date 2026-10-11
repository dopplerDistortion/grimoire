// What every operation in the registry is made of (spec §2.1).
import { GrimoireError } from '../errors';
import type { SecretScanner } from '../scanner';
import type { TrackerStore } from '../tracker';
import type { Actor, CallContext } from './context';
import type { Schema } from './schema';

/** Who may call an op from which surface (spec §2.1, §7). */
export type SurfacePolicy = 'agent' | 'human-only' | 'human-read' | 'internal';

export interface OpEnv {
  readonly ctx: CallContext;
  readonly tracker: TrackerStore;
  readonly actor: Actor;
  /** The secret scanner agent-authored text goes through before it is written (debriefs). */
  readonly scanner: SecretScanner;
  /**
   * Asks for the automatic sync after a write that triggers one (spec §4,
   * Sync: attempt-ending writes, session-record attachments, accepted chore
   * submits, knowledge decisions), naming the commit it made. It runs after
   * the call answers and never fails or delays it.
   */
  readonly requestSync: (commit: string) => void;
}

export interface OpDefinition<I, R> {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly policy: SurfacePolicy;
  /** How a retried call replays (spec §8, Replays). */
  readonly replay: 'none' | 'idempotency-key' | 'attempt-and-reason';
  readonly input: Schema<I, false>;
  run(input: I, env: OpEnv): Promise<R>;
}

export function define<I, R>(op: OpDefinition<I, R>): OpDefinition<I, R> {
  return op;
}

/** The person a write is made by: author, committer and `created_by`. */
export function writer(ctx: CallContext): { name: string; email: string } {
  const { name, email } = ctx.person;
  if (!email) {
    throw new GrimoireError('NO_GIT_IDENTITY', `git user.email is not set in ${ctx.repo.root}`, { name, email });
  }
  return { name: name ?? email, email };
}

export const oneLine = { nonBlank: true, singleLine: true } as const;
