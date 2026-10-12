// Generated output (spec §2 module 7, §15): per registered worktree, the
// evolved-skill copies and skill stubs nobody commits, the generated-path
// list, the stray-edit store, and the SessionStart fast path's writes.
// Upkeep (src/upkeep) schedules the reconcile; the core asks for a refresh
// when the served set changes.
import type { ReconcileReport } from './reconcile';
import { strayEditNotice } from './stray';

export { existingFolders, mayHoldGeneratedOutput, reconcileWorktree, MOVED_ASIDE, type ReconcileMode, type ReconcileReport } from './reconcile';
export {
  cachedServedSet,
  ledgerMayExist,
  readServedFingerprint,
  readServedSet,
  SERVED_SET_CACHE,
  servedFingerprint,
  servedSetOf,
  sharedScanner,
  tipPairKey,
  type ServedSet,
} from './served';
export { comparablePath, pathListFile, readPathList, updatePathList } from './path-list';
export {
  dropStrayEdit,
  listStrayEdits,
  openAttemptsOf,
  readStrayEdit,
  setAsideStrayEdit,
  strayEditNotice,
  STRAY_EDITS,
  type StrayEdit,
  type StrayEditEntry,
} from './stray';
export { sessionStartFastPath, FAST_PATH_LEASE_WAIT_MS, type FastPathOptions, type FastPathResult } from './fast-path';
export {
  CHORE_CARRIER,
  COPY_ROOT,
  GENERATED_GITIGNORE,
  SKILL_FILE,
  STUB_ROOTS,
  copyFolder,
  stubFolder,
  stubText,
  type StubClient,
  type StubSource,
} from './texts';

/** The lines a person should see about one worktree's reconcile; `where` names a worktree other than the process's own. */
export function reconcileNotices(report: ReconcileReport, where: string | null): string[] {
  const at = where ? ` in ${where}` : '';
  return [
    ...report.unplaced.map((entry) => `evolved skill ${entry.skill} reaches agents${at} only through skill_list and skill_read: ${entry.path}: ${entry.why}`),
    ...report.movedAside.map((entry) => `grimoire moved ${entry.path}${at} to ${entry.to}: the grimoire- prefix is reserved for grimoire's skill stubs`),
    ...report.strayEdits.map((entry) => strayEditNotice(entry.skill, where)),
    ...report.left.map((entry) => `grimoire left ${entry.path}${at} alone: ${entry.why}`),
  ];
}

/** A reconcile report as upkeep's part result. */
export function reconcileResult(report: ReconcileReport): { [key: string]: string[] | { [key: string]: string }[] } {
  return {
    wrote: report.wrote,
    removed: report.removed,
    collisions: report.collisions,
    moved_aside: report.movedAside,
    unplaced: report.unplaced,
    stray_edits: report.strayEdits,
    left: report.left,
  };
}
