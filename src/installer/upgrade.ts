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
// - Step 7: exactly the paths to commit, read back from git, so a resumed
//   upgrade reports what the interrupted run wrote too.
import { INSTALL_FORMAT_RANGE } from '../core/host';
import { GrimoireError } from '../errors';
import { runGit } from '../git/run';
import { MACHINE_FORMAT_RANGE, type MachineLocalStore } from '../machine-local';
import { TRACKER_FORMAT_RANGE } from '../tracker';
import { parseMarker } from '../tracker/marker';
import { worktreeKey } from '../upkeep/checkout';
import { UPGRADE_RECORDS, type UpgradeRecord } from './records';

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

/** Step 2: marks `worktree` as moving from `from` to `to`. */
export async function writeUpgradeRecord(store: MachineLocalStore, worktree: string, from: string, to: string): Promise<void> {
  await store.coordination.write<UpgradeRecord>(UPGRADE_RECORDS, await worktreeKey(worktree), { worktree, from, to, started_at: Date.now() });
}

/** Once config.yml pins the new version: the upgrade is done. Every record naming `worktree` goes. */
export async function clearUpgradeRecord(store: MachineLocalStore, worktree: string): Promise<void> {
  const key = await worktreeKey(worktree);
  for (const { key: name, value } of await store.coordination.list<Partial<UpgradeRecord>>(UPGRADE_RECORDS)) {
    if (name === key || (typeof value?.worktree === 'string' && (await worktreeKey(value.worktree)) === key)) {
      await store.coordination.remove(UPGRADE_RECORDS, name);
    }
  }
}

/** Of `candidates` (checkout-relative, `/`-separated), those git sees changed or new: what the upgrade's commit takes. Sorted. */
export async function pathsToCommit(root: string, candidates: readonly string[]): Promise<string[]> {
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
