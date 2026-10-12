import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
  return cloneAt(root, name, identity);
}

/** The clone `name` under `root`, committing as `identity`. */
function cloneAt(root: string, name: string, identity: GitIdentity): Clone {
  const dir = path.join(root, name);
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

/** Builds a world with real git in `root`: init, clone, commit, push, clone. */
async function buildWorld(root: string): Promise<void> {
  const remote = path.join(root, 'remote.git');
  await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  const remoteUrl = pathToFileURL(remote).href;
  const a = await cloneInto(root, remoteUrl, 'a', ALICE);
  await a.git(['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  await a.git(['push', '--quiet', '--set-upstream', 'origin', 'main']);
  await cloneInto(root, remoteUrl, 'b', BOB);
}

/**
 * The world every test file starts its worlds from: built with real git once
 * per file (each test file has its own module instance), then copied. Process
 * starts are what a test costs on a busy Windows machine; a copy starts none.
 */
let template: { root: string; ready: Promise<void> } | undefined;

function worldTemplate(): { root: string; ready: Promise<void> } {
  if (!template) {
    const root = path.join(os.tmpdir(), `grimoire-git-template-${process.pid}-${randomUUID().slice(0, 8)}`);
    const ready = mkdir(root).then(async () => {
      await buildWorld(await realpath(root));
      // Removed when the test file's worker exits: no world copied from it needs it afterwards.
      process.once('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
    });
    template = { root, ready };
    ready.catch(() => (template = undefined));
  }
  return template;
}

/**
 * Copies the template world into `root`, pointing both clones' `origin` at the
 * copy's remote. A clone's config is the only place the world names a path.
 */
async function copyWorld(root: string): Promise<void> {
  const from = worldTemplate();
  await from.ready;
  const source = await realpath(from.root);
  await cp(source, root, { recursive: true, preserveTimestamps: true });
  const fromUrl = pathToFileURL(path.join(source, 'remote.git')).href;
  const toUrl = pathToFileURL(path.join(root, 'remote.git')).href;
  for (const clone of ['a', 'b']) {
    const config = path.join(root, clone, '.git', 'config');
    const text = await readFile(config, 'utf8');
    if (!text.includes(fromUrl)) throw new Error(`the template clone ${clone} doesn't name ${fromUrl} in ${config}`);
    await writeFile(config, text.replaceAll(fromUrl, toUrl));
  }
}

/**
 * Creates a bare remote whose `main` holds one empty initial commit, and two
 * clones of it (a as Alice, b as Bob) talking to it over a `file://` URL, all
 * in a fresh temp directory. Every git call runs isolated from the user's and
 * the system's config. Call `cleanup()` when done, or use `gitTest`.
 *
 * The repos are a copy of one built with git once per test file (so within a
 * file every world's initial commit is the same commit): the same files git
 * would have written, with this world's remote URL.
 */
export async function createGitWorld(): Promise<GitWorld> {
  const root = await makeTempDir('grimoire-git-');
  try {
    await copyWorld(root);
    const remote = path.join(root, 'remote.git');
    const remoteUrl = pathToFileURL(remote).href;
    const a = cloneAt(root, 'a', ALICE);
    const b = cloneAt(root, 'b', BOB);
    return { root, remote, remoteUrl, a, b, cleanup: () => removeDir(root) };
  } catch (error) {
    await removeDir(root);
    throw error;
  }
}
