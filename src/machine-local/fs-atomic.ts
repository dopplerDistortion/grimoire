import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Every write in the machine-local store is a temp file in the target's own
// directory plus a rename, so a reader sees the old bytes or the new bytes and
// never a partial file. On Windows a rename onto, or a read of, a file another
// process has open fails for a moment with EPERM or EBUSY; those are retried.

const TRANSIENT_WINDOWS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_BUDGET_MS = 3_000;

/** Temp files start with a dot, so no listing of the store ever picks one up. */
export function isTempName(name: string): boolean {
  return name.startsWith('.');
}

function tempPathFor(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export interface RetryOptions {
  /** How long to keep retrying, in milliseconds (default 3 s): the calling operation's own budget. */
  readonly budgetMs?: number;
  /** The platform whose sharing failures count as transient (default this one's): a test seam. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Runs `fn` (a rename, unlink, rmdir or read), retrying the transient Windows
 * sharing failures with a short backoff, until the budget runs out.
 */
export async function retryTransient<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.budgetMs ?? RETRY_BUDGET_MS);
  const windows = (options.platform ?? process.platform) === 'win32';
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return await fn();
    } catch (error) {
      const transient = windows && TRANSIENT_WINDOWS_CODES.has(errorCode(error) ?? '');
      if (!transient || Date.now() >= deadline) throw error;
      await sleep(delay + Math.random() * delay);
    }
  }
}

async function writeTemp(file: string, data: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/** Replaces `file` with `data`: temp file plus rename. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const temp = await writeTemp(file, data);
  try {
    await retryTransient(() => rename(temp, file));
  } catch (error) {
    await retryTransient(() => unlink(temp)).catch(() => {});
    throw error;
  }
}

/**
 * The hard-link failures that mean the file system has no hard links (FAT and
 * exFAT, some network shares): EPERM and ENOTSUP on POSIX, EISDIR (libuv's
 * spelling of ERROR_INVALID_FUNCTION) or ENOTSUP on Windows.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EISDIR']);

/**
 * Creates `file` holding `data` only if nothing is there yet; returns false if
 * it already exists. The file appears with its full content (temp file plus a
 * hard link, which fails if the name is taken); a link a reader or an
 * antivirus holds up on Windows is retried. Only on a file system without hard
 * links does it fall back to an exclusive create, where a reader may briefly
 * see a partial file. Any other failure is an error.
 */
export async function createFileExclusive(file: string, data: string): Promise<boolean> {
  const temp = await writeTemp(file, data);
  try {
    await retryTransient(() => link(temp, file));
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    if (!NO_HARD_LINKS.has(errorCode(error) ?? '')) throw error;
    return createWithOpenExclusive(file, data);
  } finally {
    await retryTransient(() => unlink(temp)).catch(() => {});
  }
}

async function createWithOpenExclusive(file: string, data: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** Reads a UTF-8 file; undefined if it doesn't exist. */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await retryTransient(() => readFile(file, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Removes a file; false if it wasn't there. */
export async function removeFile(file: string): Promise<boolean> {
  try {
    await retryTransient(() => unlink(file));
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
    throw error;
  }
}
