// The pointer-file writer (spec §11, The manifest): compares what `init` wants
// in a checkout with what is there and with what the manifest says grimoire
// wrote, plans the changes, and applies them.
//
// - Generated content that drifted is rewritten.
// - A permission-bearing entry (a grant) that changed is reported and kept;
//   only an interactive `init` offers to restore it (`restoreGrants`).
// - A path, key or block grimoire's manifest doesn't record is never
//   overwritten: it is reported as a conflict, unless it already holds
//   exactly what grimoire would write (then it is recorded).
// - Symlinked paths are never written through, and invalid or commented JSON
//   is refused, per file.
// - A file is written by temp file plus rename, after re-checking that it
//   still holds what the plan saw.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { readTextIfExists } from '../machine-local';
import { keptNote, linkedComponent, readCheckoutText, safeWrite } from '../safe-write';
import {
  MANIFEST_PATH,
  canonicalJson,
  entryIdentity,
  normalizedText,
  readManifest,
  serializeManifest,
  textHash,
  valueHash,
  type ManifestEntry,
} from './manifest';
import { isGrimoireHookGroup, type DesiredEntry, type FileEntry, type JsonItemEntry, type JsonKeyEntry, type MarkerBlockEntry, type TomlBlockEntry } from './pointers';
import { markdownMarkers } from './texts';
import { parseToml, tomlClash, tomlString } from './toml';

/**
 * What happens to one entry:
 * - `create`: added (the file created, or the entry added to it);
 * - `unchanged`: already as grimoire writes it;
 * - `adopt`: already exactly as grimoire writes it, though the manifest
 *   didn't record it: recorded now;
 * - `update`: grimoire's earlier text, replaced by this release's;
 * - `rewrite`: edited since grimoire wrote it (drift): rewritten;
 * - `restore`: a changed grant, restored on request;
 * - `kept`: a changed grant, kept and reported;
 * - `conflict`: something grimoire doesn't own is in the way: left untouched;
 * - `skip`: a seeded file that is already there.
 */
export type EntryAction = 'create' | 'unchanged' | 'adopt' | 'update' | 'rewrite' | 'restore' | 'kept' | 'conflict' | 'skip';

export interface PlannedEntry {
  readonly path: string;
  readonly kind: DesiredEntry['kind'];
  readonly key?: readonly string[];
  readonly item?: string;
  readonly hook?: string;
  readonly marker?: string;
  readonly client?: string;
  readonly action: EntryAction;
  /** Why: the conflict, or the grant that changed. */
  readonly why?: string;
  /**
   * A TOML block's grants the person changed or removed, kept as they are
   * while the rest of the block is written (`kept`, `update`, `rewrite`).
   */
  readonly kept_grants?: readonly string[];
}

export interface PlannedWrite {
  readonly path: string;
  /** The file's text when planned; null when it didn't exist. */
  readonly before: string | null;
  readonly after: string;
}

export interface FilePlan {
  readonly root: string;
  readonly entries: readonly PlannedEntry[];
  /** The files that change, in order (the manifest not included). */
  readonly writes: readonly PlannedWrite[];
  /** The manifest after the writes. */
  readonly manifest: readonly ManifestEntry[];
  /** The manifest's text when planned (null: none), and after. */
  readonly manifestWrite: PlannedWrite | null;
  /** The manifest's text when planned; null when there was none. */
  readonly manifestBefore: string | null;
  /** Each planned entry's manifest entry before and after the plan: a skipped write keeps its path's entries as they were. */
  readonly records: readonly ManifestRecord[];
  /** Manifest entries this run doesn't want (another client, a declined adapter), kept as they were. */
  readonly untouched: readonly ManifestEntry[];
}

interface ManifestRecord {
  readonly path: string;
  readonly before: ManifestEntry | null;
  readonly after: ManifestEntry | null;
}

/** The manifest's entries once the writes are done: a path whose write was skipped keeps what it recorded before. */
function manifestEntries(records: readonly ManifestRecord[], untouched: readonly ManifestEntry[], skipped: ReadonlySet<string>): ManifestEntry[] {
  const kept = records.flatMap((record) => {
    const entry = skipped.has(record.path) ? record.before : record.after;
    return entry ? [entry] : [];
  });
  return [...kept, ...untouched];
}

/** The manifest write that leaves `entries`, or null when the manifest already holds them. */
function manifestWriteOf(before: string | null, entries: readonly ManifestEntry[]): PlannedWrite | null {
  const after = serializeManifest(entries);
  return before !== null && normalizedText(before) === after ? null : { path: MANIFEST_PATH, before, after };
}

export interface PlanOptions {
  /** Restore changed grants (only an interactive `init` asks). */
  readonly restoreGrants?: boolean;
}

/** One planned entry and the manifest entry it leaves (null: none). */
interface Outcome {
  readonly planned: PlannedEntry;
  readonly recorded: ManifestEntry | null;
}

function describe(entry: DesiredEntry): Omit<PlannedEntry, 'action' | 'why'> {
  return {
    path: entry.path,
    kind: entry.kind,
    ...('key' in entry ? { key: entry.key } : {}),
    ...('item' in entry && entry.item !== undefined ? { item: entry.item } : {}),
    ...('hook' in entry && entry.hook !== undefined ? { hook: entry.hook } : {}),
    ...('marker' in entry ? { marker: entry.marker } : {}),
    ...(entry.client ? { client: entry.client } : {}),
  };
}

function recordOf(entry: DesiredEntry, hash: string, created: boolean): ManifestEntry {
  const described = describe(entry);
  return {
    path: described.path,
    kind: described.kind,
    ...(described.key ? { key: [...described.key] } : {}),
    ...(described.item !== undefined ? { item: described.item } : {}),
    ...(described.hook !== undefined ? { hook: described.hook } : {}),
    ...(described.marker !== undefined ? { marker: described.marker } : {}),
    hash,
    created,
    ...(entry.client ? { client: entry.client } : {}),
    ...(entry.kind === 'json-array-item' && entry.permission ? { permission: true } : {}),
    ...(entry.kind === 'toml-table' && entry.grants.length > 0 ? { permission: true } : {}),
  };
}


/** Text as it is written back: the file's own byte order mark and line endings kept. */
export function inFileStyle(original: string | null, text: string): string {
  if (original === null) return text;
  const crlf = original.includes('\r\n');
  const bom = original.startsWith('﻿');
  return `${bom ? '﻿' : ''}${crlf ? text.replace(/\n/g, '\r\n') : text}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The indentation a JSON file uses (default two spaces). */
export function jsonIndent(text: string): string | number {
  const match = /^\{\s*\n([ \t]+)\S/.exec(normalizedText(text));
  return match ? match[1]! : 2;
}

/** Plans the entries of one whole file (`file`, `seeded-file`). */
function planWholeFile(entry: FileEntry, current: string | null, prior: ManifestEntry | undefined): { outcome: Outcome; after: string | null } {
  const described = describe(entry);
  const hash = textHash(entry.text);
  if (current === null) return { outcome: { planned: { ...described, action: 'create' }, recorded: recordOf(entry, hash, true) }, after: entry.text };
  if (entry.kind === 'seeded-file') {
    // Seeded files belong to the repo once written: never compared, never rewritten.
    return { outcome: { planned: { ...described, action: prior ? 'unchanged' : 'skip' }, recorded: prior ?? null }, after: null };
  }
  if (textHash(current) === hash) {
    return { outcome: { planned: { ...described, action: prior ? 'unchanged' : 'adopt' }, recorded: recordOf(entry, hash, prior?.created ?? false) }, after: null };
  }
  if (!prior) {
    return { outcome: { planned: { ...described, action: 'conflict', why: 'the file exists and grimoire did not write it' }, recorded: null }, after: null };
  }
  const action = textHash(current) === prior.hash ? 'update' : 'rewrite';
  return { outcome: { planned: { ...described, action }, recorded: recordOf(entry, hash, prior.created) }, after: entry.text };
}

/** The object at `keys` inside `root`, created on the way; null when something else is in the way. */
function objectAt(root: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  let at = root;
  for (const key of keys) {
    const next = at[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      at[key] = created;
      at = created;
    } else if (isPlainObject(next)) {
      at = next;
    } else {
      return null;
    }
  }
  return at;
}

/** Plans one entry of a parsed JSON file, editing `json` in place. */
function planJsonEntry(
  entry: JsonKeyEntry | JsonItemEntry,
  json: Record<string, unknown>,
  created: boolean,
  prior: ManifestEntry | undefined,
  options: PlanOptions,
): { outcome: Outcome; changed: boolean } {
  const described = describe(entry);
  const hash = valueHash(entry.value);
  const conflict = (why: string) => ({ outcome: { planned: { ...described, action: 'conflict' as const, why }, recorded: prior ?? null }, changed: false });
  const done = (action: EntryAction, changed: boolean) => ({
    outcome: { planned: { ...described, action }, recorded: recordOf(entry, hash, prior?.created ?? created) },
    changed,
  });
  const parent = objectAt(json, entry.key.slice(0, -1));
  const last = entry.key.at(-1)!;
  if (!parent) return conflict(`${entry.key.slice(0, -1).join('.')} is not an object`);

  if (entry.kind !== 'json-array-item') {
    const current = parent[last];
    if (current === undefined) {
      parent[last] = structuredClone(entry.value);
      return done(prior ? 'rewrite' : 'create', true);
    }
    if (canonicalJson(current) === canonicalJson(entry.value)) return done(prior ? 'unchanged' : 'adopt', false);
    if (!prior) return conflict(`${entry.key.join('.')} is already set, and grimoire did not set it`);
    parent[last] = structuredClone(entry.value);
    return done(valueHash(current) === prior.hash ? 'update' : 'rewrite', true);
  }

  let array = parent[last];
  if (array === undefined) {
    array = [];
    parent[last] = array;
  }
  if (!Array.isArray(array)) return conflict(`${entry.key.join('.')} is not an array`);
  const index = entry.hook !== undefined ? array.findIndex((item) => isGrimoireHookGroup(item, entry.hook!)) : array.findIndex((item) => item === entry.item);

  if (entry.permission) {
    if (index >= 0) return done(prior ? 'unchanged' : 'adopt', false);
    if (prior && !options.restoreGrants) {
      return { outcome: { planned: { ...described, action: 'kept', why: `${entry.item} was removed from ${entry.key.join('.')}` }, recorded: prior }, changed: false };
    }
    array.push(structuredClone(entry.value));
    return done(prior ? 'restore' : 'create', true);
  }
  if (index < 0) {
    array.push(structuredClone(entry.value));
    return done(prior ? 'rewrite' : 'create', true);
  }
  if (canonicalJson(array[index]) === canonicalJson(entry.value)) return done(prior ? 'unchanged' : 'adopt', false);
  if (!prior) return conflict(`a ${entry.hook} hook group is already in ${entry.key.join('.')}, and grimoire did not write it`);
  const current = array[index];
  array[index] = structuredClone(entry.value);
  return done(valueHash(current) === prior.hash ? 'update' : 'rewrite', true);
}

/** Plans every entry of one JSON file. */
function planJsonFile(
  entries: readonly (JsonKeyEntry | JsonItemEntry)[],
  current: string | null,
  priors: ReadonlyMap<string, ManifestEntry>,
  options: PlanOptions,
): { outcomes: Outcome[]; after: string | null } {
  let json: unknown = {};
  if (current !== null) {
    try {
      json = JSON.parse(normalizedText(current));
    } catch {
      json = undefined;
    }
  }
  if (!isPlainObject(json)) {
    const why = json === undefined ? 'the file is not valid JSON (comments are not JSON)' : 'the file does not hold a JSON object';
    return {
      outcomes: entries.map((entry) => ({ planned: { ...describe(entry), action: 'conflict', why }, recorded: priors.get(entryIdentity(describe(entry))) ?? null })),
      after: null,
    };
  }
  const object = json;
  let changed = false;
  const outcomes = entries.map((entry) => {
    const planned = planJsonEntry(entry, object, current === null, priors.get(entryIdentity(describe(entry))), options);
    changed ||= planned.changed;
    return planned.outcome;
  });
  if (!changed) return { outcomes, after: null };
  const indent = current === null ? 2 : jsonIndent(current);
  return { outcomes, after: inFileStyle(current, `${JSON.stringify(object, null, indent)}\n`) };
}

/** Where a marked block sits in a text: the lines of its markers. */
export function findBlock(lines: readonly string[], begin: string, end: string): { start: number; stop: number } | 'broken' | null {
  const starts = lines.flatMap((line, i) => (line.trim() === begin ? [i] : []));
  const stops = lines.flatMap((line, i) => (line.trim() === end ? [i] : []));
  if (starts.length === 0 && stops.length === 0) return null;
  if (starts.length !== 1 || stops.length !== 1 || stops[0]! < starts[0]!) return 'broken';
  return { start: starts[0]!, stop: stops[0]! };
}

/** The text with a block put in: in place of the old one, first, or last. */
function withBlock(text: string, block: string, at: { start: number; stop: number } | 'top' | 'end'): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const blockLines = block.replace(/\n$/, '').split('\n');
  if (at === 'top') return `${[...blockLines, ...(lines.length > 0 ? ['', ...lines] : [])].join('\n')}\n`;
  if (at === 'end') return `${[...lines, ...(lines.length > 0 ? [''] : []), ...blockLines].join('\n')}\n`;
  return `${[...lines.slice(0, at.start), ...blockLines, ...lines.slice(at.stop + 1)].join('\n')}\n`;
}

/** The markers of grimoire's TOML block. */
export function tomlMarkers(marker: string): { begin: string; end: string } {
  return { begin: `# >>> ${marker} (managed block)`, end: `# <<< ${marker}` };
}

function valueAt(table: unknown, keys: readonly string[]): unknown {
  let at = table;
  for (const key of keys) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  return at;
}

/** Plans a marked block (Markdown `marker-block`, or the TOML `toml-table` block). */
function planBlock(entry: MarkerBlockEntry | TomlBlockEntry, current: string | null, prior: ManifestEntry | undefined, options: PlanOptions): { outcome: Outcome; after: string | null } {
  const described = describe(entry);
  const toml = entry.kind === 'toml-table';
  const { begin, end } = toml ? tomlMarkers(entry.marker) : markdownMarkers(entry.marker);
  const parsed = (body: string): unknown => {
    try {
      return parseToml(body);
    } catch {
      return undefined;
    }
  };
  const desiredValue = toml ? parsed(entry.body) : null;
  const hash = toml ? valueHash(desiredValue) : textHash(entry.body);
  const blockOf = (body: string) => `${begin}\n${body}${end}\n`;
  const conflict = (why: string) => ({ outcome: { planned: { ...described, action: 'conflict' as const, why }, recorded: prior ?? null }, after: null });
  const record = (created: boolean) => recordOf(entry, hash, prior?.created ?? created);

  /**
   * grimoire's block body with every grant the person changed or removed kept
   * as theirs (a removed block removed them all), unless they are restored;
   * everything else in the block is grimoire's to rewrite.
   */
  const withGrants = (currentBody: string | null): { body: string; changed: string[]; restored: boolean } => {
    if (entry.kind !== 'toml-table') return { body: entry.body, changed: [], restored: false };
    const value = currentBody === null ? undefined : parsed(currentBody);
    let body = entry.body;
    const changed: string[] = [];
    for (const grant of entry.grants) {
      const name = grant.key.at(-1)!;
      const theirs = currentBody === null ? undefined : value === undefined ? grantLine(currentBody, name) : valueAt(value, grant.key);
      if (canonicalJson(theirs ?? null) === canonicalJson(grant.value)) continue;
      changed.push(grant.key.join('.'));
      const line = new RegExp(`^${name} = .*\\n`, 'm');
      body = body.replace(line, theirs === undefined ? '' : `${name} = ${typeof theirs === 'string' ? tomlString(theirs) : JSON.stringify(theirs)}\n`);
    }
    if (changed.length > 0 && options.restoreGrants) return { body: entry.body, changed, restored: true };
    return { body, changed, restored: false };
  };
  const keptNote = (grants: { changed: string[]; restored: boolean }, why: string) =>
    grants.changed.length > 0 && !grants.restored ? { why: `${grants.changed.join(', ')} ${why}`, kept_grants: grants.changed } : {};

  const text = current === null ? '' : normalizedText(current);
  const found = findBlock(text.split('\n'), begin, end);
  if (found === 'broken') return conflict(`grimoire's block markers (${begin}) are broken or repeated`);
  if (found === null) {
    if (toml) {
      const clash = tomlClash(text);
      if (clash) return conflict(clash);
    }
    const placement = entry.kind === 'marker-block' && entry.placement === 'top' ? 'top' : 'end';
    if (!prior) {
      return { outcome: { planned: { ...described, action: 'create' }, recorded: record(current === null) }, after: inFileStyle(current, withBlock(text, blockOf(entry.body), placement)) };
    }
    // grimoire's block is gone: it comes back, but the grants in it count as removed by the person.
    const grants = withGrants(null);
    return {
      outcome: { planned: { ...described, action: grants.restored ? 'restore' : 'rewrite', ...keptNote(grants, 'kept as removed') }, recorded: record(current === null) },
      after: inFileStyle(current, withBlock(text, blockOf(grants.body), placement)),
    };
  }

  const lines = text.split('\n');
  const currentBody = lines.slice(found.start + 1, found.stop).map((line) => `${line}\n`).join('');
  const same = toml ? currentBody.trim() !== '' && canonicalJson(parsed(currentBody)) === canonicalJson(desiredValue) : textHash(currentBody) === hash;
  if (same) return { outcome: { planned: { ...described, action: prior ? 'unchanged' : 'adopt' }, recorded: record(false) }, after: null };
  if (!prior) return conflict(`grimoire's block is already in the file, and grimoire's manifest doesn't record it`);

  const grants = withGrants(currentBody);
  if (grants.changed.length > 0 && !grants.restored && canonicalJson(parsed(currentBody)) === canonicalJson(parsed(grants.body))) {
    return { outcome: { planned: { ...described, action: 'kept', ...keptNote(grants, 'changed') }, recorded: prior }, after: null };
  }
  const before = toml ? valueHash(parsed(currentBody) ?? null) : textHash(currentBody);
  const action = grants.restored ? 'restore' : before === prior.hash ? 'update' : 'rewrite';
  return {
    outcome: { planned: { ...described, action, ...keptNote(grants, 'kept as changed') }, recorded: record(false) },
    after: inFileStyle(current, withBlock(text, blockOf(grants.body), found)),
  };
}

/** A grant's value read from a block that doesn't parse: the `<name> = "…"` line's string, if any. */
function grantLine(body: string, name: string): unknown {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(".*?"|'.*?')\\s*(#.*)?$`, 'm').exec(body);
  if (!match) return undefined;
  const raw = match[1]!;
  return raw.startsWith("'") ? raw.slice(1, -1) : (JSON.parse(raw) as unknown);
}

/** Plans the checkout's pointer files and dotfolder files against the manifest. Reads only. */
export async function planFiles(root: string, desired: readonly DesiredEntry[], options: PlanOptions = {}): Promise<FilePlan> {
  const manifest = await readManifest(root);
  const priors = new Map(manifest.entries.map((entry) => [entryIdentity(entry), entry]));
  const byPath = new Map<string, DesiredEntry[]>();
  for (const entry of desired) byPath.set(entry.path, [...(byPath.get(entry.path) ?? []), entry]);

  const outcomes: Outcome[] = [];
  const writes: PlannedWrite[] = [];
  for (const [relative, entries] of byPath) {
    const refuse = (why: string) =>
      outcomes.push(...entries.map((entry) => ({ planned: { ...describe(entry), action: 'conflict' as const, why }, recorded: priors.get(entryIdentity(describe(entry))) ?? null })));
    const link = await linkedComponent(root, relative);
    if (link !== null) {
      refuse(`${link} is a symlink; grimoire never writes through one`);
      continue;
    }
    const file = path.join(root, relative);
    const info = await lstat(file).catch(() => null);
    if (info && !info.isFile()) {
      refuse(`${relative} is not a file`);
      continue;
    }
    // Only text that round-trips is rewritten: anything else would come back with the person's text replaced.
    const read = await readCheckoutText(file);
    if (read.state === 'not-text') {
      refuse(`${relative} is not UTF-8 text`);
      continue;
    }
    const current = read.state === 'text' ? read.text : null;
    const prior = (entry: DesiredEntry) => priors.get(entryIdentity(describe(entry)));
    let after: string | null = null;
    const first = entries[0]!;
    if (first.kind === 'file' || first.kind === 'seeded-file') {
      const planned = planWholeFile(first, current, prior(first));
      outcomes.push(planned.outcome);
      after = planned.after;
    } else if (first.kind === 'json-key' || first.kind === 'json-array-item' || first.kind === 'npm-script') {
      const planned = planJsonFile(entries as (JsonKeyEntry | JsonItemEntry)[], current, priors, options);
      outcomes.push(...planned.outcomes);
      after = planned.after;
    } else {
      // One block per file: a later block entry for the same path would see the first one's text.
      let text = current;
      for (const entry of entries as (MarkerBlockEntry | TomlBlockEntry)[]) {
        const planned = planBlock(entry, text, prior(entry), options);
        outcomes.push(planned.outcome);
        if (planned.after !== null) text = after = planned.after;
      }
    }
    if (after !== null) writes.push({ path: relative, before: current, after });
  }

  const matched = new Set(outcomes.map((outcome) => entryIdentity(outcome.planned)));
  const records = outcomes.map((outcome) => ({ path: outcome.planned.path, before: priors.get(entryIdentity(outcome.planned)) ?? null, after: outcome.recorded }));
  const untouched = manifest.entries.filter((entry) => !matched.has(entryIdentity(entry)));
  const recorded = manifestEntries(records, untouched, new Set());
  const manifestBefore = (await readTextIfExists(path.join(root, MANIFEST_PATH))) ?? null;
  return {
    root,
    entries: outcomes.map((outcome) => outcome.planned),
    writes,
    manifest: recorded,
    manifestWrite: manifestWriteOf(manifestBefore, recorded),
    manifestBefore,
    records,
    untouched,
  };
}

export interface AppliedFiles {
  /** Paths written, in order; the manifest last. */
  readonly written: string[];
  /** Planned writes skipped because the file changed meanwhile, or turned into a symlink. */
  readonly skipped: { readonly path: string; readonly why: string }[];
}

/** Writes one planned file through a safe write (spec §13); returns why it was left alone, or null when written. */
export async function writePlanned(root: string, write: PlannedWrite): Promise<string | null> {
  const skip = await safeWrite(root, write.path, write.before, write.after);
  if (skip === null) return null;
  switch (skip.reason) {
    case 'link':
      return `${skip.at} is a symlink; grimoire never writes through one`;
    case 'changed':
      return `${write.path} changed while init ran${keptNote(skip)}`;
    case 'not-a-file':
      return `${write.path} is not a file`;
  }
}

/**
 * Applies a plan: the files in order, then the manifest. A file skipped
 * because it changed meanwhile keeps the manifest entries it had, or none:
 * the manifest never records a write that didn't happen.
 */
export async function applyFiles(plan: FilePlan): Promise<AppliedFiles> {
  const written: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  const write = async (planned: PlannedWrite) => {
    const why = await writePlanned(plan.root, planned);
    if (why === null) written.push(planned.path);
    else skipped.push({ path: planned.path, why });
  };
  for (const planned of plan.writes) await write(planned);
  const manifestWrite =
    skipped.length === 0 ? plan.manifestWrite : manifestWriteOf(plan.manifestBefore, manifestEntries(plan.records, plan.untouched, new Set(skipped.map((entry) => entry.path))));
  if (manifestWrite) await write(manifestWrite);
  return { written, skipped };
}
