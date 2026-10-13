// The checkout half of `uninstall` (spec §21 Uninstall; §11 The manifest):
// what grimoire wrote in one checkout, removed by reading only the manifest
// and the other lists the cross-pin contract freezes (rule 7), so any later
// release removes any install.
//
// - Grimoire-owned whole files go, with drift reported. One whose edits git
//   doesn't have (untracked, or changed since the last commit) is kept and
//   reported instead: removing it would lose them for good.
// - Entries in shared files (the `.mcp.json` server, the `.claude/settings.json`
//   items, the `.codex/config.toml` block, the `AGENTS.md` and adapter blocks)
//   are removed even if edited: found by the frozen bootstrap and verb text
//   first, then by key or marker. Containers the removal empties go too, and a
//   file grimoire created that ends up empty is deleted.
// - The npm script goes only if its value is unchanged; a seeded file only if
//   it is unchanged.
// - Then config.yml, this worktree's generated copies and stubs, the manifest
//   last, and `.grimoire/` if it ends up empty; files grimoire never wrote are
//   kept and reported.
//
// Entries first and the manifest last: a run that stops (a crash, a kill)
// leaves the manifest, so running uninstall again finishes the job. A file
// that can't be changed safely (invalid JSON, broken markers, a symlink, not
// text, changed while uninstall ran) stops the removal before config.yml,
// with the manifest kept. An unknown manifest kind stops it before any write.
import { randomBytes } from 'node:crypto';
import { link as hardLink, lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../git/run';
import { retryTransient } from '../machine-local';
import { keptNote, linkedComponent, readCheckoutText, safeWrite } from '../safe-write';
import { BOOTSTRAP } from './bootstrap';
import { CONFIG_PATH } from './config';
import { removeGenerated } from './leave';
import { ENTRY_KINDS, MANIFEST_FORMAT, MANIFEST_PATH, normalizedText, readManifest, textHash, valueHash, type EntryKind, type ManifestEntry } from './manifest';
import { CODEX_MARKER, isGrimoireHookGroup } from './pointers';
import { markdownMarkers } from './texts';
import { parseToml, sessionStartGroups } from './toml';
import { findBlock, inFileStyle, isPlainObject, jsonIndent, tomlMarkers } from './writer';

/** The dotfolder, relative to the checkout root. */
const DOTFOLDER = '.grimoire';

/** An entry the removal took out (or found already gone). */
export interface RemovedEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly key?: readonly string[];
  readonly item?: string;
  readonly hook?: string;
  readonly marker?: string;
  /** Edited since grimoire wrote it: removed all the same. */
  readonly drift: boolean;
}

/** Something the removal leaves in place, and why. */
export interface KeptItem {
  readonly path: string;
  readonly kind?: EntryKind;
  readonly why: string;
}

/** A line that mentions grimoire in a file grimoire writes into, which no manifest entry covers: reported, never touched. */
export interface Mention {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

/** A Codex SessionStart hook group whose index moves when grimoire's group goes (spike E, P4: Codex keys trust by it). */
export interface ShiftedGroup {
  readonly from: number;
  readonly to: number;
  /** Its first handler's command, when it has one. */
  readonly command: string | null;
}

/** One file's change: its text when planned (null: absent), and after (null: deleted). */
interface FileChange {
  readonly path: string;
  readonly before: string;
  readonly after: string | null;
  /** Grimoire created the file: its now-empty folders go with it. */
  readonly created: boolean;
}

export interface RemovalPlan {
  readonly root: string;
  /** Whether the checkout has a manifest at all. */
  readonly manifest: boolean;
  /** Kinds (or a manifest format) this release doesn't know: nothing may be removed. */
  readonly unknown: readonly string[];
  /** Entries to take out, by file, in manifest order. */
  readonly removed: readonly RemovedEntry[];
  /** Entries already gone. */
  readonly gone: readonly RemovedEntry[];
  /** Files deleted, and files edited. */
  readonly changes: readonly FileChange[];
  readonly kept: readonly KeptItem[];
  /** What stops the removal before config.yml: fix it, then run uninstall again. */
  readonly problems: readonly string[];
  readonly mentions: readonly Mention[];
  readonly codex: readonly ShiftedGroup[];
}

/** What the removal did. */
export interface CheckoutRemoval {
  /** True when everything grimoire wrote here is gone, or kept by rule (nothing is left to retry). */
  complete: boolean;
  readonly removed: RemovedEntry[];
  /** Files deleted, and files edited (POSIX, relative to the checkout). */
  readonly deleted: string[];
  readonly edited: string[];
  /** Generated folders removed (copies and stubs). */
  readonly generated: string[];
  readonly kept: KeptItem[];
  readonly problems: string[];
}

export interface RemovalOptions {
  /** The generated-path list (absolute paths), so stubs grimoire placed are found even where git ignores them. */
  readonly listed?: readonly string[];
  /** Called after each file the removal changes; what it throws stops the removal there, as a crash would (a test seam). */
  readonly onStep?: (path: string) => Promise<void> | void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(entry: ManifestEntry, drift: boolean): RemovedEntry {
  return {
    path: entry.path,
    kind: entry.kind,
    ...(entry.key ? { key: [...entry.key] } : {}),
    ...(entry.item !== undefined ? { item: entry.item } : {}),
    ...(entry.hook !== undefined ? { hook: entry.hook } : {}),
    ...(entry.marker !== undefined ? { marker: entry.marker } : {}),
    drift,
  };
}

/** The manifest's `format:`, or null when it names none. */
async function manifestFormat(root: string): Promise<number | null> {
  const read = await readCheckoutText(path.join(root, ...MANIFEST_PATH.split('/'))).catch(() => null);
  if (read?.state !== 'text') return null;
  const match = /^format:\s*(\d+)\s*$/m.exec(normalizedText(read.text));
  return match ? Number(match[1]) : null;
}

/** Whether git has `relative` exactly as the working tree holds it: tracked, and unchanged since the last commit. */
async function committedAsIs(root: string, relative: string): Promise<boolean> {
  const listed = await runGit(root, ['ls-files', '--error-unmatch', '--', relative]);
  if (listed.code !== 0) return false;
  const diff = await runGit(root, ['diff', '--quiet', 'HEAD', '--', relative]);
  return diff.code === 0;
}

/** The text of the frozen bootstrap as it appears inside a JSON value's serialization. */
const BOOTSTRAP_IN_JSON = JSON.stringify(BOOTSTRAP).slice(1, -1);

function mentionsBootstrap(value: unknown): boolean {
  return JSON.stringify(value)?.includes(BOOTSTRAP_IN_JSON) ?? false;
}

/** Whether a Claude Code hook group runs grimoire's `hook <verb>` through the frozen bootstrap. */
function isBootstrapHookGroup(group: unknown, hook: string): boolean {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((handler) => {
    const args = isPlainObject(handler) ? handler.args : undefined;
    if (!Array.isArray(args) || !args.includes(BOOTSTRAP)) return false;
    const at = args.indexOf('hook');
    return at >= 0 && args[at + 1] === hook;
  });
}

function valueAt(root: unknown, keys: readonly string[]): unknown {
  let at = root;
  for (const key of keys) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

/** Drops the containers along `keys` that the removal left empty, innermost first. */
function pruneEmpty(json: Record<string, unknown>, keys: readonly string[]): void {
  for (let depth = keys.length; depth >= 1; depth--) {
    const parent = valueAt(json, keys.slice(0, depth - 1));
    const value = valueAt(json, keys.slice(0, depth));
    const empty = Array.isArray(value) ? value.length === 0 : isPlainObject(value) && Object.keys(value).length === 0;
    if (!empty || !isPlainObject(parent)) return;
    delete parent[keys[depth - 1]!];
  }
}

type EntryOutcome = { readonly state: 'removed'; readonly drift: boolean } | { readonly state: 'gone' } | { readonly state: 'kept'; readonly why: string };

/** Takes one JSON entry out of `json`, in place. */
function removeJsonEntry(json: Record<string, unknown>, entry: ManifestEntry): EntryOutcome {
  const key = entry.key ?? [];
  if (key.length === 0) return { state: 'gone' };
  const parentKeys = key.slice(0, -1);
  const last = key.at(-1)!;
  if (entry.kind === 'npm-script') {
    const parent = valueAt(json, parentKeys);
    if (!isPlainObject(parent) || parent[last] === undefined) return { state: 'gone' };
    if (valueHash(parent[last]) !== entry.hash) {
      return { state: 'kept', why: `${key.join('.')} was changed since grimoire wrote it (it runs ${JSON.stringify(parent[last])}), so it stays` };
    }
    delete parent[last];
    pruneEmpty(json, parentKeys);
    return { state: 'removed', drift: false };
  }
  if (entry.kind === 'json-key') {
    const parent = valueAt(json, parentKeys);
    if (!isPlainObject(parent)) return { state: 'gone' };
    // The frozen bootstrap first: the server may have been renamed.
    let names = Object.keys(parent).filter((name) => mentionsBootstrap(parent[name]));
    if (names.length === 0 && parent[last] !== undefined) names = [last];
    if (names.length === 0) return { state: 'gone' };
    const drift = names.some((name) => name !== last || valueHash(parent[name]) !== entry.hash);
    for (const name of names) delete parent[name];
    pruneEmpty(json, parentKeys);
    return { state: 'removed', drift };
  }
  // json-array-item
  const array = valueAt(json, key);
  if (!Array.isArray(array)) return { state: 'gone' };
  let matches: number[];
  if (entry.hook !== undefined) {
    matches = array.flatMap((group, i) => (isBootstrapHookGroup(group, entry.hook!) ? [i] : []));
    if (matches.length === 0) matches = array.flatMap((group, i) => (isGrimoireHookGroup(group, entry.hook!) ? [i] : []));
  } else {
    matches = array.flatMap((value, i) => (value === entry.item ? [i] : []));
  }
  if (matches.length === 0) return { state: 'gone' };
  const drift = entry.hook !== undefined && matches.some((i) => valueHash(array[i]) !== entry.hash);
  for (const i of [...matches].reverse()) array.splice(i, 1);
  pruneEmpty(json, key);
  return { state: 'removed', drift };
}

/** The text without the block at `found`, with the blank line that set it apart. */
function withoutBlock(text: string, found: { start: number; stop: number }): string {
  const lines = text.replace(/\n$/, '').split('\n');
  const before = lines.slice(0, found.start);
  const after = lines.slice(found.stop + 1);
  if (after.length === 0 && before.at(-1) === '') before.pop();
  else if (before.length === 0 && after[0] === '') after.shift();
  else if (before.at(-1) === '' && after[0] === '') after.shift();
  const rest = [...before, ...after];
  return rest.length === 0 ? '' : `${rest.join('\n')}\n`;
}

/** The SessionStart groups after grimoire's Codex block, which move up when it goes. */
function shiftedGroups(text: string, found: { start: number; stop: number }): ShiftedGroup[] {
  const lines = text.split('\n');
  const before = sessionStartGroups(lines.slice(0, found.start).join('\n'));
  const inBlock = sessionStartGroups(lines.slice(found.start + 1, found.stop).join('\n'));
  const after = lines.slice(found.stop + 1);
  const shifted: ShiftedGroup[] = [];
  let current: { command: string | null } | null = null;
  for (const raw of after) {
    const line = raw.trim();
    if (/^\[\[\s*hooks\s*\.\s*SessionStart\s*\]\]\s*(#.*)?$/.test(line)) {
      current = { command: null };
      shifted.push({ from: before + inBlock + shifted.length, to: before + shifted.length, command: null });
      continue;
    }
    if (current && current.command === null) {
      const command = /^command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(line);
      if (command) {
        const literal = command[1]!;
        current.command = literal.startsWith("'") ? literal.slice(1, -1) : (JSON.parse(literal) as string);
        shifted[shifted.length - 1] = { ...shifted[shifted.length - 1]!, command: current.command };
      }
    }
  }
  return shifted;
}

/**
 * Whether a manifest path names a file inside the checkout: relative, POSIX,
 * with no empty, `.` or `..` segment, no backslash and no drive colon. A
 * committed manifest is input like any other: one that points elsewhere is
 * never followed (git can't bring back what goes outside the checkout).
 */
function insideCheckout(relative: string): boolean {
  if (relative === '' || relative.startsWith('/') || /[\\:\0]/.test(relative)) return false;
  return relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The files grimoire writes into besides what the manifest names: where an out-of-manifest mention may sit. */
const POINTER_FILES = ['.mcp.json', '.claude/settings.json', '.codex/config.toml', 'AGENTS.md', 'package.json', 'docs/agents/issue-tracker.md'];

/**
 * Plans the removal of what the manifest says grimoire wrote in the checkout
 * at `root`. Reads only.
 */
export async function planRemoval(root: string): Promise<RemovalPlan> {
  const manifest = await readManifest(root);
  const unknown: string[] = [...new Set<string>(manifest.entries.map((entry) => entry.kind).filter((kind) => !(ENTRY_KINDS as readonly string[]).includes(kind)))];
  const format = manifest.exists ? await manifestFormat(root) : null;
  if (format !== null && format > MANIFEST_FORMAT) unknown.unshift(`manifest format ${format}`);
  const empty = { root, manifest: manifest.exists, removed: [], gone: [], changes: [], kept: [], problems: [], mentions: [], codex: [] };
  if (unknown.length > 0) return { ...empty, unknown };

  const removed: RemovedEntry[] = [];
  const gone: RemovedEntry[] = [];
  const changes: FileChange[] = [];
  const kept: KeptItem[] = [];
  const problems: string[] = [];
  const codex: ShiftedGroup[] = [];
  const afterTexts = new Map<string, string | null>();
  const byPath = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.entries) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);

  for (const [relative, entries] of byPath) {
    const stop = (why: string) => problems.push(`${relative}: ${why}`);
    if (!insideCheckout(relative)) {
      stop('the manifest names a path outside this checkout (or not a plain relative path), so grimoire never follows it: fix the manifest, then run uninstall again');
      continue;
    }
    const link = await linkedComponent(root, relative);
    if (link !== null) {
      stop(`${link} is a symlink or junction; grimoire never changes anything through one`);
      continue;
    }
    const file = path.join(root, ...relative.split('/'));
    const info = await lstat(file).catch(() => null);
    if (info && !info.isFile()) {
      stop('it is not a file');
      continue;
    }
    const read = await readCheckoutText(file);
    if (read.state === 'not-text') {
      stop('it is not UTF-8 text');
      continue;
    }
    if (read.state === 'absent') {
      gone.push(...entries.map((entry) => describe(entry, false)));
      afterTexts.set(relative, null);
      continue;
    }
    const current = read.text;
    const created = entries.some((entry) => entry.created);
    const kinds = new Set(entries.map((entry) => entry.kind));
    const whole = kinds.has('file') || kinds.has('seeded-file');
    const json = kinds.has('json-key') || kinds.has('json-array-item') || kinds.has('npm-script');
    const blocks = kinds.has('marker-block') || kinds.has('toml-table');
    if (Number(whole) + Number(json) + Number(blocks) > 1) {
      stop('the manifest records entries of different kinds for it');
      continue;
    }

    if (whole) {
      const entry = entries[0]!;
      const drift = textHash(current) !== entry.hash;
      if (entry.kind === 'seeded-file') {
        if (drift) {
          kept.push({ path: relative, kind: entry.kind, why: 'it was changed since grimoire seeded it, so it is yours now' });
          afterTexts.set(relative, current);
          continue;
        }
      } else if (drift && !(await committedAsIs(root, relative))) {
        kept.push({ path: relative, kind: entry.kind, why: 'it was edited since grimoire wrote it, and git doesn’t have those edits: grimoire won’t delete them; delete it yourself once you’ve kept what you need' });
        afterTexts.set(relative, current);
        continue;
      }
      removed.push(describe(entry, drift));
      changes.push({ path: relative, before: current, after: null, created: true });
      afterTexts.set(relative, null);
      continue;
    }

    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(normalizedText(current));
      } catch {
        parsed = undefined;
      }
      if (!isPlainObject(parsed)) {
        stop(parsed === undefined ? 'it is not valid JSON (comments are not JSON): fix it, then run uninstall again' : 'it does not hold a JSON object');
        continue;
      }
      let changed = false;
      for (const entry of entries) {
        const outcome = removeJsonEntry(parsed, entry);
        if (outcome.state === 'removed') {
          removed.push(describe(entry, outcome.drift));
          changed = true;
        } else if (outcome.state === 'gone') gone.push(describe(entry, false));
        else kept.push({ path: relative, kind: entry.kind, why: outcome.why });
      }
      if (!changed) {
        afterTexts.set(relative, current);
        continue;
      }
      const deleted = created && Object.keys(parsed).length === 0;
      const after = deleted ? null : inFileStyle(current, `${JSON.stringify(parsed, null, jsonIndent(current))}\n`);
      changes.push({ path: relative, before: current, after, created });
      afterTexts.set(relative, after);
      continue;
    }

    // Marked blocks, removed even if edited.
    let text = normalizedText(current);
    let changed = false;
    let broken = false;
    for (const entry of entries) {
      const marker = entry.marker ?? '';
      const toml = entry.kind === 'toml-table';
      const { begin, end } = toml ? tomlMarkers(marker) : markdownMarkers(marker);
      const found = findBlock(text.split('\n'), begin, end);
      if (found === null) {
        gone.push(describe(entry, false));
        continue;
      }
      if (found === 'broken') {
        stop(`grimoire's block markers (${begin}) are broken or repeated: fix them, then run uninstall again`);
        broken = true;
        break;
      }
      const lines = text.split('\n');
      const body = lines.slice(found.start + 1, found.stop).map((line) => `${line}\n`).join('');
      let hash: string | null;
      try {
        hash = toml ? valueHash(parseToml(body)) : textHash(body);
      } catch {
        hash = null;
      }
      if (toml && marker === CODEX_MARKER && relative === '.codex/config.toml') codex.push(...shiftedGroups(text, found));
      removed.push(describe(entry, hash !== entry.hash));
      text = withoutBlock(text, found);
      changed = true;
    }
    if (broken) continue;
    if (!changed) {
      afterTexts.set(relative, current);
      continue;
    }
    const deleted = created && text.trim() === '';
    const after = deleted ? null : inFileStyle(current, text);
    changes.push({ path: relative, before: current, after, created });
    afterTexts.set(relative, after);
  }

  // What still mentions grimoire once the entries are out: never touched, only reported.
  const mentions: Mention[] = [];
  for (const relative of [...new Set([...byPath.keys(), ...POINTER_FILES])]) {
    if (!insideCheckout(relative)) continue;
    let text = afterTexts.has(relative) ? afterTexts.get(relative)! : null;
    if (!afterTexts.has(relative)) {
      if ((await linkedComponent(root, relative)) !== null) continue;
      const read = await readCheckoutText(path.join(root, ...relative.split('/'))).catch(() => null);
      text = read?.state === 'text' ? read.text : null;
    }
    if (text === null || relative.startsWith(`${DOTFOLDER}/`)) continue;
    normalizedText(text)
      .split('\n')
      .forEach((line, i) => {
        if (/grimoire/i.test(line)) mentions.push({ path: relative, line: i + 1, text: line.trim().slice(0, 200) });
      });
  }
  return { root, manifest: manifest.exists, unknown, removed, gone, changes, kept, problems, mentions, codex };
}

/**
 * Deletes `relative` if it still holds `before`; null when deleted, else why
 * not. The file is renamed aside first and the bytes that moved are compared,
 * so a save landing between a check and the unlink is never deleted: a
 * changed file is renamed back (or, when its place was taken meanwhile, left
 * aside and named).
 */
async function deleteIfUnchanged(root: string, relative: string, before: string): Promise<string | null> {
  const link = await linkedComponent(root, relative);
  if (link !== null) return `${link} is a symlink or junction; grimoire never changes anything through one`;
  const file = path.join(root, ...relative.split('/'));
  const read = await readCheckoutText(file);
  if (read.state === 'absent') return null;
  if (read.state !== 'text' || read.text !== before) return `${relative} changed while uninstall ran`;
  const aside = path.join(path.dirname(file), `.${path.basename(file)}.grimoire-${process.pid}-${randomBytes(4).toString('hex')}.removing`);
  try {
    await retryTransient(() => rename(file, aside));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const moved = await readCheckoutText(aside);
  if (moved.state === 'text' && moved.text === before) {
    await retryTransient(() => unlink(aside));
    return null;
  }
  // Put it back without replacing anything saved at its place meanwhile.
  try {
    await retryTransient(() => hardLink(aside, file));
    await retryTransient(() => unlink(aside));
    return `${relative} changed while uninstall ran`;
  } catch {
    return `${relative} changed while uninstall ran; what it held is kept in ${path.relative(root, aside).split(path.sep).join('/')}`;
  }
}

/** Removes the folders above `relative` that are empty now, up to (not including) the checkout root. */
async function removeEmptyParents(root: string, relative: string): Promise<void> {
  const parts = relative.split('/').slice(0, -1);
  while (parts.length > 0) {
    const dir = path.join(root, ...parts);
    const names = await readdir(dir).catch(() => null);
    if (names === null || names.length > 0) return;
    if (!(await rmdir(dir).then(() => true, () => false))) return;
    parts.pop();
  }
}

/**
 * Removes what `plan` planned, entries first; then, when every entry went
 * (or is kept by rule), config.yml, this worktree's generated output, the
 * manifest last and `.grimoire/` if empty.
 */
export async function removeCheckout(plan: RemovalPlan, options: RemovalOptions = {}): Promise<CheckoutRemoval> {
  const { root } = plan;
  const result: CheckoutRemoval = { complete: false, removed: [...plan.removed], deleted: [], edited: [], generated: [], kept: [...plan.kept], problems: [...plan.problems] };
  if (plan.unknown.length > 0) {
    result.problems.push(`the manifest names what this release doesn’t know: ${plan.unknown.join(', ')}`);
    return result;
  }
  const step = async (relative: string) => options.onStep?.(relative);

  for (const change of plan.changes) {
    try {
      if (change.after === null) {
        const why = await deleteIfUnchanged(root, change.path, change.before);
        if (why !== null) {
          result.problems.push(why);
          continue;
        }
        result.deleted.push(change.path);
        if (change.created) await removeEmptyParents(root, change.path);
      } else {
        const skip = await safeWrite(root, change.path, change.before, change.after);
        if (skip !== null) {
          result.problems.push(skip.reason === 'link' ? `${skip.at} is a symlink; grimoire never writes through one` : skip.reason === 'changed' ? `${change.path} changed while uninstall ran${keptNote(skip)}` : `${change.path} is not a file`);
          continue;
        }
        result.edited.push(change.path);
      }
    } catch (error) {
      result.problems.push(`${change.path}: ${messageOf(error)}`);
      continue;
    }
    await step(change.path);
  }
  if (result.problems.length > 0) return result;

  // The dotfolder: config.yml, the copies and stubs, then the manifest last.
  try {
    const config = await readCheckoutText(path.join(root, ...CONFIG_PATH.split('/')));
    if (config.state !== 'absent' && (await linkedComponent(root, CONFIG_PATH)) === null) {
      await retryTransient(() => unlink(path.join(root, ...CONFIG_PATH.split('/'))));
      result.deleted.push(CONFIG_PATH);
      await step(CONFIG_PATH);
    }
  } catch (error) {
    result.problems.push(`${CONFIG_PATH}: ${messageOf(error)}`);
    return result;
  }
  try {
    const generated = await removeGenerated(root, options.listed ?? []);
    result.generated.push(...generated.removed);
    result.kept.push(...generated.kept.map((entry) => ({ path: entry.path, why: entry.why })));
  } catch (error) {
    result.problems.push(`removing the generated copies and stubs failed: ${messageOf(error)}`);
    return result;
  }
  // Files in the dotfolder grimoire never wrote stay (the manifest and the copy root aside).
  const dot = path.join(root, DOTFOLDER);
  if ((await linkedComponent(root, DOTFOLDER)) === null) {
    for (const name of (await readdir(dot).catch(() => [] as string[])).sort()) {
      if (`${DOTFOLDER}/${name}` === MANIFEST_PATH || name === 'skills') continue;
      result.kept.push({ path: `${DOTFOLDER}/${name}`, why: 'grimoire didn’t write it' });
    }
  }
  try {
    if (plan.manifest && (await linkedComponent(root, MANIFEST_PATH)) === null) {
      await retryTransient(() => unlink(path.join(root, ...MANIFEST_PATH.split('/')))).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      result.deleted.push(MANIFEST_PATH);
      await step(MANIFEST_PATH);
    }
  } catch (error) {
    result.problems.push(`${MANIFEST_PATH}: ${messageOf(error)}`);
    return result;
  }
  if ((await linkedComponent(root, DOTFOLDER)) === null) await rmdir(dot).catch(() => {});
  result.complete = true;
  return result;
}
