// The call context every operation takes (spec §2.1), and the Actor the core
// derives from it (spec §7). Surfaces build the context from what they
// observe; no model-supplied parameter ever carries identity.

export type Surface = 'mcp' | 'cli' | 'dashboard' | 'hook' | 'runner';

export interface HostRepo {
  /** The checkout's root (the first ancestor of the start directory that holds `.git`). */
  readonly root: string;
  /** The checkout's pinned version from `.grimoire/config.yml`, when known. */
  readonly pin: string | null;
  /**
   * The checkout's `install_format` from `.grimoire/config.yml`, when the
   * surface read it: one outside this release's range gives UPGRADE_REQUIRED
   * (marker `install`, spec §5). Null or absent: not checked.
   */
  readonly installFormat?: number | null;
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

/**
 * The reserved hint key's value as an MCP call carried it (spec §8), filled by
 * grimoire's Claude Code `PreToolUse` hook. Ids only: a `transcript_path` (the
 * spike-era shape) or any other field is dropped. Unvalidated: it counts only
 * once capture matches `tool_use_id` against `_meta["claudecode/toolUseId"]`.
 */
export interface ReservedHint {
  readonly session_id: string;
  readonly tool_use_id: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
}

/**
 * What one MCP call carried, as the server observed it, for the capture slices
 * to turn into evidence (spec §8, §14). Nothing here has been validated.
 */
export interface McpCallFacts {
  /** The connection's protocol era: `legacy` (2025-era `initialize`) or `modern` (2026-07-28). */
  readonly era: 'legacy' | 'modern';
  /** The reserved hint key, read from the raw arguments and stripped before parsing; null when absent or malformed. */
  readonly hint: ReservedHint | null;
  /**
   * The call's client `_meta` keys with string, number or boolean values (ids:
   * `claudecode/toolUseId`, Codex's `sessionId`, `threadId`, `callId`, …). The
   * 2026-07-28 envelope keys are lifted out, and nested objects are dropped,
   * except that Codex's `x-codex-turn-metadata` (which holds workspace paths)
   * gives up its one `session_id`, as `x-codex-turn-metadata.session_id`: the
   * session for a Codex that sends no top-level `sessionId` (spike E, T6).
   * Null when the call had no `_meta`.
   */
  readonly meta: Readonly<Record<string, string | number | boolean>> | null;
}

export interface CallContext {
  readonly surface: Surface;
  readonly repo: HostRepo;
  readonly person: Identity;
  readonly client?: ClientInfo | null;
  readonly evidence?: Evidence;
  /**
   * CLI only: whether the process runs at an interactive terminal (stdin and
   * stdout are TTYs). The human-only gate needs one; a CLI call without it
   * counts as an agent surface for that gate.
   */
  readonly tty?: boolean;
  /** The raw per-call facts of an MCP call. */
  readonly mcp?: McpCallFacts;
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
 * Whether the call comes from a human surface (spec §7, the human-only gate):
 * the dashboard, or the CLI with no agent marker at an interactive terminal.
 * MCP, hook and runner calls, and CLI calls under a marker or without a TTY,
 * are agent surfaces.
 */
export function humanSurface(ctx: CallContext): boolean {
  if (ctx.surface === 'dashboard') return true;
  return ctx.surface === 'cli' && (ctx.evidence?.agentMarkers ?? []).length === 0 && ctx.tty === true;
}

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
