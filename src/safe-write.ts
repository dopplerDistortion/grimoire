// Safe writes into a checkout (spec §13 Safe writes; §11 "symlinked paths are
// never written through"): every path component is lstat'ed and a symlink, a
// junction or any other reparse point that sends the path elsewhere is never
// written through; the write itself is a compare-and-swap through a temp file
// in the target's own folder, a re-check, and a move that can't land over a
// save made after the re-check: a new file is a hard link that fails when the
// name is taken, and a file it replaces is renamed aside and its bytes
// compared before the new one is linked in (and put back when they differ).
// A write killed while the file is aside leaves it there: the next safe write
// on that path puts it back first, when its writer is dead and its place empty.
// Renames and links are retried on EPERM and EBUSY (Windows sharing
// violations).
//
// Only text that round-trips is ever rewritten: a file whose bytes aren't
// UTF-8 (UTF-16 with or without a BOM, an ANSI code page) would come back
// with the person's own text replaced, so it is left alone, and the
// compare-and-swap compares bytes, never decoded text.
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { retryTransient } from './machine-local';
import { isPidAlive } from './machine-local/process-info';

/** A checkout file as text: absent, UTF-8 text that encodes back to the very same bytes, or not text. */
export type CheckoutText = { readonly state: 'absent' } | { readonly state: 'text'; readonly text: string } | { readonly state: 'not-text' };

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of `bytes` when they are UTF-8 text (a UTF-8 BOM kept) with no NUL; null when not. */
export function textOfBytes(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return null;
  }
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

async function readBytesIfExists(file: string): Promise<Buffer | undefined> {
  try {
    return await retryTransient(() => readFile(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Reads a file of the checkout as text a safe write may replace (see CheckoutText). */
export async function readCheckoutText(file: string): Promise<CheckoutText> {
  const bytes = await readBytesIfExists(file);
  if (bytes === undefined) return { state: 'absent' };
  const text = textOfBytes(bytes);
  return text === null ? { state: 'not-text' } : { state: 'text', text };
}

/** Why a safe write left a file alone. */
export type SafeWriteSkip =
  /** A component of the path is a symlink, junction or reparse point. */
  | { readonly reason: 'link'; readonly at: string }
  /**
   * The file no longer holds what the caller saw. `kept`: a save landed at
   * its place while it was aside for the compare, so what it held is kept
   * there (a POSIX path relative to the root).
   */
  | { readonly reason: 'changed'; readonly kept?: string }
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

/** What a safe write's `changed` adds to a message: where the file's bytes are kept, when they had to be. */
export function keptNote(skip: SafeWriteSkip): string {
  return skip.reason === 'changed' && skip.kept ? `; what it held is kept in ${skip.kept}` : '';
}

function tempPathFor(file: string, suffix = 'tmp'): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.grimoire-${process.pid}-${randomBytes(4).toString('hex')}.${suffix}`);
}

/**
 * The hard-link failures that mean the file system has no hard links (FAT and
 * exFAT, some network shares), as fs-atomic's exclusive create reads them.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EISDIR']);

/** Links `to` to `from`'s file unless `to` exists: `taken` when it does, `unsupported` without hard links. */
async function linkUnlessTaken(from: string, to: string): Promise<'linked' | 'taken' | 'unsupported'> {
  try {
    await retryTransient(() => link(from, to));
    return 'linked';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return 'taken';
    if (NO_HARD_LINKS.has(code)) return 'unsupported';
    throw error;
  }
}

/**
 * Moves `from` to `to` unless `to` exists. Without hard links it is a
 * check and a rename: a save landing between the two is the one window left.
 */
async function moveUnlessTaken(from: string, to: string): Promise<boolean> {
  const linked = await linkUnlessTaken(from, to);
  if (linked === 'taken') return false;
  if (linked === 'linked') {
    await retryTransient(() => unlink(from)).catch(() => {});
    return true;
  }
  if ((await lstat(to).catch(() => null)) !== null) return false;
  await retryTransient(() => rename(from, to));
  return true;
}

/**
 * Writes `after` to `root/relative` only if it still holds exactly the UTF-8
 * bytes of `before` (null: it must not exist), never through a link. Folders
 * on the way are created. The new bytes go to a temp file beside the target
 * first; the path and the old bytes are re-checked; then the temp file takes
 * the target's place without ever landing over a save made since (see
 * replaceIfUnchanged). Returns null when written, else why it was left alone.
 * A failure leaves no temp file behind.
 */
export async function safeWrite(root: string, relative: string, before: string | null, after: string): Promise<SafeWriteSkip | null> {
  const linked = await linkedComponent(root, relative);
  if (linked !== null) return { reason: 'link', at: linked };
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await restoreLeftAside(file);

  const temp = tempPathFor(file);
  const handle = await open(temp, 'wx');
  try {
    try {
      await handle.writeFile(after, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The re-check, as close to the rename as it can be.
    const relinked = await linkedComponent(root, relative);
    if (relinked !== null) return await dropped(temp, { reason: 'link', at: relinked });
    const info = await lstat(file).catch(() => null);
    if (info && !info.isFile()) return await dropped(temp, { reason: 'not-a-file' });
    const now = info ? await readBytesIfExists(file) : undefined;
    const expected = before === null ? null : Buffer.from(before, 'utf8');
    const same = expected === null ? now === undefined : now !== undefined && now.equals(expected);
    if (!same) return await dropped(temp, { reason: 'changed' });
    if (expected === null) return (await moveUnlessTaken(temp, file)) ? null : await dropped(temp, { reason: 'changed' });
    return await replaceIfUnchanged(root, file, temp, expected);
  } catch (error) {
    await retryTransient(() => unlink(temp)).catch(() => {});
    throw error;
  }
}

/**
 * Puts `temp` in `file`'s place if `file` still holds `expected`: `file` is
 * renamed aside and the bytes that moved are compared, so a save landing after
 * the caller's re-check is never replaced. A changed file goes back (or, when
 * its place was taken meanwhile, stays aside and is named); a file saved at
 * the empty place while it was aside stands.
 */
async function replaceIfUnchanged(root: string, file: string, temp: string, expected: Buffer): Promise<SafeWriteSkip | null> {
  const aside = tempPathFor(file, 'replacing');
  try {
    await retryTransient(() => rename(file, aside));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return dropped(temp, { reason: 'changed' });
    throw error;
  }
  let placed: boolean;
  try {
    const moved = await readBytesIfExists(aside);
    if (moved === undefined || !moved.equals(expected)) {
      if (await moveUnlessTaken(aside, file)) return await dropped(temp, { reason: 'changed' });
      // Kept under a name no later write puts back (see restoreLeftAside): a save stands at its place.
      const kept = tempPathFor(file, 'kept');
      const at = await retryTransient(() => rename(aside, kept)).then(
        () => kept,
        () => aside,
      );
      return await dropped(temp, { reason: 'changed', kept: path.relative(root, at).split(path.sep).join('/') });
    }
    placed = await moveUnlessTaken(temp, file);
  } catch (error) {
    // The file's bytes never stay aside for a failure: back to their place, unless a save took it.
    await moveUnlessTaken(aside, file).catch(() => {});
    throw error;
  }
  // The bytes aside are the ones the caller saw; a save made at the empty place stands over them.
  await retryTransient(() => unlink(aside)).catch(() => {});
  return placed ? null : dropped(temp, { reason: 'changed' });
}

/** A file replaceIfUnchanged put aside: `.<name>.grimoire-<pid>-<hex>.replacing`. */
const LEFT_ASIDE = /^\.(.+)\.grimoire-(\d+)-[0-9a-f]+\.replacing$/;

/**
 * Puts back a file a safe write on `file` left aside when it was killed
 * between moving it aside and linking the new one in: only when that
 * writer's process is gone and the place is still empty (a save made since
 * stands). Best effort: it never fails the write.
 */
async function restoreLeftAside(file: string): Promise<void> {
  const dir = path.dirname(file);
  const name = comparable(path.basename(file));
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    const match = LEFT_ASIDE.exec(entry);
    if (!match || comparable(match[1]!) !== name) continue;
    const pid = Number(match[2]);
    if (pid === process.pid || isPidAlive(pid)) continue;
    if ((await lstat(file).catch(() => null)) !== null) return;
    if (await moveUnlessTaken(path.join(dir, entry), file).catch(() => false)) return;
  }
}

async function dropped(temp: string, skip: SafeWriteSkip): Promise<SafeWriteSkip> {
  await retryTransient(() => unlink(temp)).catch(() => {});
  return skip;
}
