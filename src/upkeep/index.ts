// Upkeep (spec §2 module 10, §13): grimoire's mechanical background work,
// scheduled inside `grimoire mcp`, `start` and `init` under machine-local
// leases; never done by an LLM, never in a short-lived CLI call or a hook.
export {
  CLONE_INTERVAL_MS,
  UPKEEP_STAMPS,
  WORKTREE_INTERVAL_MS,
  holdWorktreeLease,
  partLeaseName,
  runUpkeep,
  worktreeLeaseName,
  type PartInput,
  type PartOutcome,
  type PartRun,
  type PartScope,
  type PartStatus,
  type UpkeepOptions,
  type UpkeepPart,
  type UpkeepReport,
} from './run';
export { UPKEEP_EVERY_MS, startUpkeep, type UpkeepLoop, type UpkeepLoopOptions } from './loop';
export { operationInProgress, upgradeInProgress, upgradeSkipNotice, worktreeKey, type GitOperation } from './checkout';
export { UPKEEP_PARTS, pendingSync, pointerRefresh, pruneCopiesPart } from './parts';
export { POINTER_REFRESH_RECORDS, refreshNotice, refreshedPointerFiles, type PointerRefreshRecord } from './refreshed';
