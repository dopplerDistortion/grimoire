// The stray-edit store (spec §6 Records; §15 Stray edits; GLOSSARY: stray
// edit): a generated copy someone changed is saved here before upkeep (or the
// SessionStart fast path) puts the served text back or removes the copy, so
// nothing a person typed is lost. Nothing records one as a skill version on
// its own: a human's `skill record` does (src/core/stray-edits.ts), and
// `skill discard` drops it.
//
// Each stray edit keeps the agent attempts this machine had bound when it was
// found (its seen-here rows, which sweeps later prune): which of them were
// open when the edit appeared is read against the tracker when it is shown.
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { seenHereRows } from '../capture/seen-here';
import type { MachineLocalStore } from '../machine-local';
import type { TrackerView } from '../tracker';
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
  /** When the copy was last written, as the file system says (ISO 8601): when the edit appeared; null when unknown. */
  readonly edited_at?: string | null;
  /** The attempts agents had bound on this machine when it was found (handles), open or not. */
  readonly attempts?: readonly string[];
}

/** A stray edit with its id: what `skill record` and `skill discard` name. */
export interface StrayEditEntry extends StrayEdit {
  readonly id: string;
}

/**
 * Saves a stray edit; the same text from the same copy is saved once, keeping
 * when it was first found. Throws when it can't be saved: the copy must then
 * stay as it is.
 */
export async function setAsideStrayEdit(
  store: MachineLocalStore,
  edit: Omit<StrayEdit, 'sha256' | 'at' | 'edited_at' | 'attempts'>,
): Promise<StrayEditEntry> {
  const sha256 = createHash('sha256').update(edit.text, 'utf8').digest('hex');
  const where = createHash('sha256').update(await worktreeKey(edit.worktree), 'utf8').digest('hex').slice(0, 16);
  const id = `${edit.skill}-${where}-${sha256.slice(0, 16)}`;
  const at = new Date();
  const info = await lstat(path.join(edit.worktree, ...edit.path.split('/'))).catch(() => null);
  const edited = info && info.mtimeMs <= at.getTime() ? new Date(info.mtimeMs).toISOString() : null;
  // Hints only: a store that can't list its rows still saves the edit.
  const attempts = [...new Set((await seenHereRows(store).catch(() => [])).map((row) => row.handle))].sort();
  const saved = await store.records.update<StrayEdit>(
    STRAY_EDITS,
    id,
    (current) => current ?? { ...edit, sha256, at: at.toISOString(), edited_at: edited, attempts },
  );
  return { ...saved!, id };
}

function isStrayEdit(value: unknown): value is StrayEdit {
  const edit = value as Partial<StrayEdit> | null;
  return (
    typeof edit === 'object' &&
    edit !== null &&
    typeof edit.skill === 'string' &&
    typeof edit.worktree === 'string' &&
    typeof edit.path === 'string' &&
    typeof edit.text === 'string' &&
    typeof edit.at === 'string'
  );
}

/** Every stray edit waiting for a human, oldest first. */
export async function listStrayEdits(store: MachineLocalStore): Promise<StrayEditEntry[]> {
  const entries = (await store.records.list<unknown>(STRAY_EDITS))
    .filter((entry): entry is { key: string; value: StrayEdit } => isStrayEdit(entry.value))
    .map(({ key, value }) => ({ ...value, id: key }));
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One stray edit by its id, or null. */
export async function readStrayEdit(store: MachineLocalStore, id: string): Promise<StrayEditEntry | null> {
  const value = await store.records.read<unknown>(STRAY_EDITS, id);
  return isStrayEdit(value) ? { ...value, id } : null;
}

/** Drops one stray edit; false when it was gone already. */
export function dropStrayEdit(store: MachineLocalStore, id: string): Promise<boolean> {
  return store.records.remove(STRAY_EDITS, id);
}

/**
 * Of the attempts `edit` names, those open at some moment between when the
 * edit appeared and when grimoire found it, as `view` records them.
 */
export function openAttemptsOf(view: TrackerView, edit: StrayEdit): string[] {
  const found = Date.parse(edit.at);
  const appeared = Math.min(found, edit.edited_at ? Date.parse(edit.edited_at) : found);
  const named = new Set(edit.attempts ?? []);
  return view
    .allAttempts()
    .filter((attempt) => named.has(attempt.id))
    .filter((attempt) => Date.parse(attempt.start.at) <= found && (attempt.end === null || Date.parse(attempt.end.at) >= appeared))
    .map((attempt) => attempt.id)
    .sort();
}

/** "stray edit to <skill> in <worktree>: Record or Discard" (spec §15); `where` is null for the reader's own worktree. */
export function strayEditNotice(skill: string, where: string | null): string {
  return `stray edit to ${skill}${where ? ` in ${where}` : ''}: Record or Discard`;
}
