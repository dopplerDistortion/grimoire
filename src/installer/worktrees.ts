// The clone's registered worktrees, read from git's own registry without
// spawning git: the main checkout beside the common dir, and every linked
// worktree under `<common>/worktrees/<name>/gitdir`.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCheckoutConfig } from '../core/host';

async function sameDir(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  if (x === null || y === null) return false;
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Every registered worktree that still exists: the main checkout first (when the clone isn't bare), then linked ones. */
export async function registeredWorktrees(commonDir: string): Promise<string[]> {
  const found: string[] = [];
  const main = path.dirname(commonDir);
  if ((await stat(path.join(main, '.git')).catch(() => null))?.isDirectory() && (await sameDir(path.join(main, '.git'), commonDir))) {
    found.push(await realpath(main));
  }
  const registry = path.join(commonDir, 'worktrees');
  for (const name of (await readdir(registry).catch(() => [] as string[])).sort()) {
    const pointer = await readFile(path.join(registry, name, 'gitdir'), 'utf8').catch(() => null);
    if (pointer === null) continue;
    const worktree = path.dirname(path.resolve(registry, name, pointer.trim()));
    if (await stat(worktree).catch(() => null)) found.push(await realpath(worktree));
  }
  return found;
}

export interface WorktreePin {
  readonly worktree: string;
  /** The version its `.grimoire/config.yml` pins; null when it has none or no config.yml. */
  readonly pin: string | null;
}

/** What each registered worktree pins right now (its working tree's config.yml). */
export async function worktreePins(commonDir: string): Promise<WorktreePin[]> {
  const worktrees = await registeredWorktrees(commonDir);
  return Promise.all(
    worktrees.map(async (worktree) => ({
      worktree,
      pin: (await readCheckoutConfig(worktree).catch(() => null))?.pin ?? null,
    })),
  );
}
