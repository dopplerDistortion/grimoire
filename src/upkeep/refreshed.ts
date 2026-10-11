// The content pointer files upkeep refreshed that still wait to be committed
// (spec §13: "grimoire refreshed N pointer files: commit them"; §12 status and
// the session line). A machine-local record per worktree, kept by upkeep's
// refresh part and read by `status`, the dashboard and the SessionStart hook;
// light on purpose, as the hook reads it.
import { runGit } from '../git/run';
import type { MachineLocalStore } from '../machine-local';
import { worktreeKey } from './checkout';

/** Records kind: per worktree, the content pointer files upkeep refreshed that still wait to be committed. */
export const POINTER_REFRESH_RECORDS = 'pointer-refresh';

export interface PointerRefreshRecord {
  readonly worktree: string;
  /** POSIX paths relative to the worktree. */
  readonly paths: string[];
  /** When upkeep last refreshed one (epoch ms). */
  readonly at: number;
}

/** "grimoire refreshed N pointer files: commit them" (spec §13), for one worktree. */
export function refreshNotice(count: number, worktree: string | null): string {
  const files = count === 1 ? '1 pointer file' : `${count} pointer files`;
  return `grimoire refreshed ${files}${worktree ? ` in ${worktree}` : ''}: commit ${count === 1 ? 'it' : 'them'}`;
}

/** Of `paths`, those git still sees as changed or untracked in `worktree`. */
async function uncommitted(worktree: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const run = await runGit(worktree, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths]);
  if (run.code !== 0) return [...paths];
  const changed = new Set(
    run.stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3)),
  );
  return paths.filter((file) => changed.has(file));
}

/**
 * The content pointer files upkeep refreshed in `worktree` that aren't
 * committed yet, as `status` and the session line report them ("commit
 * them"; never stubs or copies).
 */
export async function refreshedPointerFiles(store: MachineLocalStore, worktree: string): Promise<PointerRefreshRecord | null> {
  const record = await store.records.read<PointerRefreshRecord>(POINTER_REFRESH_RECORDS, await worktreeKey(worktree));
  if (!record || !Array.isArray(record.paths)) return null;
  const paths = await uncommitted(worktree, record.paths);
  return paths.length === 0 ? null : { ...record, paths };
}

/** Keeps the record of refreshed files waiting to be committed: the new ones added, committed ones dropped. */
export async function noteRefreshed(store: MachineLocalStore, worktree: string, refreshed: readonly string[]): Promise<void> {
  const key = await worktreeKey(worktree);
  const current = await store.records.read<PointerRefreshRecord>(POINTER_REFRESH_RECORDS, key);
  const known = Array.isArray(current?.paths) ? current.paths : [];
  if (known.length === 0 && refreshed.length === 0) return;
  const paths = await uncommitted(worktree, [...new Set([...known, ...refreshed])]);
  if (paths.length === 0) {
    await store.records.remove(POINTER_REFRESH_RECORDS, key);
    return;
  }
  await store.records.write<PointerRefreshRecord>(POINTER_REFRESH_RECORDS, key, {
    worktree,
    paths,
    at: refreshed.length > 0 ? Date.now() : (current?.at ?? Date.now()),
  });
}
