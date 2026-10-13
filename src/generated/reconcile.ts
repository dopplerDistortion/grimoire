// Reconcile (spec §15 Reconcile, `grimoire-*` folders, Generated output exists
// only where a pin is; §13 Safe writes): one worktree's generated output made
// to match the served set, byte for byte, or removed.
//
// - A generated path git tracks (a force-added copy included) is a
//   tracked-path collision: reported and never touched, and the skill then
//   reaches agents through skill_list / skill_read only.
// - An untracked `grimoire-*` folder in a stub root that isn't on the
//   generated-path list and lacks grimoire's `.gitignore` is moved into the
//   machine-local store and reported. The shipped chore carriers are exempt
//   from everything here.
// - Only folders holding grimoire's exact `.gitignore` are ever removed, and
//   only when they hold nothing but grimoire's two files; a changed copy is
//   saved to the stray-edit store first.
// - Every path component is lstat'ed: nothing is written, moved or removed
//   through a symlink, junction or other reparse point.
//
// Three modes: `reconcile` (upkeep in a worktree on this pin), `fast-path`
// (the SessionStart fast path: what differs from the served set is written,
// a changed copy saved as a stray edit first, but nothing is moved aside or
// removed in a hook) and `remove` (upkeep in a worktree that pins no release:
// everything grimoire generated goes, under every guard).
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../git/run';
import { normalizeSkillText, skillVersionOf, STUB_PREFIX, type ServedSkill } from '../knowledge';
import { retryTransient, type MachineLocalStore } from '../machine-local';
import { keptNote, linkedComponent, readCheckoutText, safeWrite, type SafeWriteSkip } from '../safe-write';
import { readCopyState, writeCopyState } from './copy-state';
import { comparablePath, readPathList, updatePathList } from './path-list';
import type { ServedSet } from './served';
import { setAsideStrayEdit } from './stray';
import {
  CHORE_CARRIER,
  COPY_ROOT,
  copyFolder,
  GENERATED_GITIGNORE,
  SKILL_FILE,
  STUB_ROOTS,
  stubFolder,
  stubText,
  type StubClient,
} from './texts';

export type ReconcileMode = 'reconcile' | 'fast-path' | 'remove';

/** What reconciling one worktree did. Paths are POSIX, relative to the worktree. */
export interface ReconcileReport {
  /** Files written. */
  readonly wrote: string[];
  /** Generated folders removed. */
  readonly removed: string[];
  /** Generated paths git tracks: left untouched. */
  readonly collisions: string[];
  /** Untracked `grimoire-*` folders moved into the machine-local store, and where to. */
  readonly movedAside: { path: string; to: string }[];
  /** Skills whose output couldn't be placed here: they reach agents through skill_list / skill_read only. */
  readonly unplaced: { skill: string; path: string; why: string }[];
  /** Copies saved to the stray-edit store before grimoire replaced or removed them. */
  readonly strayEdits: { skill: string; path: string }[];
  /** Generated folders left alone, and why. */
  readonly left: { path: string; why: string }[];
}

/** Records kind: each folder reconcile moved aside, `{worktree, path, to, at}`. */
export const MOVED_ASIDE = 'moved-aside';

export type FolderKind = { readonly kind: 'copy' } | { readonly kind: 'stub'; readonly client: StubClient };

interface Wanted {
  readonly skill: ServedSkill;
  readonly folder: string;
  readonly files: { readonly gitignore: string; readonly skill: string };
}

/** What sits at a generated folder's path. */
type Found =
  | { readonly state: 'absent' }
  | { readonly state: 'link'; readonly at: string }
  | { readonly state: 'not-a-folder' }
  | { readonly state: 'folder'; readonly entries: readonly string[]; readonly gitignore: boolean };

const STUB_CLIENTS = Object.keys(STUB_ROOTS) as StubClient[];

function sameName(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The paths git tracks under the generated roots of `worktree` (POSIX, relative). */
async function trackedPaths(worktree: string): Promise<string[]> {
  const run = await runGit(worktree, ['ls-files', '-z', '--', COPY_ROOT, ...Object.values(STUB_ROOTS)]);
  if (run.code !== 0) throw new Error(`git ls-files failed in ${worktree}: ${run.stderr.trim()}`);
  return run.stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '');
}

async function inspect(worktree: string, folder: string): Promise<Found> {
  const linked = await linkedComponent(worktree, folder);
  if (linked !== null) return { state: 'link', at: linked };
  const full = path.join(worktree, ...folder.split('/'));
  const info = await lstat(full).catch(() => null);
  if (!info) return { state: 'absent' };
  if (!info.isDirectory()) return { state: 'not-a-folder' };
  const entries = await readdir(full);
  const ignore = await readCheckoutText(path.join(full, '.gitignore')).catch(() => null);
  const ignoreInfo = await lstat(path.join(full, '.gitignore')).catch(() => null);
  return { state: 'folder', entries, gitignore: ignoreInfo?.isFile() === true && ignore?.state === 'text' && ignore.text === GENERATED_GITIGNORE };
}

function linkWhy(at: string): string {
  return `${at} is a symlink or junction; grimoire never writes through one`;
}

function skipWhy(file: string, skip: SafeWriteSkip): string {
  switch (skip.reason) {
    case 'link':
      return linkWhy(skip.at);
    case 'changed':
      return `${file} changed while grimoire wrote it${keptNote(skip)}`;
    case 'not-a-file':
      return `${file} is not a file`;
  }
}

/** Whether every entry below `dir` is a plain folder or file: nothing that points elsewhere. */
async function plainTree(dir: string): Promise<boolean> {
  for (const name of await readdir(dir)) {
    const info = await lstat(path.join(dir, name));
    if (info.isSymbolicLink()) return false;
    if (info.isDirectory()) {
      if (!(await plainTree(path.join(dir, name)))) return false;
    } else if (!info.isFile()) return false;
  }
  return true;
}

/**
 * Reconciles `worktree`'s generated output with `served` (in `remove` mode,
 * with nothing: everything grimoire generated goes). Throws only when git
 * can't say which paths it tracks, before anything is touched.
 */
export async function reconcileWorktree(
  store: MachineLocalStore,
  worktree: string,
  served: ServedSet,
  mode: ReconcileMode = 'reconcile',
): Promise<ReconcileReport> {
  const report: ReconcileReport = { wrote: [], removed: [], collisions: [], movedAside: [], unplaced: [], strayEdits: [], left: [] };
  const tracked = await trackedPaths(worktree);
  const listed = new Set((await readPathList(store)).map(comparablePath));
  const before = await readCopyState(store, worktree);
  const copyState = { ...before };
  const added: string[] = [];
  const dropped: string[] = [];
  const abs = (folder: string) => path.join(worktree, ...folder.split('/'));
  const trackedIn = (folder: string) => {
    const prefix = comparablePath(abs(folder)) + path.sep;
    return tracked.filter((file) => comparablePath(abs(file)).startsWith(prefix));
  };
  const isListed = (folder: string) => listed.has(comparablePath(abs(folder)));
  const servedVersion = (skill: string) => served.skills.find((s) => s.name === skill)?.version ?? null;

  /** Saves a copy that holds no text grimoire ever served for `skill`; false when it couldn't be saved. */
  const keepStray = async (skill: string, file: string, text: string): Promise<boolean> => {
    if (served.known.get(skill)?.has(skillVersionOf(normalizeSkillText(text)))) return true;
    try {
      await setAsideStrayEdit(store, { skill, worktree, path: file, text, base: copyState[skill] ?? null, served: servedVersion(skill) });
      report.strayEdits.push({ skill, path: file });
      return true;
    } catch (error) {
      report.left.push({ path: file, why: `grimoire couldn't save the edit to it (${error instanceof Error ? error.message : String(error)})` });
      return false;
    }
  };

  /** Moves an untracked folder that isn't grimoire's into the machine-local store; false when it stays. */
  const moveAside = async (folder: string): Promise<boolean> => {
    const from = abs(folder);
    if (!(await plainTree(from).catch(() => false))) {
      report.left.push({ path: folder, why: 'it holds a symlink, junction or something other than files and folders' });
      return false;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const to = path.join(store.dir, 'moved-aside', `${stamp}-${randomBytes(4).toString('hex')}`, ...folder.split('/'));
    try {
      await mkdir(path.dirname(to), { recursive: true });
      try {
        await retryTransient(() => rename(from, to));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        // Another volume than the common dir's: copy, then remove.
        await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        await rm(from, { recursive: true });
      }
    } catch (error) {
      report.left.push({ path: folder, why: `grimoire couldn't move it aside (${error instanceof Error ? error.message : String(error)})` });
      return false;
    }
    report.movedAside.push({ path: folder, to });
    await store.records.append(MOVED_ASIDE, { worktree, path: folder, to, at: new Date().toISOString() }).catch(() => {});
    return true;
  };

  /** Removes a generated folder holding grimoire's exact `.gitignore` and nothing but grimoire's files. */
  const remove = async (folder: string, skill: string, kind: FolderKind, found: Found & { state: 'folder' }): Promise<void> => {
    const extra = found.entries.filter((name) => name !== SKILL_FILE && name !== '.gitignore');
    if (extra.length > 0) {
      report.left.push({ path: folder, why: `it holds files grimoire didn't write (${extra.join(', ')})` });
      return;
    }
    const full = abs(folder);
    for (const name of found.entries) {
      if (!(await lstat(path.join(full, name))).isFile()) {
        report.left.push({ path: folder, why: `${name} in it is not a file` });
        return;
      }
    }
    if (kind.kind === 'copy' && found.entries.includes(SKILL_FILE)) {
      const text = await readCheckoutText(path.join(full, SKILL_FILE));
      if (text.state === 'not-text') {
        report.left.push({ path: folder, why: `its ${SKILL_FILE} is not UTF-8 text, so grimoire can't save it as a stray edit` });
        return;
      }
      if (text.state === 'text' && !(await keepStray(skill, `${folder}/${SKILL_FILE}`, text.text))) return;
    }
    // Checked again right before: a link may have appeared since.
    const relinked = await linkedComponent(worktree, folder);
    if (relinked !== null) {
      report.left.push({ path: folder, why: linkWhy(relinked) });
      return;
    }
    try {
      if (found.entries.includes(SKILL_FILE)) await retryTransient(() => unlink(path.join(full, SKILL_FILE)));
      await retryTransient(() => unlink(path.join(full, '.gitignore')));
      await retryTransient(() => rmdir(full));
    } catch (error) {
      report.left.push({ path: folder, why: `grimoire couldn't remove it (${error instanceof Error ? error.message : String(error)})` });
      return;
    }
    report.removed.push(folder);
    dropped.push(full);
    if (kind.kind === 'copy') delete copyState[skill];
  };

  /** Writes `file` in `folder` to `text` unless it holds it; false when it was left alone. */
  const put = async (folder: string, name: string, text: string): Promise<boolean> => {
    const file = `${folder}/${name}`;
    const current = await readCheckoutText(abs(file));
    if (current.state === 'text' && current.text === text) return true;
    if (current.state === 'not-text') {
      report.left.push({ path: file, why: `${file} is not UTF-8 text` });
      return false;
    }
    try {
      const skip = await safeWrite(worktree, file, current.state === 'text' ? current.text : null, text);
      if (skip) {
        report.left.push({ path: file, why: skipWhy(file, skip) });
        return false;
      }
    } catch (error) {
      report.left.push({ path: file, why: `grimoire couldn't write it (${error instanceof Error ? error.message : String(error)})` });
      return false;
    }
    report.wrote.push(file);
    return true;
  };

  /** Puts one wanted folder in place; true when it holds exactly the served files afterwards. */
  const place = async (wanted: Wanted, kind: FolderKind): Promise<boolean> => {
    const { folder, skill, files } = wanted;
    const unplaced = (why: string) => report.unplaced.push({ skill: skill.name, path: folder, why });
    const found = await inspect(worktree, folder);
    if (found.state === 'link') {
      unplaced(linkWhy(found.at));
      return false;
    }
    const tracks = trackedIn(folder);
    if (tracks.length > 0) {
      report.collisions.push(...tracks);
      const why = `git tracks ${tracks.join(', ')} (a tracked-path collision; grimoire never touches it, and \`git rm --cached\` ends it)`;
      const current = await readCheckoutText(abs(`${folder}/${SKILL_FILE}`));
      // A tracked file that happens to hold the served text still serves.
      const inPlace = current.state === 'text' && current.text === files.skill;
      if (inPlace) report.left.push({ path: folder, why });
      else unplaced(why);
      return inPlace;
    }
    if (found.state === 'not-a-folder') {
      unplaced('something other than a folder is there');
      return false;
    }
    if (found.state === 'folder') {
      const current = await readCheckoutText(abs(`${folder}/${SKILL_FILE}`));
      if (!found.gitignore && !isListed(folder)) {
        // Moving a folder aside is upkeep's, never a hook's.
        if (mode === 'fast-path') {
          unplaced('a folder grimoire didn’t make is there; upkeep moves it aside');
          return false;
        }
        if (!(await moveAside(folder))) {
          unplaced('a folder grimoire didn’t make is there');
          return false;
        }
      } else if (kind.kind === 'copy' && current.state === 'text' && current.text !== files.skill) {
        if (!(await keepStray(skill.name, `${folder}/${SKILL_FILE}`, current.text))) {
          unplaced('its copy holds an edit grimoire couldn’t save');
          return false;
        }
      }
    }
    // The .gitignore first: the folder is ignored before its SKILL.md appears.
    if (!(await put(folder, '.gitignore', files.gitignore)) || !(await put(folder, SKILL_FILE, files.skill))) {
      unplaced('grimoire couldn’t write it');
      return false;
    }
    if (!isListed(folder)) added.push(abs(folder));
    return true;
  };

  const wanted = new Set<string>();
  if (mode !== 'remove') {
    for (const skill of served.skills) {
      const copy: Wanted = { skill, folder: copyFolder(skill.name), files: { gitignore: GENERATED_GITIGNORE, skill: skill.text } };
      const stubs = STUB_CLIENTS.map((client) => ({
        client,
        wanted: { skill, folder: stubFolder(client, skill.name), files: { gitignore: GENERATED_GITIGNORE, skill: stubText(client, skill) } } satisfies Wanted,
      }));
      for (const folder of [copy.folder, ...stubs.map((stub) => stub.wanted.folder)]) wanted.add(comparablePath(abs(folder)));
      // A stub points at the copy: without the served text in the copy, no stub.
      const copied = await place(copy, { kind: 'copy' });
      if (copied) copyState[skill.name] = skill.version;
      for (const stub of stubs) {
        if (copied) await place(stub.wanted, { kind: 'stub', client: stub.client });
        else if (mode !== 'fast-path') await removeUnwanted(stub.wanted.folder, skill.name, { kind: 'stub', client: stub.client });
      }
    }
  }

  /** A generated folder nothing serves here: removed when it is grimoire's; a foreign `grimoire-*` folder is moved aside. */
  async function removeUnwanted(folder: string, skill: string, kind: FolderKind): Promise<void> {
    const found = await inspect(worktree, folder);
    if (found.state === 'absent' || trackedIn(folder).length > 0) return;
    if (found.state === 'link') {
      report.left.push({ path: folder, why: linkWhy(found.at) });
      return;
    }
    if (found.state === 'not-a-folder') return;
    if (found.gitignore) return remove(folder, skill, kind, found);
    if (isListed(folder)) {
      report.left.push({ path: folder, why: 'its .gitignore isn’t grimoire’s any more' });
      return;
    }
    if (mode === 'reconcile' && kind.kind === 'stub') await moveAside(folder);
  }

  if (mode !== 'fast-path') {
    for (const { folder, skill, kind } of await existingFolders(worktree)) {
      if (wanted.has(comparablePath(abs(folder)))) continue;
      await removeUnwanted(folder, skill, kind);
    }
    // An emptied copy root goes too; the stub roots stay (Codex watches only roots it saw at session start).
    if ((await linkedComponent(worktree, COPY_ROOT)) === null) await rmdir(abs(COPY_ROOT)).catch(() => {});
    if (mode === 'remove' && (await linkedComponent(worktree, '.grimoire')) === null) await rmdir(abs('.grimoire')).catch(() => {});
  }

  if (added.length > 0 || dropped.length > 0) await updatePathList(store, { added, removed: dropped });
  if (JSON.stringify(copyState) !== JSON.stringify(before)) await writeCopyState(store, worktree, copyState);
  return report;
}

/** Whether `worktree` holds anything that may be generated output (read-only, no git). */
export async function mayHoldGeneratedOutput(worktree: string): Promise<boolean> {
  return (await existingFolders(worktree)).length > 0;
}

/** The generated folders that may exist in `worktree`: every copy folder, and every `grimoire-*` stub folder but the chore carriers. */
export async function existingFolders(worktree: string): Promise<{ folder: string; skill: string; kind: FolderKind }[]> {
  const folders: { folder: string; skill: string; kind: FolderKind }[] = [];
  const names = async (root: string): Promise<string[]> => {
    if ((await linkedComponent(worktree, root)) !== null) return [];
    return (await readdir(path.join(worktree, ...root.split('/'))).catch(() => [] as string[])).sort();
  };
  for (const name of await names(COPY_ROOT)) folders.push({ folder: `${COPY_ROOT}/${name}`, skill: name, kind: { kind: 'copy' } });
  for (const client of STUB_CLIENTS) {
    for (const name of await names(STUB_ROOTS[client])) {
      if (!name.startsWith(STUB_PREFIX) || sameName(name, CHORE_CARRIER)) continue;
      folders.push({ folder: `${STUB_ROOTS[client]}/${name}`, skill: name.slice(STUB_PREFIX.length), kind: { kind: 'stub', client } });
    }
  }
  return folders;
}
