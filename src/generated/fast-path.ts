// The SessionStart fast path's writes (spec §15 The SessionStart fast path;
// §12): before the client lists skills, the hook writes the copies and stubs
// this worktree is missing, so Claude Code sees them on its first turn
// (`reloadSkills`, spike C B1) and Codex from its second (spike F B2; spike E
// P3: Codex runs hooks unsandboxed). Only what is absent is written: nothing
// is replaced, moved or removed in a hook, and nothing at all mid-merge or in
// a worktree on another pin; upkeep does the rest.
import { readCheckoutConfig } from '../core/host';
import type { MachineLocalStore } from '../machine-local';
import { operationInProgress, upgradeInProgress } from '../upkeep/checkout';
import { VERSION } from '../version';
import { reconcileWorktree } from './reconcile';
import { ledgerMayExist, readServedSet } from './served';

/** Writes the generated output `worktree` is missing; true when it wrote anything. */
export async function writeMissingOutput(store: MachineLocalStore, worktree: string, version: string = VERSION): Promise<boolean> {
  const config = await readCheckoutConfig(worktree);
  if (config?.pin !== version) return false;
  if (await operationInProgress(worktree)) return false;
  const upgrade = await upgradeInProgress(store, worktree);
  if (upgrade && upgrade.to !== version) return false;
  // What it writes goes on the generated-path list, which the machine marker governs.
  await store.marker.check();
  if (!(await ledgerMayExist(worktree, store.commonDir))) return false;
  const served = await readServedSet(worktree);
  if (served.skills.length === 0) return false;
  const report = await reconcileWorktree(store, worktree, served, 'missing');
  return report.wrote.length > 0;
}
