// The tracker store (spec §2.2): the tracker ref and its record formats, ids,
// compare-and-set writes, the read view and the version marker.
export {
  openTracker,
  DEFAULT_BUDGET_MS,
  STALE_REF_LOCK_MS,
  type TrackerStore,
  type TrackerOptions,
  type WriteSpec,
  type WriteOutcome,
  type WriteResult,
  type Person,
} from './store';
export type { TrackerView, TrackerDraft } from './view';
export type { IssueRecord, IssueLink } from './record';
export { issueRevision, sortedUnique } from './record';
export type { Idempotency } from './keys';
export { parseWriteRef, ID_PATTERN } from './ids';
export { TRACKER_REF } from './layout';
export { TRACKER_FORMAT_RANGE, V1_MARKER } from './marker';
