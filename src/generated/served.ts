// The served set (spec §15 Where the text lives, Reconcile, Delete and
// delivery off): the evolved skills agents get, from the skill ledger in the
// merged tracker view alone, so branches play no part. The knowledge engine
// decides what each skill serves (a version failing the content checks is
// served nowhere, and the one before it keeps serving); the store's delivery
// switch, off, serves none.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readSkills, type ServedSkill } from '../knowledge';
import { bundledRules, createScanner, type SecretScanner } from '../scanner';
import { runGit } from '../git/run';
import { openTracker, TRACKER_REF, type TrackerStore, type TrackerTips, type TrackerView } from '../tracker';
import { LEDGER_DIR } from '../tracker/layout';
import { storeSetting } from '../core/settings';
import type { MachineLocalStore } from '../machine-local';
import { VERSION } from '../version';

export interface ServedSet {
  /** The store's delivery switch (`skills.delivery`). */
  readonly delivery: boolean;
  /** What agents get, by name: none while delivery is off. */
  readonly skills: readonly ServedSkill[];
  /**
   * Every version the ledger records for each skill, by name: a copy holding
   * one of them is grimoire's text, anything else is a stray edit.
   */
  readonly known: ReadonlyMap<string, ReadonlySet<string>>;
}

let shared: SecretScanner | null = null;

/** One scanner per process, so the knowledge engine's per-scanner memo serves every read. */
export function sharedScanner(): SecretScanner {
  return (shared ??= createScanner(bundledRules));
}

/** The served set of a tracker view. */
export async function servedSetOf(view: TrackerView, scanner: SecretScanner = sharedScanner()): Promise<ServedSet> {
  const book = await readSkills(view, scanner);
  const delivery = storeSetting(view, 'skills.delivery') !== false;
  const known = new Map<string, Set<string>>();
  for (const state of book.skills.values()) {
    known.set(state.name, new Set(state.records.map((record) => record.to).filter((version): version is string => version !== null)));
  }
  return { delivery, skills: delivery ? book.served : [], known };
}

/** What agents are served, as one string: two views with the same fingerprint need no refresh between them. */
export function servedFingerprint(served: ServedSet): string {
  const names = served.skills.map((skill) => `${skill.name}@${skill.version}`).sort();
  return createHash('sha256').update(`${served.delivery}\n${names.join('\n')}`, 'utf8').digest('hex');
}

/**
 * The served set's fingerprint in what `tracker` reads now; null when it
 * can't be read. A sync compares it before and after: a fold that changed a
 * current version asks for a refresh (spec §15 Refresh scope).
 */
export async function readServedFingerprint(tracker: { read(): Promise<TrackerView> }, scanner?: SecretScanner): Promise<string | null> {
  try {
    return servedFingerprint(await servedSetOf(await tracker.read(), scanner));
  } catch {
    return null;
  }
}

/**
 * False only when no tracker ref of the clone holds a skill ledger, so nothing
 * can be served: two short gits instead of opening the tracker, which upkeep
 * passes and session starts in a repo without evolved skills (every repo at
 * first) need not pay for. True whenever it can't tell.
 */
export async function ledgerMayExist(root: string, commonDir: string): Promise<boolean> {
  // The tracker refs this clone may have, named without a git: every remote's, loose or packed.
  const refs = new Set([TRACKER_REF]);
  for (const remote of await readdir(path.join(commonDir, 'refs', 'remotes')).catch(() => [] as string[])) refs.add(`refs/remotes/${remote}/grimoire/tracker`);
  const packed = await readFile(path.join(commonDir, 'packed-refs'), 'utf8').catch(() => '');
  for (const match of packed.matchAll(/^[0-9a-f]{40,64} (refs\/remotes\/[^\s]+\/grimoire\/tracker)$/gm)) refs.add(match[1]!);
  // One git: each ref itself, then its ledger folder.
  const lines = [...refs].flatMap((ref) => [ref, `${ref}:${LEDGER_DIR}`]);
  const check = await runGit(root, ['cat-file', '--batch-check'], { input: lines.map((line) => `${line}\n`).join('') });
  if (check.code !== 0) return true;
  const answers = check.stdout.toString('utf8').split(/\r?\n/);
  const found = (i: number) => answers[i] !== undefined && !answers[i]!.endsWith(' missing');
  // No tracker at all: the full read says so.
  if (!lines.some((_line, i) => i % 2 === 0 && found(i))) return true;
  return lines.some((_line, i) => i % 2 === 1 && found(i) && / tree /.test(answers[i]!));
}

/** The served set of the clone `root` is in, read from its tracker; throws when the tracker can't be read. */
export async function readServedSet(root: string, scanner?: SecretScanner): Promise<ServedSet> {
  const tracker = await openTracker(root);
  try {
    return await servedSetOf(await tracker.read(), scanner);
  } finally {
    await tracker.close();
  }
}

/** The served-set cache (spec §6 Caches): clone-wide, one entry, valid only for the tracker tip pair it was read at. */
export const SERVED_SET_CACHE = 'served-set';
const SERVED_SET_CACHE_VERSION = 1;

/** The served-set cache as stored. */
interface CachedServedSet {
  /** The tip pair it was read at: `<local>:<remote>`, `-` for a missing ref. */
  readonly tips: string;
  /** The release that read it: another release may derive another served set from the same tips. */
  readonly release: string;
  readonly delivery: boolean;
  readonly skills: readonly ServedSkill[];
  readonly known: Readonly<Record<string, readonly string[]>>;
}

/** The cache key of a tip pair. */
export function tipPairKey(tips: TrackerTips): string {
  return `${tips.local ?? '-'}:${tips.remote ?? '-'}`;
}

function fromCache(cached: CachedServedSet): ServedSet | null {
  if (typeof cached.delivery !== 'boolean' || !Array.isArray(cached.skills) || typeof cached.known !== 'object' || cached.known === null) return null;
  const known = new Map(Object.entries(cached.known).map(([name, versions]) => [name, new Set(Array.isArray(versions) ? versions : [])] as const));
  return { delivery: cached.delivery, skills: cached.skills, known };
}

function toCache(tips: string, served: ServedSet): CachedServedSet {
  return {
    tips,
    release: VERSION,
    delivery: served.delivery,
    skills: served.skills.map(({ name, version, description, text }) => ({ name, version, description, text })),
    known: Object.fromEntries([...served.known].map(([name, versions]) => [name, [...versions].sort()])),
  };
}

/** No tracker ref at all, or none holding a ledger: nothing is served (the delivery switch can't matter). */
const NOTHING_SERVED: ServedSet = { delivery: true, skills: [], known: new Map() };

/**
 * The served set of the clone `root` is in, through the machine-local
 * served-set cache: read from the tracker (the whole ledger, every version
 * judged) only when the tip pair moved since the cache was written. What is
 * read is cached only when the tip pair stayed put meanwhile. Throws when the
 * tracker can't be read.
 */
export async function cachedServedSet(store: MachineLocalStore, root: string, scanner?: SecretScanner): Promise<ServedSet> {
  const tracker = await openTracker(root);
  try {
    return await cachedServedSetOf(store, tracker, scanner);
  } finally {
    await tracker.close();
  }
}

async function cachedServedSetOf(store: MachineLocalStore, tracker: TrackerStore, scanner?: SecretScanner): Promise<ServedSet> {
  const tips = await tracker.tips();
  const key = tipPairKey(tips);
  const cached = await store.caches.read<CachedServedSet>(SERVED_SET_CACHE, SERVED_SET_CACHE_VERSION).catch(() => undefined);
  if (cached && cached.tips === key && cached.release === VERSION) {
    const served = fromCache(cached);
    if (served) return served;
  }
  const none = tips.local === null && tips.remote === null;
  const served =
    none || !(await ledgerMayExist(tracker.location.root, tracker.location.commonDir)) ? NOTHING_SERVED : await servedSetOf(await tracker.read(), scanner);
  if (tipPairKey(await tracker.tips()) === key) {
    // A cache: one that can't be written is read again next time.
    await store.caches.put(SERVED_SET_CACHE, SERVED_SET_CACHE_VERSION, toCache(key, served)).catch(() => {});
  }
  return served;
}
