// The test harness. Import it as '#harness' (see README → Contributing).
export { runCommand, type RunOptions, type RunResult } from './process';
export { makeTempDir, removeDir } from './temp';
export {
  git,
  gitResult,
  gitEnv,
  isolateGitEnvironment,
  GitError,
  HARNESS_GIT_CONFIG,
  type GitOptions,
} from './git';
export {
  createGitWorld,
  type WorldTemplate,
  ALICE,
  BOB,
  type GitWorld,
  type Clone,
  type Checkout,
  type GitIdentity,
} from './git-world';
export { gitTest } from './vitest';
export {
  FIXTURES_DIR,
  fixturePath,
  readFixture,
  readFixtureBytes,
  readFixtureJson,
} from './fixtures';
export { makeUnlistable, makeUnwritable, permissionsApply } from './permissions';
export { trackPidFile } from './children';
export { fakeExecutable } from './fake-exe';
