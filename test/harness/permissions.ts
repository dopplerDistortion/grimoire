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
  const run = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
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
