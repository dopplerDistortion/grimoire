// Safe writes into a checkout (spec §13 Safe writes; §11 "symlinked paths are
// never written through"): every path component is lstat'ed and a symlink, a
// junction or any other reparse point that sends the path elsewhere is never
// written through; the write itself is a compare-and-swap through a temp file
// in the target's own folder, a re-check, and a rename retried on EPERM and
// EBUSY (Windows sharing violations).
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readTextIfExists, retryTransient } from './machine-local';

/** Why a safe write left a file alone. */
export type SafeWriteSkip =
  /** A component of the path is a symlink, junction or reparse point. */
  | { readonly reason: 'link'; readonly at: string }
  /** The file no longer holds what the caller saw. */
  | { readonly reason: 'changed' }
  /** Something other than a regular file is at the path. */
  | { readonly reason: 'not-a-file' };

/** Paths as the default file systems compare them: Windows and macOS fold case. */
function comparable(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * The first component of `relative` (POSIX separators) below `root` that is a
 * link, as a POSIX path relative to `root`; null when none is. A component is
 * a link when lstat says so (symlinks, and junctions on Windows), or when it
 * resolves anywhere other than where it sits (any other reparse point).
 * Components that don't exist yet end the walk.
 */
export async function linkedComponent(root: string, relative: string): Promise<string | null> {
  const base = await realpath(root).catch(() => path.resolve(root));
  let at = root;
  let real = base;
  const parts = relative.split('/').filter((part) => part !== '' && part !== '.');
  for (const [i, part] of parts.entries()) {
    at = path.join(at, part);
    real = path.join(real, part);
    const info = await lstat(at).catch(() => null);
    if (!info) return null;
    const name = parts.slice(0, i + 1).join('/');
    if (info.isSymbolicLink()) return name;
    const resolved = await realpath(at).catch(() => null);
    if (resolved === null || comparable(resolved) !== comparable(real)) return name;
  }
  return null;
}

function tempPathFor(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.grimoire-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
}

/**
 * Writes `after` to `root/relative` only if it still holds `before` (null: it
 * must not exist), never through a link. Folders on the way are created. The
 * new bytes go to a temp file beside the target first; the path and the old
 * bytes are re-checked; then the temp file is renamed over the target.
 * Returns null when written, else why it was left alone.
 */
export async function safeWrite(root: string, relative: string, before: string | null, after: string): Promise<SafeWriteSkip | null> {
  const linked = await linkedComponent(root, relative);
  if (linked !== null) return { reason: 'link', at: linked };
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });

  const temp = tempPathFor(file);
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(after, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // The re-check, as close to the rename as it can be.
    const relinked = await linkedComponent(root, relative);
    if (relinked !== null) return await dropped(temp, { reason: 'link', at: relinked });
    const info = await lstat(file).catch(() => null);
    if (info && !info.isFile()) return await dropped(temp, { reason: 'not-a-file' });
    const now = info ? ((await readTextIfExists(file)) ?? null) : null;
    if (now !== before) return await dropped(temp, { reason: 'changed' });
    await retryTransient(() => rename(temp, file));
    return null;
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function dropped(temp: string, skip: SafeWriteSkip): Promise<SafeWriteSkip> {
  await retryTransient(() => unlink(temp)).catch(() => {});
  return skip;
}
