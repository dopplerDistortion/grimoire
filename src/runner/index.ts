// The runner (spec §2 module 8, §16 The runner): a per-machine opt-in that
// starts the person's own `claude -p` or `codex exec` to do due chores
// unattended, on their own login. It owns enable and disable, the billing
// guard, spawning, the caps and backoff, and the trigger.
export { RUNNER_KINDS, isRunnerKind, readRunnerConfig, type RunnerConfig, type RunnerKind } from './config';
export { capState, RUNS_PER_DAY, PAUSE_MS, FAILURES_BEFORE_PAUSE, type CapState, type LastRun } from './caps';
export { disableRunner, enableRunner, enableWarnings, findBinary, type EnableOptions, type EnableResult } from './enable';
export { runChores, SPAWN_TIMEOUT_MS, type ChoreRunReport, type RunChoresOptions, type RunnerRun } from './run';
export { runnerStatus } from './status';
export { readRunnerLogs, type RunnerLog } from './log';
export { BUNDLE_HEADER, PROCEDURE } from './bundle';
