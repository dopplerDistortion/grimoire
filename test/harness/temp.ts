import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a fresh directory under the OS temp dir and returns its real path
 * (Windows 8.3 short names expanded), so it compares equal to paths git prints.
 */
export async function makeTempDir(prefix = 'grimoire-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return realpath(dir);
}

/**
 * Removes a directory tree. Retries the transient Windows failures (EBUSY,
 * EPERM, ENOTEMPTY) that a just-exited git process or a virus scanner causes,
 * and removes git's read-only object files.
 */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
