import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
async function buildWorld(root: string): Promise<GitWorld> {
  const remote = path.join(root, 'remote.git');
  await git(root, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  const remoteUrl = pathToFileURL(remote).href;
  const a = await cloneInto(root, remoteUrl, 'a', ALICE);
  await a.git(['commit', '--quiet', '--allow-empty', '-m', 'initial commit']);
  await a.git(['push', '--quiet', '--set-upstream', 'origin', 'main']);
  const b = await cloneInto(root, remoteUrl, 'b', BOB);
  return { root, remote, remoteUrl, a, b, cleanup: () => removeDir(root) };
}

/** What a template world holds beyond a fresh world's state, built once and copied with it. */
export interface WorldTemplate {
  /** Names the template: worlds asking for the same name share one. */
  readonly name: string;
  /** Brings a fresh world to the template's state (with real git and the code under test). */
  prepare(world: GitWorld): Promise<void>;
}

/**
 * The worlds a test file starts its worlds from, by template name: each built
 * with real git once per file (each test file has its own module instance),
 * then copied. Process starts are what a test costs on a busy Windows
 * machine; a copy starts none.
 */
const templates = new Map<string, { root: string; ready: Promise<void> }>();

/** Every template root this file built, until removeWorldTemplates removes it, with its exit fallback. */
const templateRoots = new Map<string, { ready: Promise<void>; onExit: () => void }>();

/**
 * Removes every template world this test file built (setup.ts runs it after
 * each file: a Vitest worker's exit handlers don't run). A world asked for
 * afterwards builds its template again.
 */
export async function removeWorldTemplates(): Promise<void> {
  templates.clear();
  const roots = [...templateRoots];
  templateRoots.clear();
  for (const [root, { ready, onExit }] of roots) {
    await ready.catch(() => undefined);
    process.off('exit', onExit);
    await removeDir(root);
  }
}

function worldTemplate(template: WorldTemplate | undefined): { root: string; ready: Promise<void> } {
  const name = template?.name ?? '';
  let built = templates.get(name);
  if (!built) {
    const root = path.join(os.tmpdir(), `grimoire-git-template-${process.pid}-${randomUUID().slice(0, 8)}`);
    // Only a fallback: removeWorldTemplates removes it once the file is done.
    const onExit = () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    process.once('exit', onExit);
    const ready = mkdir(root).then(async () => {
      const world = await buildWorld(await realpath(root));
      await template?.prepare(world);
      // git's sample hooks never run (none is named as a hook), but every copy would write them
      // again for the virus scanner to read: the copies get the hooks folders without them.
      for (const hooks of [path.join(world.remote, 'hooks'), path.join(world.a.dir, '.git', 'hooks'), path.join(world.b.dir, '.git', 'hooks')]) {
        for (const file of await readdir(hooks)) if (file.endsWith('.sample')) await rm(path.join(hooks, file));
      }
    }).catch(async (error: unknown) => {
      // A failed build leaves nothing behind, and the next world asking for it builds it again.
      if (templates.get(name)?.root === root) templates.delete(name);
      templateRoots.delete(root);
      process.off('exit', onExit);
      await removeDir(root);
      throw error;
    });
    built = { root, ready };
    templates.set(name, built);
    templateRoots.set(root, { ready, onExit });
  }
  return built;
}

/**
 * Copies a template world into `root`, pointing both clones' `origin` at the
 * copy's remote. A clone's config is the only place the world names a path.
 */
async function copyWorld(root: string, template: WorldTemplate | undefined): Promise<void> {
  const from = worldTemplate(template);
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
 * would have written, with this world's remote URL. `template` names further
 * state built into that one world once (such as an initialized tracker), so
 * every copy starts with it.
 */
export async function createGitWorld(template?: WorldTemplate): Promise<GitWorld> {
  const root = await makeTempDir('grimoire-git-');
  try {
    await copyWorld(root, template);
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
