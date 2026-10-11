// Content pointer-file refresh (spec §13 The first parts; §11 The manifest,
// drift; §12 doctor --fix): the content entries a checkout's manifest records
// (the instruction file, the AGENTS.md block, the adapter block, later the
// chore carriers) are rewritten when they drift from this release's shipped
// text. Grants, hook and server entries, run.cjs and the manifest itself are
// never touched here: only `init` writes those. Upkeep runs it; `doctor`
// reports the plan and `doctor --fix` applies it.
import path from 'node:path';
import { readTextIfExists } from '../machine-local';
import { safeWrite, type SafeWriteSkip } from '../safe-write';
import { CLIENTS, entryIdentity, normalizedText, readManifest, type ManifestEntry } from './manifest';
import { desiredEntries, isContentEntry, type DesiredEntry, type PointerOptions } from './pointers';
import { ADAPTER_DOC, ADAPTER_MARKER, adapterBlockBody, markdownMarkers } from './texts';
import { planFiles, type PlannedWrite } from './writer';

/** A content entry that can't be refreshed, and why. */
export interface ContentSkip {
  readonly path: string;
  readonly why: string;
}

export interface ContentPlan {
  /** The drifted content files, each with the text seen and the shipped text. */
  readonly writes: readonly PlannedWrite[];
  /** Recorded content entries left alone: a link on the path, broken markers, a folder in the way. */
  readonly skipped: readonly ContentSkip[];
}

export interface ContentRefresh {
  /** Paths rewritten with the shipped text, in order. */
  readonly refreshed: string[];
  readonly skipped: ContentSkip[];
}

/**
 * Where an adapter block that is already in the doc sits: `top` when it is the
 * superseding block (the one init put above another tracker's doc), else
 * `end`. Its own text decides when it is either shipped variant; a drifted
 * block is the superseding one when grimoire didn't create the doc and the
 * block opens it with more text after it.
 */
export function existingAdapterPlacement(doc: string, created: boolean | null): 'top' | 'end' {
  const { begin, end } = markdownMarkers(ADAPTER_MARKER);
  const lines = normalizedText(doc).split('\n');
  const start = lines.findIndex((line) => line.trim() === begin);
  const stop = lines.findIndex((line) => line.trim() === end);
  if (start < 0 || stop < start) return 'end';
  const body = lines.slice(start + 1, stop).map((line) => `${line}\n`).join('');
  if (body === adapterBlockBody({ supersedes: true })) return 'top';
  if (body === adapterBlockBody({ supersedes: false })) return 'end';
  const opens = lines.slice(0, start).every((line) => line.trim() === '');
  const more = lines.slice(stop + 1).some((line) => line.trim() !== '');
  return created !== true && opens && more ? 'top' : 'end';
}

function identity(entry: DesiredEntry): string {
  return entryIdentity({ path: entry.path, kind: entry.kind, ...('marker' in entry ? { marker: entry.marker } : {}) });
}

/** The content entries this checkout's manifest records, as this release ships them. */
async function recordedContentEntries(root: string, entries: readonly ManifestEntry[]): Promise<DesiredEntry[]> {
  const recorded = new Map(entries.map((entry) => [entryIdentity(entry), entry]));
  const adapter = entries.find((entry) => entry.path === ADAPTER_DOC && entry.kind === 'marker-block' && entry.marker === ADAPTER_MARKER);
  let placement: PointerOptions['adapter'] = 'none';
  if (adapter) {
    const doc = await readTextIfExists(path.join(root, ADAPTER_DOC));
    placement = doc === undefined ? 'end' : existingAdapterPlacement(doc, adapter.created);
  }
  return desiredEntries({ clients: CLIENTS, npmScript: false, adapter: placement })
    .filter(isContentEntry)
    .filter((entry) => recorded.has(identity(entry)));
}

/** What a refresh would write in `root` (reads only). A checkout without a manifest has nothing to refresh. */
export async function planContentRefresh(root: string): Promise<ContentPlan> {
  const manifest = await readManifest(root);
  if (!manifest.exists) return { writes: [], skipped: [] };
  const desired = await recordedContentEntries(root, manifest.entries);
  if (desired.length === 0) return { writes: [], skipped: [] };
  const plan = await planFiles(root, desired);
  return {
    writes: plan.writes,
    skipped: plan.entries.filter((entry) => entry.action === 'conflict').map((entry) => ({ path: entry.path, why: entry.why ?? 'conflict' })),
  };
}

function skipWhy(relative: string, skip: SafeWriteSkip): string {
  switch (skip.reason) {
    case 'link':
      return `${skip.at} is a symlink or junction; grimoire never writes through one`;
    case 'changed':
      return `${relative} changed while grimoire refreshed it`;
    case 'not-a-file':
      return `${relative} is not a file`;
  }
}

/**
 * Rewrites every drifted content entry of `root` with the shipped text,
 * through safe writes. Never writes the manifest. A write that fails is
 * skipped with its error, and the rest still go: what was refreshed is
 * always returned, so it is always reported.
 */
export async function refreshContentPointers(root: string): Promise<ContentRefresh> {
  const plan = await planContentRefresh(root);
  const refreshed: string[] = [];
  const skipped = [...plan.skipped];
  for (const write of plan.writes) {
    try {
      const skip = await safeWrite(root, write.path, write.before, write.after);
      if (skip === null) refreshed.push(write.path);
      else skipped.push({ path: write.path, why: skipWhy(write.path, skip) });
    } catch (error) {
      skipped.push({ path: write.path, why: `grimoire couldn't write it (${error instanceof Error ? error.message : String(error)})` });
    }
  }
  return { refreshed, skipped };
}
