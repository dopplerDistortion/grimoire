// The clone's registered worktrees, read from git's own registry: the main
// checkout, and every linked worktree under `<common>/worktrees/<name>/gitdir`.
// A plain clone's main checkout is the folder beside its `.git` (no git
// process); a checkout `core.worktree` names (a submodule's) is read from the
// common dir's config with one `git config` call.
//
// Pruning keeps what these worktrees pin, so a worktree whose pin can't be
// known right now is reported rather than skipped: a locked linked worktree
// whose folder is away (removable media), a main checkout git doesn't record
// (`git clone --separate-git-dir` leaves nothing in the git dir that names
// it), or a config.yml that can't be read.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCheckoutConfig } from '../core/host';
import { runGit } from '../git/run';

async function sameDir(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  if (x === null || y === null) return false;
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => null)) !== null;
}

/** `core.worktree` and `core.bare` from the common dir's own config. */
async function coreConfig(commonDir: string): Promise<{ worktree: string | null; bare: boolean }> {
  const run = await runGit(commonDir, ['config', '--file', path.join(commonDir, 'config'), '-z', '--get-regexp', '^core\\.(worktree|bare)$']);
  const core = { worktree: null as string | null, bare: false };
  // Exit 1: neither is set.
  if (run.code !== 0) return core;
  for (const entry of run.stdout.toString('utf8').split('\0')) {
    if (entry === '') continue;
    const newline = entry.indexOf('\n');
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    // A key with no `=` is boolean true.
    const value = newline < 0 ? null : entry.slice(newline + 1);
    // Later entries win, as `git config --get` would pick them.
    if (key === 'core.worktree' && value !== null) core.worktree = path.resolve(commonDir, value);
    if (key === 'core.bare') core.bare = value === null || /^(true|yes|on|1)$/i.test(value.trim());
  }
  return core;
}

export interface Registry {
  /** Registered worktrees that exist now: the main checkout first (when the clone has one git records), then linked ones. */
  readonly worktrees: string[];
  /** Registered worktrees that can't be reached now; a main checkout git doesn't record is named by the common dir. */
  readonly unreachable: string[];
}

/** The clone's registered worktrees, and those it can't reach now. */
export async function registeredWorktrees(commonDir: string): Promise<Registry> {
  const worktrees: string[] = [];
  const unreachable: string[] = [];

  const beside = path.dirname(commonDir);
  if ((await stat(path.join(beside, '.git')).catch(() => null))?.isDirectory() && (await sameDir(path.join(beside, '.git'), commonDir))) {
    worktrees.push(await realpath(beside));
  } else {
    const core = await coreConfig(commonDir);
    // A main checkout core.worktree names but that is gone is gone: nothing runs from it.
    if (core.worktree !== null) {
      if (await exists(core.worktree)) worktrees.push(await realpath(core.worktree));
    } else if (!core.bare) {
      unreachable.push(commonDir);
    }
  }

  const registry = path.join(commonDir, 'worktrees');
  for (const name of (await readdir(registry).catch(() => [] as string[])).sort()) {
    const pointer = await readFile(path.join(registry, name, 'gitdir'), 'utf8').catch(() => null);
    if (pointer === null) continue;
    const worktree = path.dirname(path.resolve(registry, name, pointer.trim()));
    if (await exists(worktree)) worktrees.push(await realpath(worktree));
    // Away but locked: git keeps it registered, so its pin still counts. Away and unlocked: git prunes it.
    else if (await exists(path.join(registry, name, 'locked'))) unreachable.push(worktree);
  }
  return { worktrees, unreachable };
}

export interface WorktreePin {
  readonly worktree: string;
  /** The version its `.grimoire/config.yml` pins; null when it has no config.yml or no `version:`. */
  readonly pin: string | null;
}

export interface ClonePins {
  /** What each registered worktree that can be read pins right now (its working tree's config.yml). */
  readonly pins: WorktreePin[];
  /** Registered worktrees whose pin can't be known now: unreachable ones, and those whose config.yml can't be read. */
  readonly unknown: string[];
}

/** What the clone's registered worktrees pin right now. */
export async function worktreePins(commonDir: string): Promise<ClonePins> {
  const { worktrees, unreachable } = await registeredWorktrees(commonDir);
  const pins: WorktreePin[] = [];
  const unknown = [...unreachable];
  for (const worktree of worktrees) {
    try {
      pins.push({ worktree, pin: (await readCheckoutConfig(worktree))?.pin ?? null });
    } catch {
      unknown.push(worktree);
    }
  }
  return { pins, unknown };
}
