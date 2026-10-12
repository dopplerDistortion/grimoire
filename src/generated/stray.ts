// The stray-edit store (spec §6 Records; §15 Stray edits; GLOSSARY: stray
// edit): a generated copy someone changed is saved here before upkeep puts the
// served text back or removes the copy, so nothing a person typed is lost.
// Nothing records one as a skill version on its own: that is a human's
// `skill record`; showing, recording and discarding them belong to the stray
// edit slice.
import { createHash } from 'node:crypto';
import type { MachineLocalStore } from '../machine-local';
import { worktreeKey } from '../upkeep/checkout';

/** Records kind of the stray-edit store. */
export const STRAY_EDITS = 'stray-edits';

/** One stray edit, as saved. */
export interface StrayEdit {
  readonly skill: string;
  /** The worktree whose copy held it. */
  readonly worktree: string;
  /** POSIX path of the copy, relative to the worktree. */
  readonly path: string;
  /** The copy's text as found. */
  readonly text: string;
  /** The sha256 of `text`. */
  readonly sha256: string;
  /** The version grimoire last put in that copy, which the edit was made on; null when unknown. */
  readonly base: string | null;
  /** The version the worktree was served when it was found; null when none was. */
  readonly served: string | null;
  /** When it was found (ISO 8601). */
  readonly at: string;
}

/**
 * Saves a stray edit; the same text from the same copy is saved once, keeping
 * when it was first found. Throws when it can't be saved: the copy must then
 * stay as it is.
 */
export async function setAsideStrayEdit(
  store: MachineLocalStore,
  edit: Omit<StrayEdit, 'sha256' | 'at'>,
): Promise<StrayEdit> {
  const sha256 = createHash('sha256').update(edit.text, 'utf8').digest('hex');
  const where = createHash('sha256').update(await worktreeKey(edit.worktree), 'utf8').digest('hex').slice(0, 16);
  const key = `${edit.skill}-${where}-${sha256.slice(0, 16)}`;
  const saved = await store.records.update<StrayEdit>(STRAY_EDITS, key, (current) => current ?? { ...edit, sha256, at: new Date().toISOString() });
  return saved!;
}
