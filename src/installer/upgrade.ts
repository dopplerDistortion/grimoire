// `init --upgrade` (spec §21 Upgrade; §5): what `init` adds to move one
// checkout to the pin of the release that runs it. The steps themselves are
// init's (./init.ts); this module holds what only an upgrade reads and writes:
//
// - Step 0: every marker against the J..K this release declares. A compat
//   outside the release's K refuses (a downgrade below what the data needs);
//   one below its J needs a compat raise, which `--yes` never makes.
// - Step 2: the machine-local upgrade-in-progress record, written before the
//   (store, worktree) lease is taken and removed once config.yml pins the new
//   version. While it exists, upkeep, `init` and `doctor --fix` at any other
//   pin leave the worktree alone, and pruning keeps both copies.
// - Step 7: exactly the paths to commit: those the upgrade changes against
//   HEAD (so a resumed upgrade reports what the interrupted run wrote too),
//   never the person's own uncommitted work in files it leaves alone.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTALL_FORMAT_RANGE } from '../core/host';
import { GrimoireError } from '../errors';
import { runGit } from '../git/run';
import { MACHINE_FORMAT_RANGE, type MachineLocalStore } from '../machine-local';
import { TRACKER_FORMAT_RANGE } from '../tracker';
import { parseMarker } from '../tracker/marker';
import { upgradeInProgress, worktreeKey } from '../upkeep/checkout';
import { CONFIG_PATH } from './config';
import { MANIFEST_PATH } from './manifest';
import type { DesiredEntry } from './pointers';
import { UPGRADE_RECORDS, type UpgradeRecord } from './records';
import { planFiles, type PlanOptions } from './writer';

/** What a release understands of one marker: it runs iff J ≤ compat ≤ K. */
export interface FormatRange {
  readonly J: number;
  readonly K: number;
}

/** The J..K a release declares per marker (spec §21, rule 1). */
export interface ReleaseFormats {
  readonly store: FormatRange;
  readonly machine: FormatRange;
  readonly install: FormatRange;
}

/** What this release declares. */
export const RELEASE_FORMATS: ReleaseFormats = { store: TRACKER_FORMAT_RANGE, machine: MACHINE_FORMAT_RANGE, install: INSTALL_FORMAT_RANGE };

export type MarkerName = keyof ReleaseFormats;

/**
 * `absent`: there is no such data here yet; `stays`: the release runs against
 * it as it is; `rises`: the release runs against it and its format rises
 * additively; `compat-raise`: the release needs a migration that raises compat.
 */
export type MarkerVerdict = 'absent' | 'stays' | 'rises' | 'compat-raise';

export interface MarkerPlan {
  readonly marker: MarkerName;
  readonly format: number | null;
  readonly compat: number | null;
  readonly requires: string | null;
  readonly verdict: MarkerVerdict;
}

export interface MarkerReading {
  readonly format: number | null;
  readonly compat: number | null;
  readonly requires: string | null;
}

/** The tracker's marker at each tip, folded as markers fold: field by field, the highest; `requires` follows compat. Null with no tip. */
export async function readStoreMarker(root: string, tips: readonly (string | null)[]): Promise<MarkerReading | null> {
  let folded: { format: number | null; compat: number | null; requires: string | null } | null = null;
  for (const tip of tips) {
    if (tip === null) continue;
    const blob = await runGit(root, ['cat-file', 'blob', `${tip}:format`]);
    const marker = blob.code === 0 ? parseMarker(blob.stdout.toString('utf8')) : { format: null, compat: null, requires: null };
    if (folded === null) {
      folded = { ...marker };
      continue;
    }
    const higher = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
    if ((marker.compat ?? -1) > (folded.compat ?? -1)) folded.requires = marker.requires;
    folded.format = higher(folded.format, marker.format);
    folded.compat = higher(folded.compat, marker.compat);
  }
  return folded;
}

/**
 * One marker against the release's J..K. Throws UPGRADE_REQUIRED when the
 * data is newer than the release understands: the target can't run against it.
 */
export function planMarker(marker: MarkerName, reading: MarkerReading | null, range: FormatRange, running: string, pin: string | null): MarkerPlan {
  if (reading === null) return { marker, format: null, compat: null, requires: null, verdict: 'absent' };
  const { format, compat, requires } = reading;
  if (compat !== null && compat > range.K) {
    throw new GrimoireError(
      'UPGRADE_REQUIRED',
      `grimoire ${running} can't run against this ${marker === 'install' ? 'checkout’s install_format' : `${marker} marker`} (compat ${compat}${requires ? `, which needs grimoire ${requires} or later` : ''}); nothing changed`,
      { marker, why: 'newer', running, pin, requires, remedies: [] },
    );
  }
  const verdict: MarkerVerdict = compat === null || compat < range.J ? 'compat-raise' : format !== null && format < range.K ? 'rises' : 'stays';
  return { marker, format, compat, requires, verdict };
}

export function describeMarker(plan: MarkerPlan, range: FormatRange): string {
  switch (plan.verdict) {
    case 'absent':
      return `${plan.marker}: none here yet`;
    case 'stays':
      return `${plan.marker}: stays at format ${plan.format}, compat ${plan.compat}`;
    case 'rises':
      return `${plan.marker}: format ${plan.format} rises additively to ${range.K} (compat ${plan.compat} stays)`;
    case 'compat-raise':
      return `${plan.marker}: compat ${plan.compat ?? 'unknown'} must be raised to ${range.J} by a migration`;
  }
}

function sameRecord(a: UpgradeRecord | null | undefined, b: UpgradeRecord | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.from === b.from && a.to === b.to && a.started_at === b.started_at && a.token === b.token;
}

/**
 * Step 2: marks `worktree` as moving from `from` to `to`, a compare-and-set
 * against `expected` (the record this run read before its plan). Returns the
 * record written, or null when another upgrade's record came first: this run
 * then refuses, and leaves that one alone.
 */
export async function claimUpgradeRecord(store: MachineLocalStore, worktree: string, expected: UpgradeRecord | null, from: string, to: string): Promise<UpgradeRecord | null> {
  const mine: UpgradeRecord = { worktree, from, to, started_at: Date.now(), token: randomBytes(8).toString('hex') };
  let claimed = false;
  await store.coordination.update<UpgradeRecord>(UPGRADE_RECORDS, await worktreeKey(worktree), async (current) => {
    if (!sameRecord(await upgradeInProgress(store, worktree), expected)) return current;
    claimed = true;
    return mine;
  });
  return claimed ? mine : null;
}

/**
 * Undoes a claim when the run did nothing: back to the record it replaced,
 * unless that upgrade is done meanwhile (config.yml pins its `to`). A record
 * another run wrote since stays as it is.
 */
export async function releaseUpgradeRecord(store: MachineLocalStore, worktree: string, mine: UpgradeRecord, replaced: UpgradeRecord | null, pinned: string | null): Promise<void> {
  await store.coordination.update<UpgradeRecord>(UPGRADE_RECORDS, await worktreeKey(worktree), (current) =>
    !sameRecord(current, mine) ? current : replaced && replaced.to !== pinned ? replaced : undefined,
  );
}

/**
 * Once config.yml pins `pinned`: this run's record goes, and so does any
 * record of an upgrade to `pinned` (it is done too). A record of an upgrade to
 * another version, written since by another run, stays.
 */
export async function finishUpgradeRecord(store: MachineLocalStore, worktree: string, mine: UpgradeRecord, pinned: string): Promise<void> {
  const key = await worktreeKey(worktree);
  for (const { key: name, value } of await store.coordination.list<Partial<UpgradeRecord>>(UPGRADE_RECORDS)) {
    if (name !== key && !(typeof value?.worktree === 'string' && (await worktreeKey(value.worktree)) === key)) continue;
    await store.coordination.update<UpgradeRecord>(UPGRADE_RECORDS, name, (current) => (current && (sameRecord(current, mine) || current.to === pinned) ? undefined : current));
  }
}

/**
 * Step 7: the paths the upgrade changes that git sees changed: what its commit
 * takes. The upgrade's own change is the plan of `desired` against HEAD's
 * blobs (so a resumed upgrade counts what the interrupted run wrote), never
 * every path git reports: the person's uncommitted work in a file the upgrade
 * leaves as HEAD has it stays out. config.yml is always a candidate. Sorted,
 * checkout-relative, `/`-separated.
 */
export async function pathsToCommit(root: string, desired: readonly DesiredEntry[], options: PlanOptions = {}): Promise<string[]> {
  const head = await mkdtemp(path.join(tmpdir(), 'grimoire-upgrade-head-'));
  let touched: string[];
  try {
    for (const relative of new Set([...desired.map((entry) => entry.path), MANIFEST_PATH])) {
      const blob = await runGit(root, ['cat-file', 'blob', `HEAD:${relative}`]);
      if (blob.code !== 0) continue;
      const file = path.join(head, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, blob.stdout);
    }
    const plan = await planFiles(head, desired, options);
    touched = [...plan.writes.map((write) => write.path), ...(plan.manifestWrite ? [MANIFEST_PATH] : []), CONFIG_PATH];
  } finally {
    await rm(head, { recursive: true, force: true }).catch(() => {});
  }
  return changedOf(root, [...new Set(touched)]);
}

/** Of `candidates`, those git sees changed or new. Sorted. */
async function changedOf(root: string, candidates: readonly string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const run = await runGit(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...candidates]);
  if (run.code !== 0) return [...candidates].sort();
  const fields = run.stdout.toString('utf8').split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.add(field.slice(3));
    // A rename or copy names its source next.
    if (field[0] === 'R' || field[0] === 'C') i++;
  }
  return [...paths].sort();
}

/** The command step 7 prints. */
export function commitCommand(paths: readonly string[], version: string): string | null {
  return paths.length === 0 ? null : `git add ${paths.join(' ')} && git commit -m "Upgrade grimoire to ${version}"`;
}
