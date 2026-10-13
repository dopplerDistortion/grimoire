// The runner's trigger (spec §16 The runner): a due chore is started through
// the core as the runner child's context, everything it is served goes into
// the bundle, and the person's own client answers it from a fresh, empty temp
// directory outside any git repo. The answer goes through the same
// `chore_submit` path as an in-session chore's, with exactly one fix-up
// respawn for an answer the checks refuse. Origin `runner`, isolation
// `runner`; the actor is the person plus `runner:claude` or `runner:codex`.
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CallContext, ChoreBrief, ChoreReadResult, ChoreSubmitResult, Core } from '../core';
import { readCheckoutConfig, readPerson } from '../core/host';
import { GrimoireError, type ErrorBody } from '../errors';
import { findGitDirs, MachineLocalStore } from '../machine-local';
import { openTracker, type ChoreKind, type TrackerStore } from '../tracker';
import { dueChores } from '../core/chores';
import { claudeAnswer, codexAnswer, type ChildAnswer } from './answer';
import { composeBundle, gatherServed, PROCEDURE, type Refusal, type Served } from './bundle';
import { capState, checkCaps, countRun, recordRun, RUNS_PER_DAY, type CapState } from './caps';
import { readRunnerConfig, type RunnerConfig, type RunnerKind } from './config';
import { childEnv, preflight, type Preflight } from './guard';
import { claudeArgs, codexArgs, fromStrict, strictSchema } from './invocation';
import { keepRunnerLog, type SpawnLog } from './log';
import { checkBinary, runProcess } from './process';

/** A child is killed after this long (spec §16 Spawn). */
export const SPAWN_TIMEOUT_MS = 15 * 60_000;

export interface RunChoresOptions {
  /** The host repo checkout the chores run for. */
  readonly root: string;
  readonly core: Core;
  /** The environment the child inherits (less what the runner drops). */
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** `chore run --due`: every due chore in turn, while the caps allow. */
  readonly due?: boolean;
  /** `chore run <kind>`: a manual run of that chore (thresholds waived). */
  readonly kind?: ChoreKind;
  /** The kill timeout (default 15 min). */
  readonly timeoutMs?: number;
  /**
   * Stops the runner (`start` stopping): a child under way is killed with its
   * tree at once, its run abandoned (consuming nothing), and runChores throws
   * BUSY once it wound down. The lock is released either way.
   */
  readonly signal?: AbortSignal;
}

/** One run the runner made: an iteration of a spawn and, at most, its fix-up respawn. */
export interface RunnerRun {
  readonly run: string;
  readonly kind: ChoreKind;
  readonly result: 'compiled' | 'proposed' | 'no_action' | 'failed';
  readonly spawns: number;
  /** Grimoire's own summary: counts and ids only. */
  readonly summary: string;
  /** Failed: the reason codes. */
  readonly reasons?: readonly string[];
  /** The auth method the billing guard saw. */
  readonly auth_method: string;
}

export interface ChoreRunReport {
  readonly runner: RunnerKind;
  readonly runs: RunnerRun[];
  /** Nothing ran: why. */
  readonly why?: string;
  readonly summary: string;
  readonly caps: CapState;
}

const NO_RUNNER =
  'no runner is enabled on this machine: ask an agent to run the grimoire-chores skill, or enable one with `grimoire runner enable claude` or `grimoire runner enable codex`';

/** The store of the clone `root` is in. */
export async function storeAt(root: string): Promise<MachineLocalStore> {
  const dirs = await findGitDirs(root);
  if (!dirs) throw new GrimoireError('NO_REPO', `no git repository at ${root}`, { root });
  return new MachineLocalStore(dirs.commonDir, dirs.worktree);
}

/** The call context of the runner child (spec §2.1, §7): the person, client `runner:<kind>`, surface `runner`. */
async function runnerContext(root: string, kind: RunnerKind, env: NodeJS.ProcessEnv): Promise<CallContext> {
  const config = await readCheckoutConfig(root);
  const origin = env.GRIMOIRE_CHORE_ORIGIN?.trim();
  return {
    surface: 'runner',
    repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
    person: await readPerson(root),
    client: { name: `runner:${kind}` },
    evidence: {},
    ...(origin ? { choreOrigin: origin } : {}),
    nonce: randomBytes(8).toString('hex'),
  };
}

/** BUSY when `signal` fired: the runner was stopped. */
function checkStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GrimoireError('BUSY', 'the runner was stopped: a run under way was abandoned, consuming nothing');
}

function thrown(error: ErrorBody): GrimoireError {
  return new GrimoireError(error.code, error.message, error.details);
}

/**
 * Runs due chores with the configured runner: `due` runs each due chore in
 * turn (a compile, then a proposal if one became due) until nothing is due,
 * a run fails or the caps stop it; `kind` runs that one chore manually.
 * Refuses (NOT_DUE) at the daily cap or during the pause, and (INVALID) when
 * no runner is enabled or the billing guard refuses.
 */
export async function runChores(options: RunChoresOptions): Promise<ChoreRunReport> {
  const now = options.now ?? (() => new Date());
  const store = await storeAt(options.root);
  const config = await readRunnerConfig(store);
  if (config === null) throw new GrimoireError('INVALID', NO_RUNNER, { fields: { runner: 'not enabled on this machine' } });
  const acquired = await store.locks.acquire('runner', { waitMs: 0 });
  if (acquired.status === 'held') {
    const why = 'a runner run is already in progress on this machine';
    throw new GrimoireError('NOT_DUE', `no chore to run: ${why}`, { why });
  }
  let tracker: TrackerStore | undefined;
  try {
    tracker = await openTracker(options.root, { clock: now });
    const ctx = await runnerContext(options.root, config.kind, options.env);
    const runs: RunnerRun[] = [];
    let why: string | undefined;
    for (let i = 0; i < RUNS_PER_DAY; i++) {
      checkStopped(options.signal);
      if (runs.length > 0) {
        // Catch-up stops quietly at the caps; only a first run is refused by them.
        const caps = await capState(store, now());
        if (caps.paused_until !== null || caps.next_run_at !== null) break;
      }
      const outcome = await oneRun(config, ctx, store, tracker, options, now);
      if ('why' in outcome) {
        why = outcome.why;
        break;
      }
      runs.push(outcome);
      if (outcome.result === 'failed' || !options.due) break;
    }
    const caps = await capState(store, now());
    const summary =
      runs.length === 0
        ? `grimoire runner: nothing ran (${why ?? 'nothing due'})`
        : runs.map((run) => run.summary).join('\n');
    return { runner: config.kind, runs, ...(runs.length === 0 && why !== undefined ? { why } : {}), summary, caps };
  } finally {
    // The lock goes whatever failed after it was taken, so a long-lived process can trigger again.
    try {
      await tracker?.close();
    } finally {
      await acquired.lock.release();
    }
  }
}

/** One iteration: the caps, the billing guard, the start, the spawn and its fix-up. `{why}` when nothing was due. */
async function oneRun(
  config: RunnerConfig,
  ctx: CallContext,
  store: MachineLocalStore,
  tracker: TrackerStore,
  options: RunChoresOptions,
  now: () => Date,
): Promise<RunnerRun | { why: string }> {
  if (options.due) {
    // Nothing due starts nothing: not even the billing guard's client call.
    const due = await dueChores(tracker, ctx);
    if (due.next === null) {
      return { why: due.paused ? 'the knowledge loop is paused' : `Wiki Maintainer: ${due['wiki-maintainer'].why}; Skill Proposer: ${due['skill-proposer'].why}` };
    }
  }
  await checkCaps(store, now());
  await checkBinary(config.binary);
  const work = await workDir();
  try {
    const env = childEnv(config.kind, options.env);
    const checked = await preflight(config, work.cwd, env, options.signal).catch((error: unknown) => {
      // A preflight call killed by the stop isn't a refusal.
      checkStopped(options.signal);
      throw error;
    });
    checkStopped(options.signal);
    const started = await options.core.call('chore_start', options.kind !== undefined ? { kind: options.kind, manual: true } : {}, ctx);
    if (!started.ok) {
      // Due mode: nothing due is no failure, just nothing to do.
      if (started.error.code === 'NOT_DUE' && options.due) return { why: String(started.error.details.why ?? started.error.message) };
      throw thrown(started.error);
    }
    const brief = started.result;
    await countRun(store, now());
    return await iterate(config, ctx, store, tracker, options, now, brief, env, checked, work);
  } finally {
    await rm(work.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

interface WorkDir {
  /** Holds the procedure, the schema and the answer file, beside the cwd. */
  readonly root: string;
  /** The child's cwd: fresh and empty for every spawn. */
  readonly cwd: string;
}

/** A fresh temp directory outside any git repo. */
async function workDir(): Promise<WorkDir> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grimoire-runner-'));
  if ((await findGitDirs(root)) !== null) {
    await rm(root, { recursive: true, force: true });
    throw new GrimoireError('INVALID', `the runner's temp directory ${root} is inside a git repository; point TMPDIR (TEMP on Windows) outside any repository`, {
      fields: { temp: 'inside a git repository' },
    });
  }
  const cwd = path.join(root, 'cwd');
  await mkdir(cwd);
  return { root, cwd };
}

/** A fresh, empty cwd for the next spawn. */
async function freshCwd(work: WorkDir): Promise<void> {
  if ((await readdir(work.cwd).catch(() => null))?.length === 0) return;
  await rm(work.cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(work.cwd);
}

async function iterate(
  config: RunnerConfig,
  ctx: CallContext,
  store: MachineLocalStore,
  tracker: TrackerStore,
  options: RunChoresOptions,
  now: () => Date,
  brief: ChoreBrief,
  env: NodeJS.ProcessEnv,
  checked: Preflight,
  work: WorkDir,
): Promise<RunnerRun> {
  const { core } = options;
  const spawns: SpawnLog[] = [];
  let secretRefused = false;
  const finish = async (run: Omit<RunnerRun, 'run' | 'kind' | 'auth_method'>): Promise<RunnerRun> => {
    const done: RunnerRun = { run: brief.run, kind: brief.kind, auth_method: checked.auth_method, ...run };
    const succeeded = run.result !== 'failed';
    await recordRun(store, now(), { at: now().toISOString(), run: brief.run, kind: brief.kind, result: run.result, auth_method: checked.auth_method, ...(run.reasons ? { reason: run.reasons.join(', ') } : {}) }, succeeded);
    await keepRunnerLog(store, { run: brief.run, kind: brief.kind, runner: config.kind, at: now().toISOString(), result: run.result, spawns, secretRefused }).catch(() => undefined);
    return done;
  };
  const abandon = async (reason: string, spawned: number): Promise<RunnerRun> => {
    const abandoned = await core.call('chore_abandon', { run: brief.run, reason: `runner: ${reason}` }, ctx);
    const summary = `grimoire runner: ${brief.kind} run ${brief.run} failed (${reason}); nothing consumed`;
    if (!abandoned.ok && abandoned.error.code !== 'NOT_FOUND') throw thrown(abandoned.error);
    return finish({ result: 'failed', spawns: spawned, summary, reasons: [reason] });
  };
  try {
    const read = async (input: { item?: string; cursor?: string }): Promise<ChoreReadResult | null> => {
      const page = await core.call('chore_read', { run: brief.run, ...input }, ctx);
      if (page.ok) return page.result;
      if (page.error.code === 'NOT_FOUND' && input.item !== undefined) return null;
      throw thrown(page.error);
    };
    const served = await gatherServed(read, await pageItems(tracker));
    let refusal: Refusal | null = null;
    for (let spawn = 1; spawn <= 2; spawn++) {
      await freshCwd(work);
      const answer = await spawnChild(config, brief, served, refusal, env, checked, work, options.timeoutMs ?? SPAWN_TIMEOUT_MS, spawns, options.signal);
      // Stopped mid-spawn: the child is gone; the catch below abandons the run.
      checkStopped(options.signal);
      if (!answer.ok) return await abandon(answer.reason, spawn);
      const submitted = await core.call('chore_submit', { run: brief.run, result: answer.answer }, ctx);
      if (!submitted.ok) throw thrown(submitted.error);
      const result: ChoreSubmitResult = submitted.result;
      if (result.reasons?.some((reason) => reason === 'secret' || reason === 'unscanned')) secretRefused = true;
      if (result.result === 'invalid') {
        refusal = { reasons: result.reasons ?? [], ...(result.problems ? { problems: result.problems } : {}) };
        continue;
      }
      return await finish({
        result: result.result,
        spawns: spawn,
        summary: result.summary,
        ...(result.result === 'failed' ? { reasons: result.reasons ?? [] } : {}),
      });
    }
    // chore_submit ends a run at its second refusal: never reached.
    return await abandon('refused_twice', 2);
  } catch (error) {
    // Something broke mid-run: the run consumes nothing, and counts as a failure.
    await core.call('chore_abandon', { run: brief.run, reason: 'runner: interrupted' }, ctx).catch(() => undefined);
    await recordRun(store, now(), { at: now().toISOString(), run: brief.run, kind: brief.kind, result: 'error', reason: error instanceof GrimoireError ? error.code : 'error' }, false).catch(() => undefined);
    throw error;
  }
}

/** The wiki's pages, as items a Wiki Maintainer or Skill Proposer may be served on request. */
async function pageItems(tracker: TrackerStore): Promise<string[]> {
  return (await (await tracker.read()).wiki.pages()).map((page) => `page:${page.slug}`);
}

/** One spawn of the person's client: the bundle on stdin, the answer read by the client's failure rule. */
async function spawnChild(
  config: RunnerConfig,
  brief: ChoreBrief,
  served: Served,
  refusal: Refusal | null,
  env: NodeJS.ProcessEnv,
  checked: Preflight,
  work: WorkDir,
  timeoutMs: number,
  spawns: SpawnLog[],
  signal: AbortSignal | undefined,
): Promise<ChildAnswer> {
  const bundle = composeBundle(config.kind, brief, served, refusal);
  if (config.kind === 'claude') {
    const procedure = path.join(work.root, 'procedure.md');
    await writeFile(procedure, PROCEDURE);
    const args = claudeArgs(config, brief.output_schema, procedure);
    const run = await runProcess(config.binary, args, { cwd: work.cwd, env, input: bundle, timeoutMs, signal });
    const answer = claudeAnswer(run);
    spawns.push({ code: run.code, timed_out: run.timedOut, stdout: run.stdout, stderr: run.stderr, failure: answer.ok ? null : answer.reason });
    return answer;
  }
  const schema = path.join(work.root, 'schema.json');
  const out = path.join(work.root, 'answer.json');
  await rm(out, { force: true });
  await writeFile(schema, JSON.stringify(strictSchema(brief.output_schema)));
  const args = codexArgs(config, { cwd: work.cwd, schema, out }, checked.mcp_servers ?? []);
  const run = await runProcess(config.binary, args, { cwd: work.cwd, env, input: bundle, timeoutMs, signal });
  const text = await readFile(out, 'utf8').catch(() => undefined);
  const answer = codexAnswer(run, text);
  spawns.push({ code: run.code, timed_out: run.timedOut, stdout: run.stdout, stderr: run.stderr, failure: answer.ok ? null : answer.reason });
  return answer.ok ? { ok: true, answer: fromStrict(answer.answer, brief.output_schema) as Record<string, unknown> } : answer;
}
