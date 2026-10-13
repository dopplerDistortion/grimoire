// `hook session-start` (spec §12 SessionStart hook output; spike C B1; spike E
// finding 1). One verb serves both clients, which read its stdout differently:
//
// - Claude Code: plain stdout becomes context; `{"hookSpecificOutput":
//   {"hookEventName":"SessionStart","reloadSkills":true}}` makes it list skill
//   stubs written during the hook on the first turn.
// - Codex: plain stdout becomes a developer message. JSON must match its
//   strict schema (deny_unknown_fields), so a `reloadSkills` key makes Codex
//   fail the hook and drop the line: Codex only ever gets the plain line.
//
// The client is told apart by the payload alone: Codex's SessionStart payload
// always has `permission_mode`, Claude Code's never does. Environment markers
// can't decide it (a Codex started from Claude Code's shell inherits them).

import { strayEditNotice } from '../../generated/stray';
import { SESSION_LINE_MAX, sessionLine, type Pickup } from '../../knowledge/chores/offering';
import { hookFailed } from './debug';
import { leftRunning } from './late';

/** Which client ran the hook. */
export type HookClient = 'claude-code' | 'codex';

/** The client a SessionStart payload comes from; null when it isn't one. */
export function sessionStartClient(payload: unknown): HookClient | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  if (fields.hook_event_name !== 'SessionStart') return null;
  return 'permission_mode' in fields ? 'codex' : 'claude-code';
}

/** What the hook has to say: at most one line (§12's priorities pick it), and whether skill stubs were written. */
export interface SessionStartMessage {
  readonly line?: string | null;
  readonly reloadSkills?: boolean;
}

/** The hook's stdout for a client: '' when there is nothing to say. */
export function sessionStartOutput(client: HookClient | null, message: SessionStartMessage): string {
  const line = message.line ?? null;
  if (client === 'claude-code' && message.reloadSkills) {
    const output = { hookEventName: 'SessionStart', reloadSkills: true, ...(line === null ? {} : { additionalContext: line }) };
    return `${JSON.stringify({ hookSpecificOutput: output })}\n`;
  }
  return line === null ? '' : `${line}\n`;
}

export interface SessionStartContext {
  /** Where the client started the hook: `--from`, else the hook's cwd. */
  readonly startDir: string;
  /** How long into the hook the fast path may start work (default FAST_PATH_BUDGET_MS); a test seam. */
  readonly fastPathBudgetMs?: number;
  /** What reads the chore facts (default: the tracker, as knowledgeFacts does); a test seam. */
  readonly readKnowledge?: () => Promise<KnowledgeFacts | null>;
}

export { SESSION_LINE_MAX };
/** Past this long into the hook, the fast path starts no more work: the clients give the hook 10 s. */
const FAST_PATH_BUDGET_MS = 7_000;

/** The stray edits waiting for a human, as one line: "stray edit to <skill> in <worktree>: Record or Discard" (spec §15). */
export function strayEditsLine(edits: readonly { skill: string; where: string | null }[]): string | null {
  if (edits.length === 0) return null;
  if (edits.length === 1) {
    const [edit] = edits;
    const full = `grimoire: ${strayEditNotice(edit!.skill, edit!.where)}`;
    return full.length <= SESSION_LINE_MAX ? full : `grimoire: ${strayEditNotice(edit!.skill, null)}`;
  }
  const names = [...new Set(edits.map((edit) => edit.skill))];
  let shown = names.join(', ');
  const line = (list: string) => `grimoire: ${edits.length} stray edits to evolved skills (${list}): Record or Discard`;
  while (line(shown).length > SESSION_LINE_MAX && names.length > 1) {
    names.pop();
    shown = `${names.join(', ')}, …`;
  }
  return line(shown);
}

/** §12's last priority: stray edits and refreshed pointer files, together when they fit. */
function lastPriorityLine(strays: string | null, refreshed: string | null): string | null {
  if (strays && refreshed) return `${strays}; ${refreshed}`.length <= SESSION_LINE_MAX ? `${strays}; ${refreshed}` : strays;
  return strays ?? refreshed;
}

/**
 * What this session start has to say, and does first: the skill fast path
 * makes this worktree's copies and stubs match the served set (src/generated/
 * fast-path.ts), and `reloadSkills` says they changed meanwhile. The line is
 * the highest of §12's priorities that applies: the pin mismatch, a due chore
 * (noting pending proposals), pending proposals alone, then the stray edits
 * waiting for a human and the content pointer files upkeep refreshed, until
 * they are committed. The not-joined notice never reaches this code: the
 * bootstrap and the launcher print it when there is no launcher, copy or join
 * record.
 */
async function compose(payload: unknown, ctx: SessionStartContext): Promise<SessionStartMessage> {
  const started = Date.now();
  const [{ findHostRoot, readCheckoutConfig }, { locateMachineLocalStore }, { refreshedPointerFiles, refreshNotice }, { sessionStartFastPath }, { listStrayEdits }, { worktreeKey }] =
    await Promise.all([
      import('../../core/host'),
      import('../../machine-local'),
      import('../../upkeep/refreshed'),
      import('../../generated/fast-path'),
      import('../../generated/stray'),
      import('../../upkeep/checkout'),
    ]);
  const root = await findHostRoot(ctx.startDir).catch(() => null);
  const store = root === null ? null : await locateMachineLocalStore(root);
  if (!store || root === null) return {};
  const deadline = started + (ctx.fastPathBudgetMs ?? FAST_PATH_BUDGET_MS);
  const pin = (await readCheckoutConfig(root).catch(() => null))?.pin ?? null;
  // The knowledge facts read the tracker while the fast path writes the copies: neither waits for the other.
  // Past the same budget the hook stops waiting for them and says what it knows without.
  const [fast, knowledge, pinMismatch] = await Promise.all([
    sessionStartFastPath(store, root, { deadline }).catch((error: unknown) => {
      hookFailed(error);
      return null;
    }),
    byDeadline(
      () =>
        (ctx.readKnowledge?.() ?? knowledgeFacts(store, root)).catch((error: unknown) => {
          hookFailed(error);
          return null;
        }),
      deadline,
    ),
    byDeadline(
      () =>
        pinMismatchNotice(store, root, pin, payload).catch((error: unknown) => {
          hookFailed(error);
          return null;
        }),
      deadline,
    ),
  ]);
  await markCodexSession(store, payload).catch(() => {});
  const changed = fast?.changed === true;
  const refreshed = await refreshedPointerFiles(store, root).catch(() => null);
  const own = await worktreeKey(root);
  const strays = await listStrayEdits(store).catch(() => []);
  const edits = await Promise.all(strays.map(async (edit) => ({ skill: edit.skill, where: (await worktreeKey(edit.worktree)) === own ? null : edit.worktree })));
  const line = sessionLine({
    pinMismatch,
    choreDue: knowledge?.choreDue ?? null,
    proposalsPending: knowledge?.proposalsPending ?? 0,
    last: lastPriorityLine(strayEditsLine(edits), refreshed ? refreshNotice(refreshed.paths.length, null) : null),
  });
  return { ...(line ? { line } : {}), ...(changed ? { reloadSkills: true } : {}) };
}

/**
 * The pin-mismatch notice (spec §8's wording): a `grimoire mcp` of this
 * client still serves this worktree on another pin than the checkout's now.
 * The hook itself always runs the checkout's pin (the launcher runs only
 * that), but a server outlives a pull, merge or switch: a clear, compact or
 * resume keeps the session's server. A fresh start launches its own server
 * on the checkout's pin, so an old one then belongs to another session.
 * Process records don't name their session: any such server of this client
 * in this worktree counts.
 */
async function pinMismatchNotice(store: import('../../machine-local').MachineLocalStore, root: string, pin: string | null, payload: unknown): Promise<string | null> {
  const fields = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (pin === null || fields.source === 'startup') return null;
  const client = sessionStartClient(payload);
  const { worktreeKey } = await import('../../upkeep/checkout');
  const own = await worktreeKey(root);
  const ofThisClient = (name: string | null) => name === null || client === null || name.startsWith('codex') === (client === 'codex');
  const candidates = await store.processes.liveWhere((record) => record.role === 'mcp' && record.worktree !== null && record.pin !== pin && ofThisClient(record.client));
  for (const record of candidates) {
    if ((await worktreeKey(record.worktree!)) === own) return `grimoire: this checkout now pins ${pin}; this session runs ${record.pin}; restart it`;
  }
  return null;
}

/**
 * `work`'s value, or null once `deadline` (epoch ms) passes first; past it
 * already, the work never starts. Work still running at the deadline is left
 * running (./late.ts): the hook's process ends without waiting for it.
 */
async function byDeadline<T>(work: () => Promise<T | null>, deadline: number): Promise<T | null> {
  if (!Number.isFinite(deadline)) return work();
  if (Date.now() >= deadline) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
  });
  const running = work();
  try {
    const value = await Promise.race([running.then((result) => ({ result })), late]);
    if (value === null) {
      leftRunning(running);
      return null;
    }
    return value.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a chore is due here and how this machine picks it up, and how many skill proposals wait for a person. */
export interface KnowledgeFacts {
  readonly choreDue: Pickup | null;
  readonly proposalsPending: number;
}

/**
 * Whether a chore is due here now, and how this machine picks it up; and how
 * many skill proposals wait for a person. Null without a tracker to read.
 */
async function knowledgeFacts(store: import('../../machine-local').MachineLocalStore, root: string): Promise<KnowledgeFacts | null> {
  const [{ openTracker }, { dueChoresIn }, { machineSetting }, { proposalSignals }] = await Promise.all([
    import('../../tracker'),
    import('../../core/chores'),
    import('../../core/settings'),
    import('../../knowledge'),
  ]);
  const tracker = await openTracker(root).catch(() => null);
  if (tracker === null) return null;
  try {
    // No tracker fetched yet, or one this release can't read: nothing to say about chores (status says why).
    const view = await tracker.read().catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 'NOT_SYNCED' || (error as { code?: unknown }).code === 'UPGRADE_REQUIRED') return null;
      throw error;
    });
    if (view === null) return null;
    const proposals = await proposalSignals(view);
    const due = await dueChoresIn(view, store, tracker.now(), proposals);
    const pickup = due.next === null ? null : ((await machineSetting(store.commonDir, 'knowledge.pickup')) as Pickup);
    return { choreDue: pickup, proposalsPending: proposals.pendingCount };
  } finally {
    await tracker.close();
  }
}

/**
 * A Codex session's mark (spec §21, Codex re-approval; §6 revealed transcript
 * roots): the transcript its payload reveals, keyed by its session id. Codex
 * runs this hook only once it is approved, so a Codex-spawned server that finds
 * no mark for its session tells the session to approve it in `/hooks`.
 */
async function markCodexSession(store: import('../../machine-local').MachineLocalStore, payload: unknown): Promise<void> {
  if (sessionStartClient(payload) !== 'codex') return;
  const { session_id, transcript_path } = payload as Record<string, unknown>;
  if (typeof session_id !== 'string' || session_id === '' || typeof transcript_path !== 'string' || transcript_path === '') return;
  const { recordRevealedRoot } = await import('../../capture/transcript-roots');
  await recordRevealedRoot(store, { client: 'codex', session: session_id, transcriptPath: transcript_path });
}

/** The verb's body: the payload in, what to print out. */
export async function sessionStart(payloadText: string, ctx: SessionStartContext): Promise<string> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    // An unreadable payload still gets the plain line, which both clients accept.
  }
  return sessionStartOutput(sessionStartClient(payload), await compose(payload, ctx));
}
