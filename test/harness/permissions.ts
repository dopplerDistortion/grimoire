import { spawnSync } from 'node:child_process';
import { chmod, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Whether this process can be refused a write by permissions at all (root ignores POSIX modes). */
export const permissionsApply = process.platform === 'win32' || process.getuid?.() !== 0;

async function chmodTree(dir: string, dirMode: number, fileMode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await chmodTree(full, dirMode, fileMode);
    else await chmod(full, fileMode);
  }
  await chmod(dir, dirMode);
}

function icacls(args: string[]): void {
  // Bounded: icacls runs synchronously, so a stall must not block the worker past every vitest timeout.
  const run = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (run.error !== undefined) throw new Error(`icacls ${args.join(' ')} did not finish: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`icacls ${args.join(' ')} failed: ${run.stdout}${run.stderr}`);
}

/**
 * Makes `dir` and everything below it unwritable for this user, the way a
 * sandbox keeps `.git/` read-only for an agent's shell (spike F): reads still
 * work; creating, writing or renaming files fails (EPERM on Windows, EACCES
 * elsewhere). Returns the undo.
 */
export async function makeUnwritable(dir: string): Promise<() => Promise<void>> {
  if (process.platform === 'win32') {
    // Write data, append data, write (extended) attributes: not DELETE or
    // SYNCHRONIZE, whose denial would refuse reads too.
    const user = os.userInfo().username;
    icacls([dir, '/deny', `${user}:(OI)(CI)(WD,AD,WEA,WA)`]);
    return async () => icacls([dir, '/remove:d', user]);
  }
  await chmodTree(dir, 0o555, 0o444);
  return () => chmodTree(dir, 0o755, 0o644);
}

/**
 * Makes `dir` itself unlistable for this user: reading its entries fails
 * (EPERM on Windows, EACCES elsewhere) while the folder still exists, the way
 * an ACL, a sandbox or a full handle table refuses a listing. Returns the undo.
 */
export async function makeUnlistable(dir: string): Promise<() => Promise<void>> {
  if (process.platform === 'win32') {
    // List folder (read data) only, on the folder itself: not inherited, so its files stay readable.
    const user = os.userInfo().username;
    icacls([dir, '/deny', `${user}:(RD)`]);
    return async () => icacls([dir, '/remove:d', user]);
  }
  await chmod(dir, 0o300);
  return () => chmod(dir, 0o755);
}
