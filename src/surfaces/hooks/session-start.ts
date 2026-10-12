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
}

/**
 * What this session start has to say, and does first: the skill fast path
 * writes the copies and stubs this worktree is missing (src/generated/
 * fast-path.ts), and `reloadSkills` says so. The line is so far only the last
 * of §12's priorities: the content pointer files upkeep refreshed, until they
 * are committed. The higher priorities (pin mismatch, due chores, proposals,
 * stray edits) plug in here. The not-joined notice never reaches this code:
 * the bootstrap and the launcher print it when there is no launcher, copy or
 * join record.
 */
async function compose(payload: unknown, ctx: SessionStartContext): Promise<SessionStartMessage> {
  const [{ findHostRoot }, { locateMachineLocalStore }, { refreshedPointerFiles, refreshNotice }, { writeMissingOutput }] = await Promise.all([
    import('../../core/host'),
    import('../../machine-local'),
    import('../../upkeep/refreshed'),
    import('../../generated/fast-path'),
  ]);
  const root = await findHostRoot(ctx.startDir).catch(() => null);
  const store = root === null ? null : await locateMachineLocalStore(root);
  if (!store || root === null) return {};
  await markCodexSession(store, payload).catch(() => {});
  const wrote = await writeMissingOutput(store, root).catch(() => false);
  const refreshed = await refreshedPointerFiles(store, root).catch(() => null);
  return { ...(refreshed ? { line: refreshNotice(refreshed.paths.length, null) } : {}), ...(wrote ? { reloadSkills: true } : {}) };
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
