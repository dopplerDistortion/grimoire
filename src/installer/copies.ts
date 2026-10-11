// Version copies (spec §6, §11): `<git-common-dir>/grimoire/pkg/<version>/`,
// one unpacked release each, shared by every worktree of the clone.
//
// The launcher↔package contract (frozen, §21):
//   pkg/<version>/                  the package's files (package.json, dist/, ...)
//   pkg/<version>/dist/launch.mjs   the entry: `launch(args, info)`
//   pkg/<version>/.complete         JSON {"integrity": <npm's tarball integrity, or null>}
//
// A copy is unpacked into a temp folder inside `pkg/` (so on the same volume)
// and renamed into place with its `.complete` already written, all under the
// exclusive install lock: the launcher sees a whole copy or none. Pruning moves
// copies into `pkg/.trash/` first, then empties it.
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { readTextIfExists, retryTransient, type MachineLocalStore } from '../machine-local';
import { withInstallLock } from './lock';
import { UPGRADE_RECORDS, type UpgradeRecord } from './records';
import { compareSemver, isStrictSemver } from './semver';
import { unpackPackage } from './tar';
import { worktreePins } from './worktrees';

/** The package every copy must be. */
export const PACKAGE_NAME = '@goksening/grimoire';
/** The marker file that makes a copy loadable. */
export const COMPLETE_MARKER = '.complete';
/** The entry the launcher imports. */
export const COPY_ENTRY = path.join('dist', 'launch.mjs');

const TEMP_PREFIX = '.tmp-';
const TRASH = '.trash';

export type CopySource =
  /** A tarball as `npm pack` writes it. With `integrity` (npm's SRI string) it must match. */
  | { readonly tarball: string; readonly integrity?: string }
  /** An unpacked package folder (the running package, or a devDependency), with the integrity npm recorded for it. */
  | { readonly dir: string; readonly integrity: string | null };

export interface InstalledCopy {
  readonly version: string;
  readonly dir: string;
  /** What `.complete` records. */
  readonly integrity: string | null;
}

export interface CopyInstall extends InstalledCopy {
  /** `present`: a complete copy was already there and was left alone. */
  readonly status: 'installed' | 'present';
}

function pkgDir(store: MachineLocalStore): string {
  return path.join(store.dir, 'pkg');
}

/** `pkg/<version>/`. */
export function copyDir(store: MachineLocalStore, version: string): string {
  return path.join(pkgDir(store), version);
}

async function readComplete(dir: string): Promise<{ integrity: string | null } | null> {
  const text = await readTextIfExists(path.join(dir, COMPLETE_MARKER));
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as { integrity?: unknown };
    return { integrity: typeof parsed.integrity === 'string' ? parsed.integrity : null };
  } catch {
    return { integrity: null };
  }
}

/** npm's SRI form of a tarball's hash. */
export function tarballIntegrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** True when any hash in the SRI string `expected` matches `bytes`. */
function integrityMatches(bytes: Buffer, expected: string): boolean {
  return expected
    .trim()
    .split(/\s+/)
    .some((token) => {
      const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)/.exec(token);
      return match !== null && createHash(match[1]!).update(bytes).digest('base64') === match[2];
    });
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === COMPLETE_MARKER) continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) await copyTree(source, path.join(to, entry.name));
    else if (entry.isFile()) await copyFile(source, path.join(to, entry.name));
    else throw new GrimoireError('INVALID', `the package folder holds ${source}, which is not a regular file`, {});
  }
}

/** Fills `temp` from the source; returns the integrity to record. */
async function populate(temp: string, source: CopySource): Promise<string | null> {
  if ('tarball' in source) {
    const bytes = await readFile(source.tarball);
    if (source.integrity !== undefined && !integrityMatches(bytes, source.integrity)) {
      throw new GrimoireError('INVALID', `the package tarball ${source.tarball} doesn't match its integrity ${source.integrity}`, {
        expected: source.integrity,
        actual: tarballIntegrity(bytes),
      });
    }
    await unpackPackage(bytes, temp);
    return source.integrity ?? tarballIntegrity(bytes);
  }
  await copyTree(source.dir, temp);
  return source.integrity;
}

/** Refuses a folder that isn't `@goksening/grimoire@<version>` with its entry. */
async function checkPackage(dir: string, version: string): Promise<void> {
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new GrimoireError('INVALID', 'the package has no readable package.json', {});
  }
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new GrimoireError('INVALID', `the package is ${String(manifest.name)}@${String(manifest.version)}, not ${PACKAGE_NAME}@${version}`, {});
  }
  if (!(await stat(path.join(dir, COPY_ENTRY)).catch(() => null))?.isFile()) {
    throw new GrimoireError('INVALID', `the package has no ${COPY_ENTRY.replace(/\\/g, '/')}`, {});
  }
}

/** Moves `dir` into `pkg/.trash/` (a rename, so it leaves `pkg/` at once). */
async function toTrash(store: MachineLocalStore, dir: string): Promise<void> {
  const trash = path.join(pkgDir(store), TRASH);
  await mkdir(trash, { recursive: true });
  await retryTransient(() => rename(dir, path.join(trash, `${path.basename(dir)}-${randomBytes(4).toString('hex')}`)));
}

/** Deletes what `pkg/.trash/` holds; a folder still in use (Windows) stays for the next prune. */
async function emptyTrash(store: MachineLocalStore): Promise<void> {
  const trash = path.join(pkgDir(store), TRASH);
  for (const name of await readdir(trash).catch(() => [] as string[])) {
    await rm(path.join(trash, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * Installs `pkg/<version>/` from `source` under the install lock: unpacked into
 * a temp folder in `pkg/`, checked, given its `.complete`, then renamed into
 * place. A complete copy already there is left alone.
 */
export async function installCopy(store: MachineLocalStore, version: string, source: CopySource): Promise<CopyInstall> {
  if (!isStrictSemver(version)) throw new GrimoireError('INVALID', `${JSON.stringify(version)} is not a strict semver version`, {});
  return withInstallLock(store, async () => {
    const dir = copyDir(store, version);
    const existing = await readComplete(dir);
    if (existing) return { status: 'present', version, dir, integrity: existing.integrity };
    // A folder without `.complete` was never loadable: it goes.
    if (await stat(dir).catch(() => null)) await toTrash(store, dir);

    const temp = path.join(pkgDir(store), `${TEMP_PREFIX}${version}-${randomBytes(4).toString('hex')}`);
    await mkdir(temp, { recursive: true });
    try {
      const integrity = await populate(temp, source);
      await checkPackage(temp, version);
      await writeFile(path.join(temp, COMPLETE_MARKER), `${JSON.stringify({ integrity })}\n`);
      await retryTransient(() => rename(temp, dir));
      return { status: 'installed', version, dir, integrity };
    } catch (error) {
      await rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      throw error;
    }
  });
}

/** The complete copies, oldest version first. */
export async function listCopies(store: MachineLocalStore): Promise<InstalledCopy[]> {
  const copies: InstalledCopy[] = [];
  for (const name of await readdir(pkgDir(store)).catch(() => [] as string[])) {
    if (!isStrictSemver(name)) continue;
    const complete = await readComplete(copyDir(store, name));
    if (complete) copies.push({ version: name, dir: copyDir(store, name), integrity: complete.integrity });
  }
  return copies.sort((a, b) => compareSemver(a.version, b.version));
}

/** Why prune kept a copy. */
export type KeepReason = 'pinned' | 'running' | 'upgrading' | 'previous' | 'requested' | 'unknown-pin';

export interface PruneOptions {
  /** Versions the caller still needs (init keeps the copy it just installed, before config.yml pins it). */
  readonly keep?: readonly string[];
}

export interface PruneResult {
  readonly removed: string[];
  readonly kept: { readonly version: string; readonly why: KeepReason[] }[];
}

/**
 * Removes the copies nothing needs, through `pkg/.trash/`, under the install
 * lock. It never removes a copy that a registered worktree pins, that a live
 * process runs, that an upgrade in progress involves, or the newest previous
 * version (the newest copy older than the newest pinned one; with nothing
 * pinned, the newest copy). While a registered worktree's pin can't be known
 * (a locked worktree that is away, a main checkout git doesn't record, an
 * unreadable config.yml) it keeps every copy. Folders that never completed and
 * leftover temp folders go too; names it doesn't know are left alone.
 */
export async function pruneCopies(store: MachineLocalStore, options: PruneOptions = {}): Promise<PruneResult> {
  return withInstallLock(store, async () => {
    const copies = await listCopies(store);
    const installed = new Set(copies.map((copy) => copy.version));
    const reasons = new Map<string, Set<KeepReason>>();
    const keep = (version: string | null | undefined, why: KeepReason) => {
      if (typeof version !== 'string' || !installed.has(version)) return;
      reasons.set(version, (reasons.get(version) ?? new Set()).add(why));
    };

    const { pins, unknown } = await worktreePins(store.commonDir);
    const pinned = pins.map((entry) => entry.pin).filter((pin): pin is string => pin !== null);
    for (const pin of pinned) keep(pin, 'pinned');
    for (const record of await store.processes.live()) keep(record.pin, 'running');
    for (const { value } of await store.coordination.list<Partial<UpgradeRecord>>(UPGRADE_RECORDS)) {
      keep(value?.from, 'upgrading');
      keep(value?.to, 'upgrading');
    }
    for (const version of options.keep ?? []) keep(version, 'requested');
    const newestPinned = pinned.filter(isStrictSemver).sort(compareSemver).at(-1);
    const previous = copies.filter((copy) => newestPinned === undefined || compareSemver(copy.version, newestPinned) < 0).at(-1);
    keep(previous?.version, 'previous');
    // Any copy could be the one an unknown pin names.
    if (unknown.length > 0) for (const copy of copies) keep(copy.version, 'unknown-pin');

    const removed: string[] = [];
    for (const copy of copies) {
      if (reasons.has(copy.version)) continue;
      await toTrash(store, copy.dir);
      removed.push(copy.version);
    }
    // Leftovers of interrupted installs: no install runs while we hold the lock.
    for (const name of await readdir(pkgDir(store)).catch(() => [] as string[])) {
      const leftover = name.startsWith(TEMP_PREFIX) || (isStrictSemver(name) && !installed.has(name));
      if (leftover) await toTrash(store, copyDir(store, name));
    }
    await emptyTrash(store);
    return {
      removed,
      kept: copies.filter((copy) => reasons.has(copy.version)).map((copy) => ({ version: copy.version, why: [...reasons.get(copy.version)!] })),
    };
  });
}
