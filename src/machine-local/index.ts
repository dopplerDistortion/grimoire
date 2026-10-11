// The machine-local store (spec §2 module 3, §6): `<git-common-dir>/grimoire/`.
export {
  MachineLocalStore,
  locateMachineLocalStore,
  type LocateOptions,
  type MachineLocalStoreOptions,
} from './store';
export { findGitDirs, type GitDirs, type FindGitDirsOptions } from './git-dirs';
export { DocStore, type DocEntry, type Json } from './docs';
export type { Holder } from './slots';
export { Lease, Leases, type LeaseOptions, type LeaseResult, type LeaseState } from './leases';
export {
  Lock,
  Locks,
  LockHeldError,
  type LockOptions,
  type LockResult,
  type LockState,
} from './locks';
export {
  ProcessRecords,
  type ProcessRecord,
  type ProcessInfo,
  type ProcessFilter,
  type ProcessRegistration,
} from './processes';
export {
  MachineMarkerFile,
  MachineUpgradeRequiredError,
  MACHINE_FORMAT_RANGE,
  V1_MACHINE_MARKER,
  type MachineMarker,
} from './marker';
export { Caches, type CacheOptions } from './caches';
