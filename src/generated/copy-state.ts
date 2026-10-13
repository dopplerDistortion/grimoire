// Copy-state rows (spec §6 Caches): per worktree, the version grimoire last
// put in each skill's copy, so a stray edit found later names the version it
// was made on (what `skill record` checks its base against). A cache: one that
// is missing or that another release wrote is rebuilt empty, and a stray edit
// found meanwhile names no base.
import { createHash } from 'node:crypto';
import type { MachineLocalStore } from '../machine-local';
import { worktreeKey } from '../upkeep/checkout';

const CACHE_VERSION = 1;

/** Skill name → the version grimoire last wrote to (or found in) that skill's copy. */
export type CopyState = Record<string, string>;

async function cacheName(worktree: string): Promise<string> {
  return `copy-state-${createHash('sha256').update(await worktreeKey(worktree), 'utf8').digest('hex').slice(0, 24)}`;
}

function valid(value: unknown): CopyState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The copy state of `worktree`; empty when the cache is missing or unreadable. */
export async function readCopyState(store: MachineLocalStore, worktree: string): Promise<CopyState> {
  const name = await cacheName(worktree);
  return valid(await store.caches.get<unknown>(name, { version: CACHE_VERSION, build: () => ({}) }).catch(() => ({})));
}

/** Replaces the copy state of `worktree`; a failure only costs a later stray edit its base. */
export async function writeCopyState(store: MachineLocalStore, worktree: string, state: CopyState): Promise<void> {
  const name = await cacheName(worktree);
  try {
    await store.caches.invalidate(name);
    await store.caches.get(name, { version: CACHE_VERSION, build: () => state });
  } catch {
    // A cache: rebuilt when missing.
  }
}
