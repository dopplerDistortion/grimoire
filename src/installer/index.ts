// The installer's runtime half (spec §2 module 9, §11): the frozen bootstrap
// and client entries, the launcher, the version copies, the join records and
// the shell shim. `init`, `uninstall` and `leave` build on these.
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
export { registeredWorktrees, worktreePins, type WorktreePin } from './worktrees';
