// The runner's trigger in `start` (spec §16 The runner, Triggers): while a
// runner is configured on this machine, `start` re-evaluates due-ness once at
// launch, whenever the tracker's tips move with a trace write, an outcome
// change or a decision (read from the `Grimoire-Op` trailers of the commits
// between the old and the new tips), and every 30 minutes. Each evaluation is
// a `chore run --due`: it drains a backlog within the caps (runChores stops at
// them). Evaluations never overlap: a trigger during one queues exactly one
// more. Nothing here looks at the pin, so the trigger keeps going through a
// pin mismatch for as long as the store's markers can be read (a run against
// an unreadable store fails with UPGRADE_REQUIRED and is reported).
import { runGit } from '../git/run';
import { GrimoireError } from '../errors';
import { commitTrailers, type TrackerTips } from '../tracker';
import type { ChoreRunReport } from './run';

/** The timer's period (spec §16: a 30-min timer). */
export const TRIGGER_EVERY_MS = 30 * 60_000;
/** How often the tips are checked for a move. */
export const TRIGGER_CHECK_MS = 2_000;
/** More commits than this between two checks: evaluate without reading them all. */
const LARGE_JUMP = 500;

/**
 * The ops whose commits may make a chore due: the trace writes (every op that
 * ends an attempt, and a sweep's capture), an outcome change, and the
 * decisions on a proposal.
 */
export const TRIGGER_OPS: ReadonlySet<string> = new Set([
  'close',
  'release',
  'reassign',
  'capture',
  'outcome-set',
  'accept',
  'reject',
  'dismiss',
  'reconsider',
]);

export interface RunnerTriggerOptions {
  /** The checkout `start` runs from: git runs here. */
  readonly root: string;
  /** The tracker's tip pair, resolved fresh. */
  readonly tips: () => Promise<TrackerTips>;
  /** Whether a runner is configured on this machine now. */
  readonly configured: () => Promise<boolean>;
  /** One evaluation: `runChores({…, due: true})`. */
  readonly run: () => Promise<ChoreRunReport>;
  /** What to tell the person (start's stderr). */
  readonly log?: (line: string) => void;
  readonly everyMs?: number;
  readonly checkMs?: number;
}

export interface RunnerTrigger {
  /** Evaluates now (or once more after the evaluation under way). */
  poke(): void;
  /** Stops the timers; waits up to `waitMs` for an evaluation under way. */
  stop(waitMs?: number): Promise<void>;
}

/** Whether the commits from the `from` tips to the `to` tips hold a trigger op; true when they can't be read. */
async function triggeredBetween(root: string, from: TrackerTips, to: TrackerTips): Promise<boolean> {
  const fresh = [...new Set([to.local, to.remote].filter((tip): tip is string => tip !== null))];
  const old = [...new Set([from.local, from.remote].filter((tip): tip is string => tip !== null))];
  if (fresh.length === 0) return false;
  const log = await runGit(root, ['log', '--no-color', `--max-count=${LARGE_JUMP + 1}`, '--format=%x1e%B', ...fresh, ...(old.length > 0 ? ['--not', ...old] : []), '--']);
  if (log.code !== 0) return true;
  const messages = log.stdout.toString('utf8').split('\x1e').slice(1);
  if (messages.length > LARGE_JUMP) return true;
  return messages.some((message) => TRIGGER_OPS.has(commitTrailers(message).get('Grimoire-Op') ?? ''));
}

const sameTips = (x: TrackerTips, y: TrackerTips) => x.local === y.local && x.remote === y.remote;

export function startRunnerTrigger(options: RunnerTriggerOptions): RunnerTrigger {
  const log = options.log ?? (() => {});
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let lastSaid: string | null = null;
  const say = (line: string) => {
    // A refusal that repeats on every trigger (the daily cap, the pause) is said once.
    if (line === lastSaid) return;
    lastSaid = line;
    log(line);
  };

  const evaluateOnce = async () => {
    if (!(await options.configured().catch(() => false))) return;
    try {
      const report = await options.run();
      if (report.runs.length > 0) {
        lastSaid = null;
        log(report.summary);
      }
    } catch (error) {
      say(`grimoire runner: ${error instanceof GrimoireError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)}`);
    }
  };

  const poke = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await evaluateOnce();
      } while (again && !stopped);
    })().finally(() => (running = null));
  };

  let last: TrackerTips | null = null;
  let checking = false;
  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const next = await options.tips();
      const previous = last;
      last = next;
      if (previous === null || sameTips(previous, next)) return;
      if (!(await options.configured().catch(() => false))) return;
      if (await triggeredBetween(options.root, previous, next)) poke();
    } catch {
      // A tip read that failed (a ref mid-update): the next check tries again.
    } finally {
      checking = false;
    }
  };

  const checkTimer = setInterval(() => void check(), options.checkMs ?? TRIGGER_CHECK_MS);
  checkTimer.unref();
  const everyTimer = setInterval(poke, options.everyMs ?? TRIGGER_EVERY_MS);
  everyTimer.unref();
  // The launch evaluation, once the tips it starts from are known.
  void check().finally(poke);

  return {
    poke,
    async stop(waitMs = 2_000) {
      stopped = true;
      clearInterval(checkTimer);
      clearInterval(everyTimer);
      const current = running;
      if (current) await Promise.race([current, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
    },
  };
}
