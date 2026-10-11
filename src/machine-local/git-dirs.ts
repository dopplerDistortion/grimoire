import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where one checkout's git data lives, found without spawning git. */
export interface GitDirs {
  /** The working tree: the directory that holds `.git` (real path). */
  readonly worktree: string;
  /** This checkout's own git dir (`.git`, or `<common>/worktrees/<name>`). */
  readonly gitDir: string;
  /** The git common directory, shared by every worktree of the clone. */
  readonly commonDir: string;
}

export interface FindGitDirsOptions {
  /**
   * Directories the walk never enters, like git's GIT_CEILING_DIRECTORIES:
   * the walk stops below them.
   */
  readonly ceilings?: readonly string[];
}

/**
 * Walks up from `from` to the first ancestor that holds `.git` and never
 * crosses it: a `.git` directory, or a `gitdir:` file followed through
 * `commondir` (spec §11). Returns null when no ancestor holds `.git`, or when
 * the first `.git` met doesn't lead to a git dir. Never spawns git.
 */
export async function findGitDirs(
  from: string,
  options: FindGitDirsOptions = {},
): Promise<GitDirs | null> {
  const ceilings = new Set((options.ceilings ?? []).map(comparable));
  let dir = path.resolve(from);
  for (;;) {
    if (ceilings.has(comparable(dir))) return null;
    const dotGit = path.join(dir, '.git');
    const info = await stat(dotGit).catch(() => null);
    if (info) return resolveDotGit(dir, dotGit, info.isDirectory());
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveDotGit(
  dir: string,
  dotGit: string,
  isDirectory: boolean,
): Promise<GitDirs | null> {
  let gitDir = dotGit;
  if (!isDirectory) {
    const text = await readFile(dotGit, 'utf8').catch(() => '');
    const match = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
    if (!match) return null;
    gitDir = path.resolve(dir, match[1]!);
    const target = await stat(gitDir).catch(() => null);
    if (!target?.isDirectory()) return null;
  }
  const commondir = await readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => null);
  const commonDir = commondir === null ? gitDir : path.resolve(gitDir, commondir.trim());
  const common = await stat(commonDir).catch(() => null);
  if (!common?.isDirectory()) return null;
  return {
    worktree: await realpath(dir),
    gitDir: await realpath(gitDir),
    commonDir: await realpath(commonDir),
  };
}

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
