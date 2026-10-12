// The installer (spec §2 module 9, §11, §12): the frozen bootstrap and client
// entries, the launcher, the version copies, the join records and the shell
// shim; and `init` with what it writes in a checkout: config.yml, the
// manifest and the pointer files. `uninstall` and `leave` build on these.
export {
  BOOTSTRAP,
  MCP_ENTRY_ARGS,
  claudeHookArgs,
  codexHookCommand,
  joinCommand,
  notSetUpLine,
  type HookEvent,
} from './bootstrap';
export {
  LAUNCHER_VERSION,
  inspectLauncher,
  installLauncher,
  launcherPath,
  launcherText,
  type LauncherInstall,
  type LauncherState,
} from './launcher';
export {
  COMPLETE_MARKER,
  COPY_ENTRY,
  PACKAGE_NAME,
  copyDir,
  installCopy,
  listCopies,
  pruneCopies,
  tarballIntegrity,
  type CopyInstall,
  type CopySource,
  type InstalledCopy,
  type KeepReason,
  type PruneOptions,
  type PruneResult,
} from './copies';
export { INSTALL_LOCK, withInstallLock } from './lock';
export {
  JOIN_RECORDS,
  UPGRADE_RECORDS,
  readJoinRecord,
  writeJoinRecord,
  type JoinRecord,
  type UpgradeRecord,
} from './records';
export { compareSemver, isStrictSemver } from './semver';
export { SHIM_PATH, shimText } from './shim';
export { registeredWorktrees, worktreePins, type ClonePins, type Registry, type WorktreePin } from './worktrees';
export { CONFIG_PATH, INSTALL_FORMAT, readInstallConfig, serializeInstallConfig, type AdapterDecision, type CheckoutInstall, type InstallConfig } from './config';
export { ENTRY_KINDS, MANIFEST_PATH, readManifest, type ClientName, type EntryKind, type Manifest, type ManifestEntry } from './manifest';
export { CODEX_ENV_VARS, codexHookHash, desiredEntries, isContentEntry, type DesiredEntry, type PointerOptions } from './pointers';
export { applyFiles, planFiles, type EntryAction, type FilePlan, type PlannedEntry } from './writer';
export { existingAdapterPlacement, planContentRefresh, refreshContentPointers, type ContentPlan, type ContentRefresh, type ContentSkip } from './refresh';
export { disclosureLines } from '../core/settings';
export { runInit, type InitFlags, type InitOptions, type InitReport, type Prompter, type UpgradeReport, type UpgradeStep } from './init';
export { RELEASE_FORMATS, claimUpgradeRecord, finishUpgradeRecord, pathsToCommit, planMarker, readStoreMarker, releaseUpgradeRecord, type FormatRange, type MarkerPlan, type MarkerVerdict, type ReleaseFormats } from './upgrade';
export { runningPackage } from './source';
