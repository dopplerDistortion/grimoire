// The SessionStart fast path (spec §15 The SessionStart fast path; §12; §13):
// before the client lists skills, the hook makes this worktree's generated
// output match the served set, so Claude Code sees it on its first turn
// (`reloadSkills`, spike C B1) and Codex from its second (spike F B2; spike E
// P3: Codex runs hooks unsandboxed, so the hook can write).
//
// - The worktree is diffed against the served set, read through the
//   machine-local served-set cache (keyed by the tracker tip pair), so a
//   session start whose tracker didn't move reads no ledger at all; a
//   worktree that already matches is left without taking any lease.
// - Only what differs is written, under the (live store, worktree) lease
//   upkeep, `init` and `doctor --fix` share, and from a served set read again
//   under it: a delivery-off or delete whose refresh ran meanwhile is never
//   undone. A lease held elsewhere means that process is on it: the hook
//   writes nothing.
// - A changed copy is saved as a stray edit before the served text goes back.
//   Nothing is moved aside or removed in a hook, and nothing at all mid-merge
//   (or rebase, …), in a worktree on another pin, or past the hook's budget.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCheckoutConfig } from '../core/host';
import { GrimoireError } from '../errors';
import type { Lease, MachineLocalStore } from '../machine-local';
import { operationInProgress, upgradeInProgress, worktreeLeaseName } from '../upkeep/checkout';
import { VERSION } from '../version';
import { reconcileWorktree } from './reconcile';
import { cachedServedSet, type ServedSet } from './served';
import { copyFolder, GENERATED_GITIGNORE, SKILL_FILE, STUB_ROOTS, stubFolder, stubText, type StubClient } from './texts';

/** How long the hook waits for the worktree's lease held elsewhere before it leaves the work to that process. */
export const FAST_PATH_LEASE_WAIT_MS = 2_000;
/** The fast path's lease: long enough for its writes, short enough that a killed hook blocks nobody for long. */
const LEASE_TTL_MS = 30_000;

export interface FastPathOptions {
  /** The version this process runs (default: this build's). */
  readonly version?: string;
  /** How long to wait for the worktree's lease (default FAST_PATH_LEASE_WAIT_MS). */
  readonly leaseWaitMs?: number;
  /** Epoch ms past which nothing more is started (the hook's budget). */
  readonly deadline?: number;
}

export interface FastPathResult {
  /** Files written (POSIX, relative to the worktree). */
  readonly wrote: readonly string[];
  /** Copies saved to the stray-edit store before the served text went back. */
  readonly strayEdits: readonly { skill: string; path: string }[];
  /** Why nothing was tried, when nothing was: `pin`, `upgrade`, a git operation, `unsynced` (no tracker here), `held`, `budget`. */
  readonly skipped?: string;
}

const NOTHING: FastPathResult = { wrote: [], strayEdits: [] };

/** Whether `worktree`'s generated output differs from what `served` puts there (plain reads; no git). */
async function differs(worktree: string, served: ServedSet): Promise<boolean> {
  const holds = async (folder: string, text: string) => {
    const dir = path.join(worktree, ...folder.split('/'));
    const [ignore, skill] = await Promise.all([
      readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null),
      readFile(path.join(dir, SKILL_FILE), 'utf8').catch(() => null),
    ]);
    return ignore === GENERATED_GITIGNORE && skill === text;
  };
  for (const skill of served.skills) {
    if (!(await holds(copyFolder(skill.name), skill.text))) return true;
    for (const client of Object.keys(STUB_ROOTS) as StubClient[]) {
      if (!(await holds(stubFolder(client, skill.name), stubText(client, skill)))) return true;
    }
  }
  return false;
}

/** Why `worktree` is to be left alone by a process running `version`, or null. */
async function leaveAlone(store: MachineLocalStore, worktree: string, version: string): Promise<string | null> {
  const config = await readCheckoutConfig(worktree);
  if (config?.pin !== version) return 'pin';
  const operation = await operationInProgress(worktree);
  if (operation) return operation;
  const upgrade = await upgradeInProgress(store, worktree);
  if (upgrade && upgrade.to !== version) return 'upgrade';
  return null;
}

async function acquire(store: MachineLocalStore, worktree: string, waitMs: number): Promise<Lease | null> {
  const name = await worktreeLeaseName(worktree);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await store.leases.acquire(name, { ttlMs: LEASE_TTL_MS }).catch(() => null);
    if (result?.status === 'acquired') return result.lease;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
  }
}

/** The served set, or null without a tracker to read it from (nothing to write: upkeep says why). */
async function servedOrUnsynced(store: MachineLocalStore, worktree: string): Promise<ServedSet | null> {
  try {
    return await cachedServedSet(store, worktree);
  } catch (error) {
    if (error instanceof GrimoireError && error.code === 'NOT_SYNCED') return null;
    throw error;
  }
}

/** Runs the fast path in `worktree`: what it wrote, or why it didn't try. Throws only on what it couldn't read. */
export async function sessionStartFastPath(store: MachineLocalStore, worktree: string, options: FastPathOptions = {}): Promise<FastPathResult> {
  const version = options.version ?? VERSION;
  const late = () => options.deadline !== undefined && Date.now() >= options.deadline;
  const skip = await leaveAlone(store, worktree, version);
  if (skip) return { ...NOTHING, skipped: skip };
  // What it writes goes on the generated-path list, which the machine marker governs.
  await store.marker.check();
  const first = await servedOrUnsynced(store, worktree);
  if (!first) return { ...NOTHING, skipped: 'unsynced' };
  if (!(await differs(worktree, first))) return NOTHING;
  if (late()) return { ...NOTHING, skipped: 'budget' };
  const lease = await acquire(store, worktree, options.leaseWaitMs ?? FAST_PATH_LEASE_WAIT_MS);
  if (!lease) return { ...NOTHING, skipped: 'held' };
  try {
    // Under the lease: the checkout may have moved on, and a decision's refresh may have run.
    const again = await leaveAlone(store, worktree, version);
    if (again) return { ...NOTHING, skipped: again };
    const served = await servedOrUnsynced(store, worktree);
    if (!served) return { ...NOTHING, skipped: 'unsynced' };
    if (late()) return { ...NOTHING, skipped: 'budget' };
    const report = await reconcileWorktree(store, worktree, served, 'fast-path');
    return { wrote: report.wrote, strayEdits: report.strayEdits };
  } finally {
    await lease.release().catch(() => {});
  }
}
