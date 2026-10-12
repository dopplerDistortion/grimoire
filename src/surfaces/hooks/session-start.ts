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
import { hookFailed } from './debug';

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

/** The hook's line is at most this long (spec §12). */
export const SESSION_LINE_MAX = 200;
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
 * fast-path.ts), and `reloadSkills` says it wrote any. The line is so far
 * only the last of §12's priorities: the stray edits waiting for a human, and
 * the content pointer files upkeep refreshed, until they are committed. The
 * higher priorities (pin mismatch, due chores, proposals) plug in here. The
 * not-joined notice never reaches this code: the bootstrap and the launcher
 * print it when there is no launcher, copy or join record.
 */
async function compose(_payload: unknown, ctx: SessionStartContext): Promise<SessionStartMessage> {
  const started = Date.now();
  const [{ findHostRoot }, { locateMachineLocalStore }, { refreshedPointerFiles, refreshNotice }, { sessionStartFastPath }, { listStrayEdits }, { worktreeKey }] =
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
  const fast = await sessionStartFastPath(store, root, { deadline: started + FAST_PATH_BUDGET_MS }).catch((error: unknown) => {
    hookFailed(error);
    return null;
  });
  const wrote = (fast?.wrote.length ?? 0) > 0;
  const refreshed = await refreshedPointerFiles(store, root).catch(() => null);
  const own = await worktreeKey(root);
  const strays = await listStrayEdits(store).catch(() => []);
  const edits = await Promise.all(strays.map(async (edit) => ({ skill: edit.skill, where: (await worktreeKey(edit.worktree)) === own ? null : edit.worktree })));
  const line = lastPriorityLine(strayEditsLine(edits), refreshed ? refreshNotice(refreshed.paths.length, null) : null);
  return { ...(line ? { line } : {}), ...(wrote ? { reloadSkills: true } : {}) };
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
