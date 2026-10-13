// The Attention queue's size and empty state (spec §20). It fails closed: a
// section the core couldn't read (`unreadable`) is an error item of its own,
// so the queue never reads "Nothing needs you" while it may hide something.
import type { AttentionResult, UnreadableSection } from './types';

export const EMPTY = 'Nothing needs you. Agents are working through the frontier.';

const SECTIONS: Readonly<Record<UnreadableSection['section'], string>> = {
  stray_edits: 'stray edits waiting on this machine',
  knowledge: 'the knowledge items (the pending proposal, skill forks, wiki conflicts, set-aside pairs, flagged pages)',
};

/** How many rows the queue shows: the items, each unreadable section, and this machine's runner trouble. */
export function queueSize(result: AttentionResult, runnerTrouble: boolean): number {
  return result.items.length + (result.unreadable?.length ?? 0) + (runnerTrouble ? 1 : 0);
}

/** The empty state's text, or null when the queue shows something (an unreadable section included). */
export function emptyState(result: AttentionResult, runnerTrouble: boolean): string | null {
  return queueSize(result, runnerTrouble) === 0 ? EMPTY : null;
}

/** The title of the error item for a section the core couldn't read. */
export function unreadableTitle(section: UnreadableSection['section']): string {
  return `grimoire couldn’t read ${SECTIONS[section] ?? section}: some of what needs you may be missing here`;
}
