// Host repo resolution and the facts a surface reads from it (spec §7, §11):
// the checkout's root, its committed `.grimoire/config.yml`, and the person.
// Plain file reads plus one `git config` call; nothing here opens the tracker.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { runGit } from '../git/run';
import type { Identity } from './context';

/** The `install_format` this release writes and runs against (spec §5: J = K = 1 in v1). */
export const INSTALL_FORMAT_RANGE = { J: 1, K: 1 } as const;

/**
 * The host repo root for a client entry started in `startDir`: the first
 * ancestor (itself included) that holds `.git`, a directory or a `gitdir:`
 * file. The walk never crosses it, so a nested repo stops it. NO_REPO, echoing
 * the start directory, when no ancestor has one.
 */
export async function findHostRoot(startDir: string): Promise<string> {
  let dir = path.resolve(startDir);
  for (;;) {
    if (await stat(path.join(dir, '.git')).catch(() => null)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new GrimoireError('NO_REPO', `no git repository at or above ${path.resolve(startDir)}`, {
        root: path.resolve(startDir),
      });
    }
    dir = parent;
  }
}

export interface CheckoutConfig {
  /** The pinned version (`version:`), or null when the file names none. */
  readonly pin: string | null;
  /** `install_format:`; NaN when present but not a whole number, null when absent. */
  readonly installFormat: number | null;
}

/** The checkout's committed `.grimoire/config.yml`, or null in a checkout grimoire isn't installed in. */
export async function readCheckoutConfig(root: string): Promise<CheckoutConfig | null> {
  let text: string;
  try {
    text = await readFile(path.join(root, '.grimoire', 'config.yml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const scalar = (key: string) =>
    new RegExp(`^${key}:[ \\t]*["']?([^"'\\s#]+)`, 'm').exec(text)?.[1] ?? null;
  const format = scalar('install_format');
  return {
    pin: scalar('version'),
    installFormat: format === null ? null : /^\d+$/.test(format) ? Number(format) : Number.NaN,
  };
}

/** The person: the host repo's `user.name` and `user.email`, each null when unset. */
export async function readPerson(root: string): Promise<Identity> {
  const run = await runGit(root, ['config', '-z', '--get-regexp', '^user\\.(name|email)$']);
  const person: { name: string | null; email: string | null } = { name: null, email: null };
  // Exit 1 means neither is set; anything else unexpected leaves both null too.
  if (run.code !== 0) return person;
  for (const entry of run.stdout.toString('utf8').split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline < 0) continue;
    const key = entry.slice(0, newline).toLowerCase();
    const value = entry.slice(newline + 1);
    // Later entries win, as `git config --get` would pick them.
    if (key === 'user.name') person.name = value;
    if (key === 'user.email') person.email = value;
  }
  return person;
}
