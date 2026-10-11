// The call context every operation takes (spec §2.1), and the Actor the core
// derives from it (spec §7). Surfaces build the context from what they
// observe; no model-supplied parameter ever carries identity.

export type Surface = 'mcp' | 'cli' | 'dashboard' | 'hook' | 'runner';

export interface HostRepo {
  /** The checkout's root (the first ancestor of the start directory that holds `.git`). */
  readonly root: string;
  /** The checkout's pinned version from `.grimoire/config.yml`, when known. */
  readonly pin: string | null;
}

/** The person: the host repo's git identity. A write needs `email` (else NO_GIT_IDENTITY). */
export interface Identity {
  readonly name: string | null;
  readonly email: string | null;
}

export interface ClientInfo {
  /** e.g. `claude-code`, `codex-mcp-client` (MCP `clientInfo`), or `runner:claude`. */
  readonly name: string;
  readonly version?: string;
}

/** Observed, already-validated agent evidence: ids only, never paths. */
export interface Evidence {
  /** Agent marker variables found set (CLI): AI_AGENT, CLAUDE_CODE_CHILD_SESSION, CODEX_CI, CODEX_THREAD_ID. */
  readonly agentMarkers?: readonly string[];
  readonly session?: string;
  readonly context?: string;
  readonly callId?: string;
  readonly spawnEnvId?: string;
  readonly choreExposure?: string;
}

export interface CallContext {
  readonly surface: Surface;
  readonly repo: HostRepo;
  readonly person: Identity;
  readonly client?: ClientInfo | null;
  readonly evidence?: Evidence;
  /** This process's nonce. */
  readonly nonce: string;
}

/** Who made a change: always the person (the commit author), plus agent facts when an agent made it. */
export type Actor = {
  readonly kind: 'agent' | 'human';
  readonly client?: string;
  readonly session?: string;
  readonly context?: string;
  readonly call?: string;
  readonly spawn_env?: string;
  readonly nonce: string;
  readonly chore_exposure?: string;
};

/**
 * The Actor of a call (spec §7, Actors). MCP, hook and runner calls are agent
 * actors; CLI calls are agent actors only under an agent marker; dashboard
 * calls are human.
 */
export function actorOf(ctx: CallContext): Actor {
  const markers = ctx.evidence?.agentMarkers ?? [];
  const kind =
    ctx.surface === 'dashboard' || (ctx.surface === 'cli' && markers.length === 0) ? 'human' : 'agent';
  const client = ctx.surface === 'dashboard' ? 'dashboard' : (ctx.client?.name ?? ctx.surface);
  const evidence = kind === 'agent' ? (ctx.evidence ?? {}) : {};
  const actor: Record<string, string> = { kind, client };
  if (evidence.session) actor.session = evidence.session;
  if (evidence.context) actor.context = evidence.context;
  if (evidence.callId) actor.call = evidence.callId;
  if (evidence.spawnEnvId) actor.spawn_env = evidence.spawnEnvId;
  actor.nonce = ctx.nonce;
  if (evidence.choreExposure) actor.chore_exposure = evidence.choreExposure;
  return actor as Actor;
}
