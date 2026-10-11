// Seen-here rows (spec §14 Seen-here rows, §6 coordination; ADR 0008): every
// binding write leaves a machine-local row naming the attempt and the context
// that wrote it, so the attempt-end cut and sweeps on this machine know which
// contexts to cut, and where to look. Rows are hints only: a binding without
// one is found by an id search, and a row whose write isn't in the tracker is
// ignored (bindings are read from the trailers).
import { createHash } from 'node:crypto';
import type { Actor, ReservedHint } from '../core/context';
import type { MachineLocalStore } from '../machine-local';
import { MAIN_CONTEXT, type EvidenceSource } from './evidence';
import type { StepOrigin } from './steps';
import { revealedRoot } from './transcript-roots';

/** The coordination kind (spec §6: seen-here rows; version-free, frozen by the cross-pin contract). */
export const SEEN_HERE = 'seen-here';

/** One attempt × context seen binding on this machine. */
export interface SeenHereRow {
  readonly handle: string;
  readonly issue: string;
  readonly client: string;
  readonly session: string | null;
  readonly context: string | null;
  /** The call id of the latest binding write. */
  readonly call: string | null;
  readonly spawn_env: string | null;
  /** The process nonce of the latest binding write. */
  readonly nonce: string;
  /** Which evidence settled the session, or what a cut has to go on. */
  readonly source: EvidenceSource | null;
  /** A hint a call carried with no `_meta` to check it against: it counts once a cut finds its tool-use id. */
  readonly pending_hint: ReservedHint | null;
  /** The worktree the write came from. */
  readonly worktree: string;
  /** The first and the latest binding write seen here (ISO 8601). */
  readonly at: string;
  readonly last_at: string;
  /**
   * The session's transcript as a hook revealed it, when known. A Claude
   * subagent's own file is `<path without .jsonl>/subagents/agent-<context>.jsonl`;
   * a Codex subagent thread has its own rollout, found by thread id.
   */
  readonly path: string | null;
  /** How far the last cut of this context reached (its last step); null until one did. */
  readonly reach: StepOrigin | null;
}

/** The client a session key counts: the MCP client and the shell of one agent client are one. */
function clientFamily(client: string): string {
  if (client.startsWith('codex')) return 'codex';
  if (client.startsWith('claude-code')) return 'claude-code';
  return client;
}

/**
 * The context a write counts for. A Claude Code shell names its session but
 * never its context (spike A: a subagent's Bash env carries the parent's
 * session and no agent id), so a Claude Code session with no context is its
 * main line, as a hinted MCP call from it names it: one context, whichever
 * surface it wrote through. Null when nothing names one.
 */
export function contextOf(actor: Pick<Actor, 'client' | 'session' | 'context'>): string | null {
  if (actor.context !== undefined) return actor.context;
  return actor.session !== undefined && clientFamily(actor.client ?? '') === 'claude-code' ? MAIN_CONTEXT : null;
}

/**
 * A context's session key (spec §3: hash of the client, the session or the
 * process nonce, and the context): the name of its session record, and of
 * its seen-here row within an attempt.
 */
export function sessionKey(actor: Pick<Actor, 'client' | 'session' | 'context' | 'nonce'>): string {
  const parts = [clientFamily(actor.client ?? ''), actor.session ?? `nonce:${actor.nonce}`, contextOf(actor) ?? ''];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** One binding write, as the process that made it saw it, after its ref moved. */
export interface BindingSeen {
  readonly handle: string;
  readonly issue: string;
  readonly actor: Actor;
  readonly source: EvidenceSource | null;
  readonly pendingHint: ReservedHint | null;
  readonly worktree: string;
  readonly at: Date;
}

/**
 * Writes or refreshes the row of the binding's attempt and context: the
 * latest call, nonce and time, the first time kept, a cut's reach kept.
 */
export async function recordSeenHere(store: MachineLocalStore, seen: BindingSeen): Promise<void> {
  const { actor } = seen;
  const at = seen.at.toISOString();
  const revealed = actor.session !== undefined ? await revealedRoot(store, actor.session).catch(() => undefined) : undefined;
  await store.coordination.update<SeenHereRow>(SEEN_HERE, `${seen.handle}/${sessionKey(actor)}`, (current) => ({
    handle: seen.handle,
    issue: seen.issue,
    client: actor.client ?? 'unknown',
    session: actor.session ?? null,
    context: contextOf(actor),
    call: actor.call ?? current?.call ?? null,
    spawn_env: actor.spawn_env ?? current?.spawn_env ?? null,
    nonce: actor.nonce,
    source: seen.source ?? current?.source ?? null,
    pending_hint: seen.pendingHint ?? current?.pending_hint ?? null,
    worktree: seen.worktree,
    at: current?.at ?? at,
    last_at: at,
    path: revealed?.transcript_path ?? current?.path ?? null,
    reach: current?.reach ?? null,
  }));
}

/**
 * Notes how far a cut of the context `key` (its session key) reached on its
 * row for attempt `handle`. Returns false, making no row, when this machine
 * has none: rows come only from binding writes.
 */
export async function noteCutReach(store: MachineLocalStore, handle: string, key: string, reach: StepOrigin): Promise<boolean> {
  let found = false;
  await store.coordination.update<SeenHereRow>(SEEN_HERE, `${handle}/${key}`, (current) => {
    found = current !== undefined;
    return current === undefined ? undefined : { ...current, reach };
  });
  return found;
}

/** The rows on this machine, optionally only one attempt's. */
export async function seenHereRows(store: MachineLocalStore, filter: { handle?: string } = {}): Promise<SeenHereRow[]> {
  const rows = (await store.coordination.list<SeenHereRow>(SEEN_HERE)).map((entry) => entry.value);
  return filter.handle === undefined ? rows : rows.filter((row) => row.handle === filter.handle);
}
