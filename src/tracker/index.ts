// The tracker store (spec §2.2): the tracker ref and its record formats, ids,
// compare-and-set writes, the read view and the version marker.
export {
  openTracker,
  DEFAULT_BUDGET_MS,
  STALE_REF_LOCK_MS,
  type TrackerStore,
  type TrackerTips,
  type TrackerOptions,
  type WriteSpec,
  type WriteOutcome,
  type WriteResult,
  type InitializeOptions,
  type UnpushedDrop,
  type Person,
  TRACKER_ROOT_KEY,
  namedTrackerRoot,
} from './store';
export type { NetworkGit, SyncOutcome, SyncSpec, SyncFailure, TextPolicy } from './sync';
export { stripUserinfo, type SyncFailureClass } from './remote';
export type { TrackerView, TrackerDraft, NewComment, NewAttempt, NewEnd, NewOutcome, NewPurge } from './view';
export { parsePurge, serializePurge, type PurgeIndex, type PurgeTombstone, type PurgedFacts } from './purge';
export type { IssueComment, CommentEntry } from './comment';
export type { IssueRecord, IssueLink } from './record';
export type {
  ActivityDetail,
  ActivityEntry,
  AttemptEnd,
  AttemptEnding,
  AttemptOpening,
  AttemptOutcome,
  AttemptRecord,
  AttemptStart,
  DeliveryState,
  OfferedSkill,
  Verdict,
} from './attempt';
export { ATTEMPT_PATTERN } from './attempt';
export { issueRevision, sortedUnique } from './record';
export { keyHash, type Idempotency } from './keys';
export { bareId, collisionSides, parseWriteRef, ID_PATTERN } from './ids';
export type { StoreSetting } from './settings';
export type { Tombstone } from './retired';
export { TRACKER_REF } from './layout';
export { CAPTURE_STATS, LATE_CUT_DROPS, type LateCutDrops } from './capture-stats';
export { TRACKER_FORMAT_RANGE, V1_MARKER } from './marker';
export {
  pageVersion,
  renderWikiIndex,
  wikiPageFile,
  type NewWikiEdit,
  type PageKind,
  type WikiConflict,
  type WikiDraft,
  type WikiEdit,
  type WikiPage,
  type WikiPageEntry,
  type WikiView,
} from './wiki';
export type { NewQuarantineRecord, QuarantineDraft, QuarantineRecord, QuarantineView } from './quarantine';
export {
  aheadBehind,
  checkHistory,
  directoryFileConflicts,
  inspectTrees,
  removeStaleRefLocks,
  staleRefLocks,
  trackerTips,
  type RecordFormats,
  type RecordProblem,
  type RefLock,
  type StoreFinding,
  type StoreSeverity,
  type TrackerRefTips,
  type TreeInspection,
} from './check';
export { commitTrailers, isKnownOp, opEffect, type OpEffect } from './ops';
export {
  CHORE_KINDS,
  randomRunId,
  RUN_PATTERN,
  type ChoreKind,
  type ChoreResult,
  type ChoreRunDraft,
  type ChoreRunRecord,
  type ChoreRunView,
  type ConsumedPair,
  type NewChoreRun,
  type ServedRef,
} from './chore-runs';
export {
  parseProposal,
  PROPOSAL_PATTERN,
  PROPOSALS_DIR,
  proposalFile,
  randomProposalId,
  serializeProposal,
  type CitedItem,
  type CitedTrace,
  type NewProposal,
  type ProposalClaims,
  type ProposalDraft,
  type ProposalOp,
  type ProposalRecord,
  type ProposalView,
  type RiskFlag,
  type TokenOrigin,
} from './proposals';
