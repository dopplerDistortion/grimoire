import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunResult } from './process';
import { git, gitResult, type GitOptions } from './git';
import { makeTempDir, removeDir } from './temp';

export interface GitIdentity {
  name: string;
  email: string;
}

export const ALICE: GitIdentity = { name: 'Alice Example', email: 'alice@example.com' };
export const BOB: GitIdentity = { name: 'Bob Example', email: 'bob@example.com' };

/** One working tree: a clone's main checkout or a linked worktree. */
export interface Checkout {
  /** Absolute real path of the working tree. */
  readonly dir: string;
  /** Runs git here; returns trimmed stdout, throws GitError on failure. */
  git(args: readonly string[], options?: GitOptions): Promise<string>;
  /** Runs git here; never throws on a non-zero exit. */
  gitResult(args: readonly string[], options?: GitOptions): Promise<RunResult>;
  /** Writes a file (creating folders), stages and commits it; returns the commit sha. */
  commitFile(relPath: string, content: string, message?: string): Promise<string>;
}

export interface Clone extends Checkout {
  /** The user.name / user.email in this clone's local config. */
  readonly identity: GitIdentity;
  /** Adds a linked worktree on a new branch `name`, next to the clone. */
  addWorktree(name: string): Promise<Checkout>;
}

export interface GitWorld {
  /** The temp directory that holds everything below. */
  readonly root: string;
  /** Path of the bare remote repository. */
  readonly remote: string;
  /** The `file://` URL both clones use as `origin`. */
  readonly remoteUrl: string;
  /** Clone a, committing as Alice. */
  readonly a: Clone;
  /** Clone b, committing as Bob. */
  readonly b: Clone;
  /** Removes the whole world from disk. */
  cleanup(): Promise<void>;
}

function checkoutAt(dir: string): Checkout {
  return {
    dir,
    git: (args, options) => git(dir, args, options),
    gitResult: (args, options) => gitResult(dir, args, options),
    async commitFile(relPath, content, message = `commit ${relPath}`) {
      const file = path.join(dir, relPath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      await git(dir, ['add', '--', relPath]);
      await git(dir, ['commit', '--quiet', '-m', message]);
      return git(dir, ['rev-parse', 'HEAD']);
    },
  };
}

async function cloneInto(
  root: string,
  remoteUrl: string,
  name: string,
  identity: GitIdentity,
): Promise<Clone> {
  const dir = path.join(root, name);
  await git(root, [
    'clone',
    '--quiet',
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`,
    remoteUrl,
    dir,
  ]);
  return {
    ...checkoutAt(dir),
    identity,
    async addWorktree(branch) {
      const worktreeDir = path.join(root, `${name}-wt-${branch}`);
      await git(dir, ['worktree', 'add', '--quiet', '-b', branch, worktreeDir]);
      return checkoutAt(worktreeDir);
    },
  };
}

/**
 * Creates a bare remote whose `main` holds one empty initial commit, and two
 * clones of it (a as Alice, b as Bob) talking to it over a `file://` URL, all
 * in a fresh temp directory. Every git call runs isolated from the user's and
 * the system's config. Call `cleanup()` when done, or use `gitTest`.
 */
export async function createGitWorld(): Promise<GitWorld> {
  const root = await makeTempDir('grimoire-git-');
  try {
    const remote = path.join(root, 'remote.git');
    await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    const remoteUrl = pathToFileURL(remote).href;

    const a = await cloneInto(root, remoteUrl, 'a', ALICE);
    await a.git(['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
    await a.git(['push', '--quiet', '--set-upstream', 'origin', 'main']);
    const b = await cloneInto(root, remoteUrl, 'b', BOB);

    return { root, remote, remoteUrl, a, b, cleanup: () => removeDir(root) };
  } catch (error) {
    await removeDir(root);
    throw error;
  }
}
