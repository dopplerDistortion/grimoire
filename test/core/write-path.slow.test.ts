// The write path against the clock and against gits that die or stop
// answering (spec §4, Write path; ADR 0007). A write's long-lived gits must
// never act on a stale view of the refs, must not outlive their store or break
// the write when they die, and a hung git must be killed and must never hold a
// write (or the fairness lock) forever. These tests stall, kill and time real
// processes, so they run in the serial `slow` project (npm run test:slow), with
// the machine to themselves; write-path.test.ts holds the critical section's
// performance guards. They find the long-lived gits through a pass-through spy
// on node:child_process, and put a git that stops answering in place of one.
//
// They run against the clock, and a loaded machine starts and kills processes
// many times slower than an idle one. So every stall, budget and wait is
// scaled by how slow the machine is right now (`paced`), and readiness is an
// event (a write asking for the fairness lock), never a quiet spell.
import * as childProcess from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, vi } from 'vitest';
import { trackPidFile, type Checkout } from '#harness';
import { ObjectReader } from '../../src/git/batch';
import { packedRefsStamp, RefUpdater } from '../../src/git/refs';
import { MachineLocalStore } from '../../src/machine-local';
import { isPidAlive, processStartTimes } from '../../src/machine-local/process-info';
import { DEFAULT_BUDGET_MS, openTracker, type WriteSpec } from '../../src/tracker';
import { trackerTip, TRACKER_REF } from './support';
import { forgetStarts, nextTurnAtTheLock, started, test } from './write-path-support';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

/** A file the stand-ins write their processes to (see `ranIn`): the leak guard fails the test if one still runs at its end. */
function pidFileIn(dir: string, name: string): string {
  const file = path.join(dir, name);
  trackPidFile(file);
  return file;
}

describe('the write path', { timeout: 180_000 }, () => {
  test('a write builds on a tip another writer moved, even when packed-refs was rewritten within the same second', async ({
    world,
    grimoire,
    paced,
  }) => {
    // A long-lived git caches packed-refs and trusts its stat, which can miss a
    // same-size rewrite inside one timestamp tick: the write would build on a
    // stale tip and lose every compare-and-set until BUSY. Each round leaves the
    // tick only a few git commands to pass in, so most rounds stay inside it.
    const core = grimoire.makeCore({ writeBudgetMs: paced(3_000) });
    expect(await core.call('create', { title: 'First' }, grimoire.ctx)).toMatchObject({ ok: true });
    for (let round = 0; round < 3; round++) {
      await world.a.git(['pack-refs', '--all']);
      // The tip is only in packed-refs now: the core reads it there, then moves the ref.
      expect(await core.call('create', { title: `Mine ${round}` }, grimoire.ctx)).toMatchObject({ ok: true });
      const mine = (await trackerTip(world.a))!;
      const theirs = await world.a.git(['commit-tree', `${mine}^{tree}`, '-p', mine, '-m', 'another writer']);
      await world.a.git(['update-ref', TRACKER_REF, theirs, mine]);
      await world.a.git(['pack-refs', '--all']);

      const after = await core.call('create', { title: `After theirs ${round}` }, grimoire.ctx);

      expect(after).toMatchObject({ ok: true });
      expect(await world.a.git(['rev-parse', `${(await trackerTip(world.a))!}^`])).toBe(theirs);
    }
  });
});

/** Resolves just after the wall clock enters a new second. */
async function startOfSecond(): Promise<void> {
  await setTimeout(1_000 - (Date.now() % 1_000) + 10);
}

/** The last `git <command>` process started, while it still runs. */
function runningGit(command: RegExp): childProcess.ChildProcess {
  const spawned = vi.mocked(childProcess.spawn).mock;
  const index = spawned.calls.findLastIndex(([name, args]) => name === 'git' && command.test(args.join(' ')));
  const result = spawned.results[index];
  if (result?.type !== 'return' || result.value.exitCode !== null || result.value.signalCode !== null) {
    throw new Error(`no running git matches ${command}`);
  }
  return result.value;
}

/**
 * A ref updater over clone a, and a way to run a step right after its next
 * look at packed-refs: before the update's transaction reaches git, or, once
 * git holds the ref's lock, before the update decides to commit.
 */
function updaterOver(checkout: Checkout): { updater: RefUpdater; afterNextLook(step: () => unknown): void } {
  const commonDir = path.join(checkout.dir, '.git');
  let interleave: (() => unknown) | null = null;
  const updater = new RefUpdater({ root: checkout.dir, commonDir }, 'grimoire: test', {
    packedRefs: async () => {
      const stamp = await packedRefsStamp(commonDir);
      const step = interleave;
      interleave = null;
      await step?.();
      return stamp;
    },
  });
  return { updater, afterNextLook: (step) => void (interleave = step) };
}

describe('the ref updater', { timeout: 180_000 }, () => {
  // The compare-and-set that publishes a write. Its git is long-lived, and a
  // long-lived git trusts its cached packed-refs while the file's stat looks
  // unchanged to it: on Windows, while the file keeps its size within one
  // second. Each round packs the ref, moves it, and has another writer move it
  // on and pack it again within that second, then offers the old value the
  // first move started from.
  test.for([
    ['before', false],
    ['right after', true],
  ] as const)(
    'a compare-and-set refuses a stale old value when packed-refs was rewritten %s the update looked at it',
    async ([, afterLooking], { world, grimoire }) => {
      void grimoire; // initializes the tracker
      const { updater, afterNextLook } = updaterOver(world.a);
      try {
        for (let round = 0; round < 3; round++) {
          const start = (await trackerTip(world.a))!;
          const tree = `${start}^{tree}`;
          const mine = await world.a.git(['commit-tree', tree, '-p', start, '-m', `mine ${round}`]);
          const theirs = await world.a.git(['commit-tree', tree, '-p', mine, '-m', `theirs ${round}`]);
          const stale = await world.a.git(['commit-tree', tree, '-p', start, '-m', `stale ${round}`]);
          const anotherWriter = async () => {
            await world.a.git(['update-ref', TRACKER_REF, theirs, mine]);
            await world.a.git(['pack-refs', '--all']);
          };
          await startOfSecond();
          await world.a.git(['pack-refs', '--all']);
          expect(await updater.update(TRACKER_REF, mine, start)).toEqual({ moved: true });
          if (afterLooking) afterNextLook(anotherWriter);
          else await anotherWriter();

          const update = await updater.update(TRACKER_REF, stale, start);

          expect(update.moved).toBe(false);
          expect(await trackerTip(world.a)).toBe(theirs);
        }
      } finally {
        await updater.close();
      }
    },
  );

  test('an update whose git died unnoticed while idle moves the ref on a new git', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    const { updater, afterNextLook } = updaterOver(world.a);
    try {
      const start = (await trackerTip(world.a))!;
      const first = await world.a.git(['commit-tree', `${start}^{tree}`, '-p', start, '-m', 'first']);
      const second = await world.a.git(['commit-tree', `${start}^{tree}`, '-p', first, '-m', 'second']);
      expect(await updater.update(TRACKER_REF, first, start)).toEqual({ moved: true });
      // Killed just before the update writes to it: its exit isn't seen yet.
      afterNextLook(() => runningGit(/update-ref --stdin/).kill());

      expect(await updater.update(TRACKER_REF, second, first)).toEqual({ moved: true });
      expect(await trackerTip(world.a)).toBe(second);
    } finally {
      await updater.close();
    }
  });

  test('an update whose git died holding the ref lock moves the ref on a new git: the lock went with the old one', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    const { updater, afterNextLook } = updaterOver(world.a);
    const lock = path.join(world.a.dir, '.git', `${TRACKER_REF}.lock`);
    try {
      const start = (await trackerTip(world.a))!;
      const next = await world.a.git(['commit-tree', `${start}^{tree}`, '-p', start, '-m', 'next']);
      expect(await updater.update(TRACKER_REF, start, start)).toEqual({ moved: true });
      // The next look is the update's own; the one after is once git has prepared: kill it then, with no chance to clean up.
      afterNextLook(() =>
        afterNextLook(async () => {
          const git = runningGit(/update-ref --stdin/);
          const exited = new Promise((resolve) => git.once('close', resolve));
          git.kill('SIGKILL');
          await exited;
        }),
      );

      const update = await updater.update(TRACKER_REF, next, start);

      expect(update).toEqual({ moved: true });
      expect(await trackerTip(world.a)).toBe(next);
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await updater.close();
      await rm(lock, { force: true });
    }
  });
});

/** The `git …` lines of the processes started since `from` spawns that still run. */
function runningGits(from: number): string[] {
  const spawned = vi.mocked(childProcess.spawn).mock;
  return spawned.calls.slice(from).flatMap(([name, args], i) => {
    const result = spawned.results[from + i];
    const running = result?.type === 'return' && result.value.exitCode === null && result.value.signalCode === null;
    return name === 'git' && running ? [`git ${args.join(' ')}`] : [];
  });
}

/** A store write that commits only its idempotency key: `key` must be new. */
function keyWrite(key: string): WriteSpec {
  return {
    op: 'test',
    author: { name: 'A', email: 'a@example.com' },
    actor: { kind: 'human', nonce: 'n' },
    idempotency: { key, fingerprint: key },
  };
}

describe('the store after close', { timeout: 180_000 }, () => {
  test('a write in flight when the store closed, and a read after it, leave no git running', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const from = vi.mocked(childProcess.spawn).mock.calls.length;
    const store = await openTracker(world.a.dir);
    expect(await store.transact(keyWrite('warm-up'), () => ({ result: null }))).toMatchObject({ replayed: false });
    let arrived!: () => void;
    let release!: () => void;
    const inBody = new Promise<void>((resolve) => (arrived = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = store.transact(keyWrite('in flight'), async () => {
      arrived();
      await gate;
      return { result: null };
    });
    await inBody;

    await store.close();
    release();

    expect((await write).commit).toBe(await trackerTip(world.a));
    await store.read();
    await vi.waitFor(() => expect(runningGits(from)).toEqual([]), { timeout: paced(5_000) });
  });
});

describe('the store after its long-lived gits died', { timeout: 180_000 }, () => {
  test.for([
    ['the ref updater', /update-ref --stdin/],
    ['the object reader', /cat-file --batch/],
  ] as const)('a write lands exactly once after %s died between writes', async ([, command], { world, grimoire }) => {
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });
    const tip = (await trackerTip(world.a))!;

    runningGit(command).kill();
    const write = await grimoire.core.call('create', { title: 'After' }, grimoire.ctx);

    expect(write).toMatchObject({ ok: true });
    expect(await world.a.git(['rev-list', '--count', `${tip}..${TRACKER_REF}`])).toBe('1');
  });

  test('a read right after the object reader died, before its exit is seen, answers through a new one', async ({
    world,
    grimoire,
  }) => {
    void grimoire; // initializes the tracker
    const store = await openTracker(world.a.dir);
    try {
      const before = await store.read();
      runningGit(/cat-file --batch/).kill();

      const after = await store.read();

      expect(after.tip).toBe(before.tip);
    } finally {
      await store.close();
    }
  });
});

const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;

// The stand-ins below run as `node -e <script> -- <own args> ::git <git's args>`.
const ARGS = `
const at = process.argv.indexOf('::git');
const own = process.argv.slice(1, at);
const gitArgs = process.argv.slice(at + 1);
`;

/**
 * A git that never answers: it starts a child of its own, as git for
 * Windows' launcher does, appends both to the file it is given (see
 * `ranIn`), and both sleep.
 */
const WEDGED_GIT = `${ARGS}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true });
appendFileSync(own[0], process.pid + ' ' + Date.now() + '\\n' + child.pid + ' ' + Date.now() + '\\n');
setInterval(() => {}, 1 << 30);
`;

/** A real git behind a relay, which never exits on its own; the scripts that extend it decide what it passes on. */
const RELAY = `${ARGS}
const { spawn, spawnSync } = require('node:child_process');
const git = spawn('git', gitArgs, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
git.stdin.on('error', () => {});
/** Kills git with no chance to clean up after itself: SIGKILL, or TerminateProcess on its whole tree on Windows. */
const killGit = () =>
  process.platform === 'win32'
    ? spawnSync('taskkill', ['/pid', String(git.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    : git.kill('SIGKILL');
const lines = (stream, onLine) => {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    for (let end = rest.indexOf('\\n'); end >= 0; end = rest.indexOf('\\n')) {
      onLine(rest.slice(0, end + 1));
      rest = rest.slice(end + 1);
    }
  });
};
setInterval(() => {}, 1 << 30);
`;

/** An updater whose answers stop once it is told to commit (git itself goes on and commits). */
const SILENT_AFTER_COMMIT = `${RELAY}
let told = false;
lines(process.stdin, (line) => {
  if (line.trim() === 'commit') told = true;
  git.stdin.write(line);
});
git.stdout.on('data', (chunk) => {
  if (!told) process.stdout.write(chunk);
});
`;

/**
 * SILENT_AFTER_COMMIT, and a process that is no one's child (its parent
 * exited) holds the relay's stdout open, so killing the relay's tree never
 * closes it: its pid goes to the file given.
 */
const KEEPER = `
const { spawn } = require('node:child_process');
const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true, windowsHide: true });
require('node:fs').appendFileSync(process.argv[1], keeper.pid + ' ' + Date.now() + '\\n');
keeper.unref();
`;
const UNKILLABLE_AFTER_COMMIT = `${SILENT_AFTER_COMMIT}
spawn(process.execPath, ['-e', ${JSON.stringify(KEEPER)}, own[0]], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });
`;

/** WEDGED_GIT, and its exit is never seen: a keeper holds its stdout open (all pids go to the file given). */
const WEDGED_SLOW_TO_EXIT = `${WEDGED_GIT}
spawn(process.execPath, ['-e', ${JSON.stringify(KEEPER)}, own[0]], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });
`;

/**
 * SILENT_AFTER_COMMIT, and once told to commit, a keeper holds the relay's
 * stdout open for 2.5 s (its pid goes to the file given): killed however
 * soon, its exit is seen only then, as a kill on a loaded machine can be.
 */
const SLOW_TO_EXIT_ONCE_TOLD_TO_COMMIT = `${SILENT_AFTER_COMMIT}
lines(process.stdin, (line) => {
  if (line.trim() !== 'commit') return;
  spawn(process.execPath, ['-e', ${JSON.stringify(KEEPER.replace('setInterval(() => {}, 1 << 30)', 'setTimeout(() => {}, 2500)'))}, own[0]], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });
});
`;

/**
 * An updater whose git dies holding the ref's lock, as a killed git does:
 * once git has prepared, it is killed at once, and the relay passes on
 * `prepare: ok` (own args `forward`) or not (`withhold`), then goes quiet.
 */
const DIES_HOLDING_THE_LOCK = `${RELAY}
lines(process.stdin, (line) => git.stdin.write(line));
lines(git.stdout, (line) => {
  if (line.trim() !== 'prepare: ok') return void process.stdout.write(line);
  killGit();
  if (own[0] === 'forward') process.stdout.write(line);
});
`;

/**
 * DIES_HOLDING_THE_LOCK, and once it is killed its exit is seen only 3 s
 * later: a process that is no one's child holds its stdout open until then
 * (its pid goes to the file given second).
 */
const DIES_HOLDING_THE_LOCK_SLOW_TO_EXIT = `${DIES_HOLDING_THE_LOCK}
spawn(process.execPath, ['-e', ${JSON.stringify(KEEPER.replace('setInterval(() => {}, 1 << 30)', 'setTimeout(() => {}, 3000)'))}, own[1]], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });
`;

/** An object reader that answers requests for refs, and stops answering at the first request for an object id. */
const ANSWERS_ONLY_REFS = `${RELAY}
let stopped = false;
lines(process.stdin, (line) => {
  if (!line.startsWith('refs/')) stopped = true;
  if (!stopped) git.stdin.write(line);
});
git.stdout.on('data', (chunk) => process.stdout.write(chunk));
`;

interface Replacement {
  /** Matched against git's arguments, joined by spaces. */
  readonly command: RegExp;
  readonly script: string;
  readonly args?: readonly string[];
  /** Replaces only the first this many gits it matches; every one when unset. */
  readonly times?: number;
}

/** Runs each replacement's script with node in place of the gits it matches, until `restore`. */
function replaceGits(...replacements: Replacement[]): { restore(): void } {
  const left = replacements.map((replacement) => replacement.times ?? Infinity);
  const replaced = (name: string, gitArgs: readonly string[], options: childProcess.SpawnOptions) => {
    const i = name === 'git' ? replacements.findIndex((r, j) => left[j]! > 0 && r.command.test(gitArgs.join(' '))) : -1;
    if (i < 0) return realSpawn(name, gitArgs, options);
    left[i]!--;
    const { script, args = [] } = replacements[i]!;
    return realSpawn(process.execPath, ['-e', script, '--', ...args, '::git', ...gitArgs], options);
  };
  vi.mocked(childProcess.spawn).mockImplementation(replaced as unknown as typeof childProcess.spawn);
  return { restore: () => vi.mocked(childProcess.spawn).mockImplementation(realSpawn) };
}

/** A process a stand-in started (or was): its pid, and a time it was known to run. */
interface Ran {
  readonly pid: number;
  readonly at: number;
}

/** The processes the stand-ins wrote to `file`, as `<pid> <time it ran>` lines, in order. */
async function ranIn(file: string): Promise<Ran[]> {
  const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return lines.map((line) => {
    const [pid = NaN, at = NaN] = line.split(' ').map(Number);
    return { pid, at };
  });
}

/**
 * Those of `processes` that still run. A pid outlives its process: on a
 * busy Windows machine another process takes it within moments. So a live
 * pid counts only while the process holding it started no later than when
 * the stand-in's own was known to run (the OS is asked: a process start).
 */
async function stillRunning(processes: readonly Ran[]): Promise<Ran[]> {
  const live = processes.filter(({ pid }) => isPidAlive(pid));
  if (live.length === 0) return [];
  const started = await processStartTimes(live.map(({ pid }) => pid));
  // No start time from the OS: gone by now, or it can't be told; then the pid decides.
  return live.filter(({ pid, at }) => (started.has(pid) ? started.get(pid)! <= at : isPidAlive(pid)));
}

/**
 * Waits up to `timeoutMs` until none of `processes` still runs. Their pids
 * are looked at often, and whose process holds a pid is asked of the OS only
 * once it has looked alive for a second, and before giving up.
 */
async function expectGone(processes: readonly Ran[], timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let left = [...processes];
  let askedAt = Date.now();
  for (;;) {
    left = left.filter(({ pid }) => isPidAlive(pid));
    if (left.length > 0 && (Date.now() - askedAt >= 1_000 || Date.now() >= until)) {
      left = await stillRunning(left);
      askedAt = Date.now();
    }
    if (left.length === 0 || Date.now() >= until) break;
    await setTimeout(100);
  }
  expect(left.map(({ pid }) => pid)).toEqual([]);
}

/** Kills every process in `file` that still runs (never a later one that took its pid). */
async function killPidsIn(file: string): Promise<void> {
  for (const { pid } of await stillRunning(await ranIn(file))) {
    try {
      process.kill(pid);
    } catch {
      // Gone since it was asked about.
    }
  }
}

describe('a local git that stops answering', { timeout: 180_000 }, () => {
  // All at the machine's pace (`paced`): every git the store runs here gets STALL_MS, generous for a real
  // one, and a write gets BUDGET_MS. Its BUSY may come LATE_MS after the budget (what comes before it, a
  // process start, a kill or the fairness lock's release, takes time too), but never a stall time late.
  // Killed processes are gone within GONE_MS. A write that must land after its git got stuck gets the
  // product's own budget: what that costs (a stall time, a kill, a new git) is no part of what it proves.
  const BUDGET_MS = 3_000;
  const STALL_MS = 1_000;
  const LATE_MS = 500;
  const GONE_MS = 5_000;

  test.for([
    ['the object reader', /cat-file --batch/],
    ['the ref updater', /update-ref --stdin/],
    ['a one-shot git', /config -z --get-regexp/],
  ] as const)(
    '%s: it is killed with all it started, the write gives BUSY within its budget, and the write later lands exactly once',
    async ([, command], { world, grimoire, paced }) => {
      void grimoire; // initializes the tracker
      const budgetMs = paced(BUDGET_MS);
      const before = (await trackerTip(world.a))!;
      const pidFile = pidFileIn(world.root, 'wedged-pids');
      const wedged = replaceGits({ command, script: WEDGED_GIT, args: [pidFile] });
      const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: paced(STALL_MS) });
      try {
        const started = Date.now();
        const failure: unknown = await store.transact(keyWrite('wedged'), () => ({ result: null })).catch((error: unknown) => error);
        const took = Date.now() - started;

        expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
        expect(took).toBeLessThan(budgetMs + paced(LATE_MS));
        expect(await trackerTip(world.a)).toBe(before);
        // Each wedged git and the child it started (on POSIX only the git itself is killed: its tree is its own).
        const killed = (await ranIn(pidFile)).filter((_, i) => process.platform === 'win32' || i % 2 === 0);
        expect(killed.length).toBeGreaterThan(0);
        await expectGone(killed, paced(GONE_MS));

        wedged.restore();
        expect(await store.transact(keyWrite('wedged'), () => ({ result: null }))).toMatchObject({ replayed: false });
        expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
      } finally {
        wedged.restore();
        await store.close();
        await killPidsIn(pidFile);
      }
    },
  );

  test.for([
    ['more than a second', 1_200],
    ['less than a second', 400],
  ] as const)(
    'a git that stops answering late in the budget, once the write got the fairness lock with %s left: BUSY still comes within the budget',
    async ([, left], { world, grimoire, paced }) => {
      void grimoire; // initializes the tracker
      const budgetMs = paced(BUDGET_MS);
      const pidFile = pidFileIn(world.root, 'wedged-pids');
      const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: paced(2_000) });
      const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
      const held = await machine.locks.acquire('tracker-write');
      if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
      let wedged = { restore() {} };
      try {
        const { asked } = nextTurnAtTheLock();
        const startedAt = Date.now();
        const write = store.transact(keyWrite('late'), () => ({ result: null })).catch((error: unknown) => error);
        // Once the write is ready and waits for the lock, the clone's config changes, so its round reads
        // it again, with a git that hangs. Only letting go of the lock is left for the last moment, so a
        // slow machine doesn't push the round past the budget.
        await asked;
        wedged = replaceGits({ command: /config -z --get-regexp/, script: WEDGED_GIT, args: [pidFile] });
        await world.a.git(['config', 'grimoire.unrelated', 'changed']);
        await setTimeout(Math.max(0, startedAt + budgetMs - paced(left) - Date.now()));
        await held.lock.release();

        const failure = await write;
        const took = Date.now() - startedAt;

        expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
        expect(took).toBeLessThan(budgetMs + paced(LATE_MS));
      } finally {
        wedged.restore();
        await store.close();
        await killPidsIn(pidFile);
      }
    },
  );

  test('a git that stops answering for the whole budget before the write could take its turn: BUSY names it, and no git starts past the deadline', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const budgetMs = paced(BUDGET_MS);
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    // The object reader hangs and would get longer than the budget: the write's first read, before it queues for the
    // fairness lock, uses the budget up. Its round would get no time for any git, and would only start new ones.
    const wedged = replaceGits({ command: /cat-file --batch/, script: WEDGED_GIT, args: [pidFile] });
    const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: 2 * budgetMs });
    try {
      forgetStarts();
      const startedAt = Date.now();
      const failure: unknown = await store.transact(keyWrite('used up'), () => ({ result: null })).catch((error: unknown) => error);
      const took = Date.now() - startedAt;

      expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
      expect((failure as Error).message).not.toMatch(/ for 0\.0 s/);
      expect(took).toBeLessThan(budgetMs + paced(LATE_MS));
      expect(started().filter((line) => / cat-file --batch$/.test(line))).toHaveLength(1);
    } finally {
      wedged.restore();
      await store.close();
      await killPidsIn(pidFile);
    }
  });

  test('a git whose kill is slow to start, as on a loaded machine: BUSY still comes within the budget, and the git is killed', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const budgetMs = paced(BUDGET_MS);
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const wedged = replaceGits({ command: /config -z --get-regexp/, script: WEDGED_GIT, args: [pidFile] });
    // Starting a process blocks the thread that starts it; on a loaded Windows machine, for hundreds of ms.
    const blockedMs = paced(800);
    const spawnGit = vi.mocked(childProcess.spawn).getMockImplementation()!;
    vi.mocked(childProcess.spawn).mockImplementation(((name: string, ...rest: unknown[]) => {
      if (name === 'taskkill') for (const until = Date.now() + blockedMs; Date.now() < until; );
      return (spawnGit as (...args: unknown[]) => childProcess.ChildProcess)(name, ...rest);
    }) as unknown as typeof childProcess.spawn);
    const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: paced(STALL_MS) });
    try {
      const started = Date.now();
      const failure: unknown = await store.transact(keyWrite('slow kill'), () => ({ result: null })).catch((error: unknown) => error);
      const took = Date.now() - started;

      expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
      expect(took).toBeLessThan(budgetMs + paced(LATE_MS));
      const killed = (await ranIn(pidFile)).filter((_, i) => process.platform === 'win32' || i % 2 === 0);
      expect(killed.length).toBeGreaterThan(0);
      await expectGone(killed, paced(GONE_MS));
    } finally {
      wedged.restore();
      await store.close();
      await killPidsIn(pidFile);
    }
  });

  test('a ref updater that stops answering and is slow to exit once killed: BUSY still comes within the budget', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const budgetMs = paced(BUDGET_MS);
    const before = (await trackerTip(world.a))!;
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const wedged = replaceGits({ command: /update-ref --stdin/, script: WEDGED_SLOW_TO_EXIT, args: [pidFile] });
    const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: paced(STALL_MS) });
    try {
      const started = Date.now();
      const failure: unknown = await store.transact(keyWrite('slow exit'), () => ({ result: null })).catch((error: unknown) => error);
      const took = Date.now() - started;

      expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
      expect(took).toBeLessThan(budgetMs + paced(LATE_MS));
      expect(await trackerTip(world.a)).toBe(before);
    } finally {
      wedged.restore();
      await killPidsIn(pidFile);
      await store.close();
    }
  });

  test('a ref updater that stops answering once told to commit: the write lands exactly once, and says so', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const before = (await trackerTip(world.a))!;
    const silent = replaceGits({ command: /update-ref --stdin/, script: SILENT_AFTER_COMMIT });
    const store = await openTracker(world.a.dir, { budgetMs: paced(DEFAULT_BUDGET_MS), gitStallMs: paced(STALL_MS) });
    try {
      const write = await store.transact(keyWrite('silent'), () => ({ result: null }));

      expect(write.commit).toBe(await trackerTip(world.a));
      expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    } finally {
      silent.restore();
      await store.close();
    }
  });

  test('a ref updater told to commit whose kill takes seconds to be seen: whether the ref moved is still found out', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const start = (await trackerTip(world.a))!;
    const next = await world.a.git(['commit-tree', `${start}^{tree}`, '-p', start, '-m', 'next']);
    const pidFile = pidFileIn(world.root, 'keeper-pids');
    const silent = replaceGits({ command: /update-ref --stdin/, script: SLOW_TO_EXIT_ONCE_TOLD_TO_COMMIT, args: [pidFile], times: 1 });
    // Its answer to commit gets a second, as near a write's deadline (STALL_FLOOR_MS); the git that then finds out
    // whether the ref moved gets the machine's pace.
    let settles = 0;
    const updater = new RefUpdater({ root: world.a.dir, commonDir: path.join(world.a.dir, '.git') }, 'grimoire: test', {
      stallMs: paced(STALL_MS),
      settleMs: () => (settles++ === 0 ? 1_000 : paced(STALL_MS)),
    });
    try {
      expect(await updater.update(TRACKER_REF, next, start)).toEqual({ moved: true });
      expect(await trackerTip(world.a)).toBe(next);
    } finally {
      silent.restore();
      await updater.close();
      await killPidsIn(pidFile);
    }
  });

  test('a tracker created by a git that stops answering once it moved the ref: it is created exactly once, and says so', async ({
    world,
    paced,
  }) => {
    // Clone b has no tracker yet. A one-shot git that wrote the ref and then hangs, or an updater that hangs once told to commit.
    const silent = replaceGits({ command: /update-ref/, script: SILENT_AFTER_COMMIT });
    const store = await openTracker(world.b.dir, { gitStallMs: paced(STALL_MS) });
    try {
      const created = await store.initialize({ author: { name: 'B', email: 'b@example.com' }, actor: { kind: 'human', client: 'cli', nonce: 'init' } });

      expect(created).toEqual({ root: await trackerTip(world.b), created: true });
      expect(await world.b.git(['rev-list', '--count', TRACKER_REF])).toBe('1');
    } finally {
      silent.restore();
      await store.close();
    }
  });

  test('a push that landed while the git recording it in the remote-tracking ref stops answering: the sync says pushed, not BUSY', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const local = (await trackerTip(world.a))!;
    const tracking = 'refs/remotes/origin/grimoire/tracker';
    const silent = replaceGits({ command: /update-ref (refs\/remotes\/|--stdin --create-reflog -m grimoire: sync)/, script: SILENT_AFTER_COMMIT });
    const store = await openTracker(world.a.dir, { gitStallMs: paced(STALL_MS) });
    try {
      const outcome = await store.sync({ author: { name: 'A', email: 'a@example.com' }, actor: { kind: 'human', nonce: 'n' }, timeoutMs: 30_000 });

      expect(outcome).toMatchObject({ state: 'pushed', local });
      expect((await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]).toBe(local);
      expect(await world.a.git(['rev-parse', tracking])).toBe(local);
    } finally {
      silent.restore();
      await store.close();
    }
  });

  test.for([
    ['once it said it prepared', 'forward'],
    ['before it could say it prepared', 'withhold'],
  ] as const)(
    'a ref updater killed holding the ref’s lock %s: the lock goes with it, and the write lands exactly once',
    async ([, mode], { world, grimoire, paced }) => {
      void grimoire; // initializes the tracker
      const before = (await trackerTip(world.a))!;
      const dies = replaceGits({ command: /update-ref --stdin/, script: DIES_HOLDING_THE_LOCK, args: [mode], times: 1 });
      const store = await openTracker(world.a.dir, { budgetMs: paced(DEFAULT_BUDGET_MS), gitStallMs: paced(STALL_MS) });
      try {
        const write = await store.transact(keyWrite('dies'), () => ({ result: null }));

        expect(write.commit).toBe(await trackerTip(world.a));
        expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
        await expect(stat(path.join(world.a.dir, '.git', `${TRACKER_REF}.lock`))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        dies.restore();
        await store.close();
      }
    },
  );

  test('a ref updater killed holding the ref’s lock whose exit takes seconds: the lock still goes once it exits, and a later write lands', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const before = (await trackerTip(world.a))!;
    const pidFile = pidFileIn(world.root, 'keeper-pids');
    const dies = replaceGits({ command: /update-ref --stdin/, script: DIES_HOLDING_THE_LOCK_SLOW_TO_EXIT, args: ['withhold', pidFile], times: 1 });
    const store = await openTracker(world.a.dir, { budgetMs: paced(BUDGET_MS), gitStallMs: paced(STALL_MS) });
    try {
      // BUSY while its exit is awaited, or landed if it came in time; then the same write lands, or replays.
      await store.transact(keyWrite('slow death'), () => ({ result: null })).catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'BUSY', retryable: true });
      });
      const write = await store.transact(keyWrite('slow death'), () => ({ result: null }));

      expect(write.commit ?? (await trackerTip(world.a))).toBe(await trackerTip(world.a));
      expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
      await expect(stat(path.join(world.a.dir, '.git', `${TRACKER_REF}.lock`))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      dies.restore();
      await killPidsIn(pidFile);
      await store.close();
    }
  });

  test('a git that stops answering with less than a stall time of the budget left after it: the write still lands on a new git', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    // The stuck git gets a stall time, after which three quarters of one is left; the time before is the write's to get ready in.
    const [stallMs, leftMs] = [paced(3_000), paced(2_250)];
    const budgetMs = paced(5_000) + stallMs + leftMs;
    const before = (await trackerTip(world.a))!;
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const store = await openTracker(world.a.dir, { budgetMs, gitStallMs: stallMs });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const held = await machine.locks.acquire('tracker-write');
    if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
    let wedged = { restore() {} };
    try {
      const { asked } = nextTurnAtTheLock();
      const startedAt = Date.now();
      const write = store.transact(keyWrite('late retry'), () => ({ result: null }));
      // Once the write waits for the lock, the clone's config changes, so its round reads it again,
      // with a git that hangs; the next one answers.
      await asked;
      wedged = replaceGits({ command: /config -z --get-regexp/, script: WEDGED_GIT, args: [pidFile], times: 1 });
      await world.a.git(['config', 'grimoire.unrelated', 'changed']);
      // The round starts once the lock is let go; its git is killed a stall time later, with less than a stall time left.
      await setTimeout(Math.max(0, startedAt + budgetMs - stallMs - leftMs - Date.now()));
      await held.lock.release();

      expect((await write).commit).toBe(await trackerTip(world.a));
      expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
      expect(await ranIn(pidFile)).not.toEqual([]);
    } finally {
      wedged.restore();
      await held.lock.release();
      await store.close();
      await killPidsIn(pidFile);
    }
  });

  test('a ref updater told to commit that outlives being killed: the write fails without promising the ref did not move', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const before = (await trackerTip(world.a))!;
    const pidFile = pidFileIn(world.root, 'keeper-pids');
    const unkillable = replaceGits({ command: /update-ref --stdin/, script: UNKILLABLE_AFTER_COMMIT, args: [pidFile], times: 1 });
    const store = await openTracker(world.a.dir, { budgetMs: paced(BUDGET_MS), gitStallMs: paced(STALL_MS) });
    try {
      const failure: unknown = await store.transact(keyWrite('unkillable'), () => ({ result: null })).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toMatchObject({ code: 'BUSY' });
      expect((failure as Error).message).toMatch(/whether .* moved is unknown/);
      // git did commit: a retry replays the write, and nothing is written twice.
      unkillable.restore();
      expect(await store.transact(keyWrite('unkillable'), () => ({ result: null }))).toMatchObject({ replayed: true });
      expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    } finally {
      unkillable.restore();
      await killPidsIn(pidFile);
      await store.close();
    }
  });

  test('when the git that would tell whether the ref moved stops answering too: the write fails without promising either way', async ({
    world,
    grimoire,
    paced,
  }) => {
    void grimoire; // initializes the tracker
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const wedged = replaceGits(
      { command: /update-ref --stdin/, script: SILENT_AFTER_COMMIT },
      { command: /for-each-ref --contains/, script: WEDGED_GIT, args: [pidFile] },
    );
    const store = await openTracker(world.a.dir, { budgetMs: paced(BUDGET_MS), gitStallMs: paced(STALL_MS) });
    try {
      const failure: unknown = await store.transact(keyWrite('untold'), () => ({ result: null })).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toMatchObject({ code: 'BUSY' });
      expect((failure as Error).message).toMatch(/could not tell whether/);
    } finally {
      wedged.restore();
      await store.close();
      await killPidsIn(pidFile);
    }
  });

  test('an object reader that stops answering mid-walk ends the read: no other git decides in its place', async ({ world, grimoire, paced }) => {
    // config.yml names the tracker root, so a read walks back from the tip to it, reading commits.
    await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
    const root = await world.a.git(['rev-list', '--max-parents=0', TRACKER_REF]);
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), `install_format: 1\ntracker_root: "${root}"\n`);
    for (const title of ['One', 'Two']) expect(await grimoire.core.call('create', { title }, grimoire.ctx)).toMatchObject({ ok: true });
    const stops = replaceGits({ command: /cat-file --batch/, script: ANSWERS_ONLY_REFS, times: 1 });
    const store = await openTracker(world.a.dir, { gitStallMs: paced(STALL_MS) });
    try {
      forgetStarts();
      const failure: unknown = await store.read().catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BUSY', message: expect.stringContaining('stopped answering') });
      expect(started().filter((line) => / (merge-base|rev-list) /.test(line))).toEqual([]);
      stops.restore();
      expect((await store.read()).tip).toBe(await trackerTip(world.a));
    } finally {
      stops.restore();
      await store.close();
    }
  });

  test('a git that stops answering while the store finds its repository: BUSY, not NO_REPO', async ({ world, grimoire, paced }) => {
    void grimoire; // initializes the tracker
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const wedged = replaceGits({ command: /rev-parse --path-format/, script: WEDGED_GIT, args: [pidFile] });
    try {
      const failure: unknown = await openTracker(world.a.dir, { gitStallMs: paced(STALL_MS) }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
    } finally {
      wedged.restore();
      await killPidsIn(pidFile);
    }
  });

  test.for([
    ['an object reader', /cat-file --batch/],
    ['a ref updater', /update-ref --stdin/],
  ] as const)('closing %s whose idle git is stuck kills it within the stall time', async ([what, command], { world, grimoire, paced }) => {
    void grimoire; // initializes the tracker
    const stallMs = paced(STALL_MS);
    const pidFile = pidFileIn(world.root, 'wedged-pids');
    const wedged = replaceGits({ command, script: WEDGED_GIT, args: [pidFile] });
    const location = { root: world.a.dir, commonDir: path.join(world.a.dir, '.git') };
    const git =
      what === 'an object reader'
        ? new ObjectReader(location.root, stallMs)
        : new RefUpdater(location, 'grimoire: test', { stallMs });
    try {
      await git.warm();
      await vi.waitFor(async () => expect(await ranIn(pidFile)).toHaveLength(2), { timeout: paced(GONE_MS) });
      const started = Date.now();

      await git.close();

      // Killed at the stall time; what is left is how long the kill takes to be seen.
      expect(Date.now() - started).toBeLessThan(stallMs + paced(1_000));
      const killed = (await ranIn(pidFile)).filter((_, i) => process.platform === 'win32' || i % 2 === 0);
      await expectGone(killed, paced(GONE_MS));
    } finally {
      wedged.restore();
      await killPidsIn(pidFile);
    }
  });
});
