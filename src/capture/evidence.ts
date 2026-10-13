// Binding evidence (spec §14 Identity is observed, CLI calls, Generic MCP
// clients; §8 the reserved hint key; spikes A, B and E): who made a call, as
// grimoire observed it. Never what the model claims: no advertised parameter
// carries identity, and nothing here trusts one.
//
// Sources, in order of precedence:
//
// 1. the Claude Code hint (grimoire's `PreToolUse` hook), counted only when its
//    `tool_use_id` equals the call's `_meta["claudecode/toolUseId"]`;
// 2. Codex's per-call `_meta`: `sessionId` (the root thread), `threadId` (the
//    context) and `callId`; a Codex that sends no top-level `sessionId` (up to
//    at least 0.150.0) gives the turn metadata's `session_id` (T6);
// 3. Claude's `_meta` tool-use id alone, joined to a transcript at cut time;
// 4. Claude's spawn-env `CLAUDE_CODE_SESSION_ID`, trusted only if its
//    transcript holds the call (the cut checks).
//
// CLI calls take the session from the shell env; generic MCP clients have
// nothing but the server-process nonce.
import type { CallContext, Evidence, McpCallFacts, ReservedHint } from '../core/context';

/** Which source settled the session (or, short of one, what the cut has to go on). */
export type EvidenceSource =
  /** The Claude Code hint, validated by its tool-use id. */
  | 'hint'
  /** Codex's per-call `_meta`. */
  | 'meta'
  /** Claude's `_meta` tool-use id only: the cut joins it to a transcript. */
  | 'tool-use-id'
  /** Claude's spawn-env session only: trusted once its transcript holds the call. */
  | 'spawn-env'
  /** A CLI call's shell env. */
  | 'shell-env';

/** What one call's evidence says. Ids only, never paths. */
export interface CallEvidence {
  readonly session?: string;
  /** The context: `main` or a Claude subagent's `agent_id`; a Codex thread id. */
  readonly context?: string;
  readonly callId?: string;
  /** A Claude subagent's `agent_type`, from a validated hint only (chore admission reads it). */
  readonly agentType?: string;
  readonly source: EvidenceSource | null;
  /**
   * A hint on a call with no Claude `_meta` to check it against: it claims
   * nothing now, and counts once a cut finds its `tool_use_id` in the
   * session's transcript (spec §8). Null otherwise.
   */
  readonly pendingHint: ReservedHint | null;
}

/** Claude Code's per-call tool-use id. */
const CLAUDE_TOOL_USE_ID = 'claudecode/toolUseId';
/** Codex's turn metadata's session id, as the MCP surface keeps it (the only field it keeps). */
const CODEX_TURN_SESSION = 'x-codex-turn-metadata.session_id';
/** Claude Code's main line, as the reader names it. */
export const MAIN_CONTEXT = 'main';

const str = (meta: McpCallFacts['meta'], key: string): string | undefined => {
  const value = meta?.[key];
  return typeof value === 'string' && idValue(value) ? value : undefined;
};

/**
 * Whether `value` may be written as an id (trailers, records, rows): a
 * single-line string that can't be a filesystem path. Paths are never
 * evidence (spec §3 Commits: ids only, never paths).
 */
export function idValue(value: string): boolean {
  return value !== '' && value.length <= 256 && !/[\r\n\\/]/.test(value) && !/^[A-Za-z]:/.test(value) && !value.startsWith('~');
}

/** The evidence one MCP call carried (spec §14 sources 1 to 3). */
export function mcpCallEvidence(facts: McpCallFacts): CallEvidence {
  const { hint, meta } = facts;
  const threadId = str(meta, 'threadId');
  const codexSession = str(meta, 'sessionId') ?? str(meta, CODEX_TURN_SESSION);
  const codexCall = str(meta, 'callId');
  if (threadId !== undefined || codexSession !== undefined || codexCall !== undefined) {
    // Codex runs no grimoire hook: a reserved key on its call was written by the model.
    return {
      ...(codexSession !== undefined ? { session: codexSession } : {}),
      ...(threadId !== undefined ? { context: threadId } : {}),
      ...(codexCall !== undefined ? { callId: codexCall } : {}),
      source: 'meta',
      pendingHint: null,
    };
  }
  const toolUseId = str(meta, CLAUDE_TOOL_USE_ID);
  if (toolUseId === undefined) {
    // No _meta to check a hint against: it waits for the cut.
    return { source: null, pendingHint: hint && idValue(hint.session_id) && idValue(hint.tool_use_id) ? hint : null };
  }
  if (hint && hint.tool_use_id === toolUseId && idValue(hint.session_id)) {
    const agentId = hint.agent_id !== undefined && idValue(hint.agent_id) ? hint.agent_id : undefined;
    const agentType = agentId !== undefined && hint.agent_type !== undefined && idValue(hint.agent_type) ? hint.agent_type : undefined;
    return {
      session: hint.session_id,
      context: agentId ?? MAIN_CONTEXT,
      callId: toolUseId,
      ...(agentType !== undefined ? { agentType } : {}),
      source: 'hint',
      pendingHint: null,
    };
  }
  // A hint that doesn't match claims nothing.
  return { callId: toolUseId, source: 'tool-use-id', pendingHint: null };
}

/**
 * Everything observed about a call's identity: the surface's own evidence
 * (agent markers, the shell env's session and context, the server's spawn
 * env) with an MCP call's evidence on top. Values that aren't ids are
 * dropped. A CLI call needs no call id: the cut finds it by the id its result
 * printed (the handle, the comment's id, the revision), which its binding
 * commit holds too.
 */
export function observedEvidence(ctx: CallContext): Evidence & Pick<CallEvidence, 'source' | 'pendingHint'> {
  const base = ctx.evidence ?? {};
  const fromMcp = ctx.mcp ? mcpCallEvidence(ctx.mcp) : null;
  const pick = (value: string | undefined) => (value !== undefined && idValue(value) ? value : undefined);
  const session = fromMcp?.session ?? pick(base.session);
  const context = fromMcp?.context ?? pick(base.context);
  const callId = fromMcp?.callId ?? pick(base.callId);
  const spawnEnvId = pick(base.spawnEnvId);
  const agentType = fromMcp?.agentType;
  const choreExposure = pick(base.choreExposure);
  const source: EvidenceSource | null =
    fromMcp?.source ??
    (ctx.surface === 'cli' && session !== undefined ? 'shell-env' : session === undefined && spawnEnvId !== undefined ? 'spawn-env' : null);
  return {
    ...(base.agentMarkers !== undefined ? { agentMarkers: base.agentMarkers } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(spawnEnvId !== undefined ? { spawnEnvId } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(choreExposure !== undefined ? { choreExposure } : {}),
    source,
    pendingHint: fromMcp?.pendingHint ?? null,
  };
}
