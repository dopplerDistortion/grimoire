// What upkeep reads about a worktree before it touches it (spec §13 When it
// skips; §21 step 2): a git operation in progress, an upgrade in progress to
// another pin, and the worktree's canonical name for leases and records.
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { joinCommand } from '../installer/bootstrap';
import { UPGRADE_RECORDS, type UpgradeRecord } from '../installer/records';
import { findGitDirs, type MachineLocalStore } from '../machine-local';

/** A worktree's path as leases, stamps and records key it: real, and case-folded where the file system folds case. */
export async function worktreeKey(worktree: string): Promise<string> {
  const real = await realpath(worktree).catch(() => path.resolve(worktree));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** A git operation that leaves a worktree half-done. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

/** What git keeps in a worktree's own git dir while each operation runs. */
const OPERATION_MARKS: readonly (readonly [string, GitOperation])[] = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
  ['BISECT_START', 'bisect'],
  // A multi-commit cherry-pick or revert stopped between its commits.
  ['sequencer', 'cherry-pick'],
];

/**
 * The merge, rebase, cherry-pick, revert or bisect in progress in `worktree`,
 * read from its own git dir without spawning git; null when none is (or the
 * folder isn't a checkout).
 */
export async function operationInProgress(worktree: string): Promise<GitOperation | null> {
  const dirs = await findGitDirs(worktree);
  if (!dirs) return null;
  for (const [mark, operation] of OPERATION_MARKS) {
    if (await stat(path.join(dirs.gitDir, mark)).catch(() => null)) return operation;
  }
  return null;
}

/** The upgrade-in-progress record for `worktree` (spec §21 step 2), or null. */
export async function upgradeInProgress(store: MachineLocalStore, worktree: string): Promise<UpgradeRecord | null> {
  const key = await worktreeKey(worktree);
  for (const { value } of await store.coordination.list<Partial<UpgradeRecord>>(UPGRADE_RECORDS)) {
    if (typeof value?.worktree !== 'string' || typeof value.to !== 'string') continue;
    if ((await worktreeKey(value.worktree)) === key) return value as UpgradeRecord;
  }
  return null;
}

/** The line every process at another pin prints for a worktree an upgrade is moving (spec §21 step 2). */
export function upgradeSkipNotice(worktree: string, to: string): string {
  return `grimoire skipped ${worktree}: an upgrade to ${to} is in progress there; finish with \`${joinCommand(to)} --upgrade\`, or discard with \`git restore\``;
}
