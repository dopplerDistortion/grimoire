// The reserved hint key (spec §8; spikes A and B): one undeclared argument key
// that only grimoire's Claude Code `PreToolUse` hook fills, through
// `updatedInput`. It is read from the raw `params.arguments` and stripped before
// schema parsing, and never advertised. Ids only (spike A, T1): the auto-mode
// classifier denies calls whose hint holds a transcript path.
import type { McpCallFacts, ReservedHint } from '../../core';

/** The key's name. The `hook pre-tool-use` verb writes exactly this key. */
export const RESERVED_KEY = '_grimoire';

/** Longest id the server keeps from a hint or `_meta`; anything longer isn't an id. */
const MAX_ID = 256;

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && !/[\r\n]/.test(value);

/**
 * Splits raw call arguments into the arguments proper (the reserved key
 * removed, even when malformed) and the hint's ids. A hint without a
 * `session_id` and a `tool_use_id` is no hint; unknown fields, a
 * `transcript_path` included, are dropped.
 */
export function takeHint(args: Readonly<Record<string, unknown>> | undefined): {
  input: Record<string, unknown>;
  hint: ReservedHint | null;
} {
  const { [RESERVED_KEY]: raw, ...input } = args ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { input, hint: null };
  const { session_id, tool_use_id, agent_id, agent_type } = raw as Record<string, unknown>;
  if (!isId(session_id) || !isId(tool_use_id)) return { input, hint: null };
  return {
    input,
    hint: {
      session_id,
      tool_use_id,
      ...(isId(agent_id) ? { agent_id } : {}),
      ...(isId(agent_type) ? { agent_type } : {}),
    },
  };
}

/**
 * The call's client `_meta` keys whose values are ids (strings, numbers,
 * booleans). The SDK has already lifted the 2026-07-28 envelope keys out;
 * nested objects such as Codex's `x-codex-turn-metadata` (which holds absolute
 * workspace paths) are dropped. Null when nothing is left.
 */
export function metaIds(meta: Readonly<Record<string, unknown>> | undefined): McpCallFacts['meta'] {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (key.startsWith('io.modelcontextprotocol/')) continue;
    if (isId(value) || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
