// Revealed transcript roots (spec §6 Records, §14 Roots; spike A T1): the
// transcript path a hook payload carries, recorded machine-locally by session,
// for cuts and later sweeps to search. The hint never carries it: Claude
// Code's auto-mode classifier denies calls whose hint holds a path.
//
// Small on purpose: the `pre-tool-use` hook loads it.
import type { MachineLocalStore } from '../machine-local';

/** The records kind (spec §6: revealed transcript roots). */
export const TRANSCRIPT_ROOTS = 'transcript-roots';

/** One session's transcript, as a hook revealed it. */
export interface RevealedRoot {
  readonly client: 'claude-code' | 'codex';
  readonly session: string;
  /** The session's own transcript file. A Claude subagent's is `<this without .jsonl>/subagents/agent-<agent_id>.jsonl`. */
  readonly transcript_path: string;
  /**
   * The folder to search: Claude Code's `projects/<slug>/` (the transcript's
   * folder); Codex's home (the folder holding `sessions/` or `archived_sessions/`).
   */
  readonly root: string;
  /** When it was recorded (ISO 8601). */
  readonly at: string;
}

/** The parent folder of a path in either separator, whatever the platform. */
function parentOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut > 0 ? file.slice(0, cut) : file;
}

function rootOf(client: RevealedRoot['client'], transcriptPath: string): string {
  const folder = parentOf(transcriptPath);
  if (client === 'claude-code') return folder;
  // Codex: <home>/sessions/YYYY/MM/DD/rollout-….jsonl, or <home>/archived_sessions/rollout-….jsonl.
  for (let dir = folder; parentOf(dir) !== dir; dir = parentOf(dir)) {
    const name = dir.slice(parentOf(dir).length + 1);
    if (name === 'sessions' || name === 'archived_sessions') return parentOf(dir);
  }
  return folder;
}

/**
 * Records `transcriptPath` for `session`, unless that exact path is recorded
 * already. Throws what the store throws; callers that must never fail (hooks)
 * catch it.
 */
export async function recordRevealedRoot(
  store: MachineLocalStore,
  revealed: { client: RevealedRoot['client']; session: string; transcriptPath: string },
  now: Date = new Date(),
): Promise<void> {
  const current = await store.records.read<RevealedRoot>(TRANSCRIPT_ROOTS, revealed.session);
  if (current?.transcript_path === revealed.transcriptPath && current.client === revealed.client) return;
  const record: RevealedRoot = {
    client: revealed.client,
    session: revealed.session,
    transcript_path: revealed.transcriptPath,
    root: rootOf(revealed.client, revealed.transcriptPath),
    at: now.toISOString(),
  };
  await store.records.write(TRANSCRIPT_ROOTS, revealed.session, record);
}

/** The transcript a hook revealed for `session`, if any. */
export function revealedRoot(store: MachineLocalStore, session: string): Promise<RevealedRoot | undefined> {
  return store.records.read<RevealedRoot>(TRANSCRIPT_ROOTS, session);
}

/** Every revealed transcript, for sweeps to search. */
export async function revealedRoots(store: MachineLocalStore): Promise<RevealedRoot[]> {
  return (await store.records.list<RevealedRoot>(TRANSCRIPT_ROOTS)).map((entry) => entry.value);
}
