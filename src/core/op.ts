// What every operation in the registry is made of (spec §2.1).
import { GrimoireError } from '../errors';
import type { SecretScanner } from '../scanner';
import type { TrackerStore } from '../tracker';
import { humanSurface, type Actor, type CallContext } from './context';
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
   * Sync: session-record attachments, accepted chore submits, knowledge
   * decisions), naming the commit it made. Attempt-ending writes need not:
   * the core asks for every commit that seals an attempt. It runs after the
   * call answers and never fails or delays it.
   */
  readonly requestSync: (commit: string) => void;
  /**
   * Says the write changed what agents are served (spec §15 Refresh scope: a
   * decision, a skill edit, the delivery switch): after the call answers,
   * this process refreshes the generated output of every worktree on its pin.
   */
  readonly servedChanged: () => void;
}

export interface OpDefinition<I, R> {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly policy: SurfacePolicy;
  /**
   * False for an agent op that isn't an MCP tool (the CLI and the dashboard
   * still offer it), like `settings_get`. Only agent ops are ever MCP tools.
   */
  readonly mcp?: false;
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

/**
 * The surface policy (spec §2.1, §7), checked before an op reads its input:
 *
 * - `agent`: every surface.
 * - `human-only`: the dashboard, or the CLI with no agent marker at an
 *   interactive terminal. Anything else gives HUMAN_ONLY, and the message
 *   never names the markers.
 * - `human-read`: the dashboard, or the CLI with no agent marker (no TTY needed).
 * - `internal`: entry verbs (CLI, hooks, the runner); never MCP or the dashboard,
 *   where such an op doesn't exist.
 */
export function checkSurface(op: Pick<OpDefinition<unknown, unknown>, 'name' | 'policy'>, ctx: CallContext): void {
  const marked = (ctx.evidence?.agentMarkers ?? []).length > 0;
  switch (op.policy) {
    case 'agent':
      return;
    case 'human-only':
      if (humanSurface(ctx)) return;
      throw new GrimoireError(
        'HUMAN_ONLY',
        `${op.name} is a human-only operation: a person runs it from the dashboard, or from their own terminal`,
      );
    case 'human-read':
      if (ctx.surface === 'dashboard' || (ctx.surface === 'cli' && !marked)) return;
      throw new GrimoireError(
        'HUMAN_ONLY',
        `${op.name} is for people only: a person opens it in the dashboard, or from their own terminal`,
      );
    case 'internal':
      if (ctx.surface === 'cli' || ctx.surface === 'hook' || ctx.surface === 'runner') return;
      throw new GrimoireError('INVALID', `there is no operation named ${op.name}`, { fields: { op: 'unknown' } });
  }
}
