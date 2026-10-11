// The write path's critical section (spec §4, Write path; ADR 0007): every
// tracker write runs under the fairness lock, one after another, so whatever
// a write costs there is paid once per queued writer. Starting git costs tens
// of milliseconds on Windows and several times that on a busy machine, so a
// write starts no process while it holds the lock: refs are resolved and moved
// through long-lived gits, which must never act on a stale view of them, and
// must not outlive their store or break the write when they die.
//
// The first tests are performance guards, a deliberate exception to "never
// assert on internals" (spec, Testing Decisions): a process start inside the
// lock shows at no interface except as time, which the 40-writer acceptance
// test (concurrency.test.ts) measures end to end. They watch process starts
// through a pass-through spy on node:child_process, and only over the critical
// section: from when the lock is let go to a write waiting for it until the
// write returns. Later tests use the same spy to find the long-lived gits,
// and to put a git that stops answering in place of one: a hung git must be
// killed, and must never hold a write (or the fairness lock) forever.
import * as childProcess from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, vi } from 'vitest';
import type { Checkout } from '#harness';
import { packedRefsStamp, RefUpdater } from '../../src/git/refs';
import { MachineLocalStore } from '../../src/machine-local';
import { openTracker, type WriteSpec } from '../../src/tracker';
import { commitToTracker, coreTest as test, fetchTracker, pushTracker, trackerTip, TRACKER_REF } from './support';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

const starters = () => [vi.mocked(childProcess.spawn), vi.mocked(childProcess.execFile)];

/** The processes started since the last `forgetStarts`, as `command arg…` lines. */
function started(): string[] {
  return starters().flatMap((fn) =>
    fn.mock.calls.map(([command, args]) => [command, ...(Array.isArray(args) ? args : [])].join(' ')),
  );
}

function forgetStarts(): void {
  for (const fn of starters()) fn.mockClear();
}

/**
 * Runs `write` while the fairness lock is held elsewhere: lets it get ready
 * (until no process has started for 300 ms), runs `meanwhile` (what the
 * lock's holder does while the write waits), then lets go of the lock.
 * Returns what the write returned, and the processes started from the release
 * on, which is inside the write's critical section.
 */
async function insideTheLock<T>(
  checkout: Checkout,
  write: () => Promise<T>,
  meanwhile?: () => Promise<void>,
): Promise<{ value: T; started: string[] }> {
  const machine = new MachineLocalStore(path.join(checkout.dir, '.git'));
  const held = await machine.locks.acquire('tracker-write');
  if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
  const pending = write();
  for (let seen = -1; seen !== started().length; ) {
    seen = started().length;
    await setTimeout(300);
  }
  await meanwhile?.();
  forgetStarts();
  await held.lock.release();
  return { value: await pending, started: started() };
}

describe('the write path', () => {
  test('a warm core starts no process while it holds the fairness lock: refs are resolved and moved through long-lived git', async ({
    world,
    grimoire,
  }) => {
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    for (let i = 0; i < 2; i++) {
      const write = await insideTheLock(world.a, () =>
        grimoire.core.call('create', { title: `Write ${i}` }, grimoire.ctx),
      );

      expect(write.value).toMatchObject({ ok: true });
      expect(write.started).toEqual([]);
    }
    expect(await world.a.git(['rev-list', '--count', (await trackerTip(world.a))!])).toBe('4');
  });

  test('a write ahead of a fetched remote-tracking tracker, with the tracker root named, starts no process inside the lock either', async ({
    world,
    grimoire,
  }) => {
    // What `init` commits: config.yml names the tracker's root, which every tip's history must hold.
    await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
    const root = await world.a.git(['rev-list', '--max-parents=0', TRACKER_REF]);
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), `install_format: 1\ntracker_root: "${root}"\n`);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    await commitToTracker(world.a, { 'notes/another-writer.txt': 'x\n' }, 'another writer');
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    const own = await insideTheLock(world.a, () => grimoire.core.call('create', { title: 'Mine' }, grimoire.ctx));
    // Commits other writers make while this one waits for the lock are walked too.
    const after = await insideTheLock(
      world.a,
      () => grimoire.core.call('create', { title: 'After others' }, grimoire.ctx),
      async () => {
        for (let i = 0; i < 3; i++) {
          await commitToTracker(world.a, { 'notes/another-writer.txt': `${i}\n` }, 'another writer');
        }
      },
    );

    expect(own.value).toMatchObject({ ok: true });
    expect(own.started).toEqual([]);
    expect(after.value).toMatchObject({ ok: true });
    expect(after.started).toEqual([]);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['merge-base', '--is-ancestor', 'refs/remotes/origin/grimoire/tracker', tip])).toBe('');
  });

  test('in a shallow clone whose tracker history is whole, a warm core starts no process inside the lock either', async ({
    world,
    grimoire,
  }) => {
    // b moves main on by two commits and a fetches only the newest: main's history is cut off in a, the tracker's isn't.
    await world.b.commitFile('one.txt', '1\n');
    await world.b.commitFile('two.txt', '2\n');
    await world.b.git(['push', '--quiet', 'origin', 'main']);
    await world.a.git(['fetch', '--quiet', '--depth', '1', 'origin', 'main']);
    expect(await world.a.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    const own = await insideTheLock(world.a, () => grimoire.core.call('create', { title: 'Mine' }, grimoire.ctx));
    const after = await insideTheLock(
      world.a,
      () => grimoire.core.call('create', { title: 'After others' }, grimoire.ctx),
      async () => {
        for (let i = 0; i < 3; i++) {
          await commitToTracker(world.a, { 'notes/another-writer.txt': `${i}\n` }, 'another writer');
        }
      },
    );

    expect(own.value).toMatchObject({ ok: true });
    expect(own.started).toEqual([]);
    expect(after.value).toMatchObject({ ok: true });
    expect(after.started).toEqual([]);
    expect(await world.a.git(['rev-list', '--count', (await trackerTip(world.a))!])).toBe('7');
  });

  test('a cold core starts its gits while it waits for the fairness lock, not inside it', async ({
    world,
    grimoire,
  }) => {
    const core = grimoire.makeCore();

    const write = await insideTheLock(world.a, () => core.call('create', { title: 'Cold' }, grimoire.ctx));

    expect(write.value).toMatchObject({ ok: true });
    expect(write.started).toEqual([]);
  });

  test('a write builds on a tip another writer moved, even when packed-refs was rewritten within the same second', async ({
    world,
    grimoire,
  }) => {
    // A long-lived git caches packed-refs and trusts its stat, which can miss a
    // same-size rewrite inside one timestamp tick: the write would build on a
    // stale tip and lose every compare-and-set until BUSY. Each round leaves the
    // tick only a few git commands to pass in, so most rounds stay inside it.
    const core = grimoire.makeCore({ writeBudgetMs: 3_000 });
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
  const updater = new RefUpdater(checkout.dir, 'grimoire: test', async () => {
    const stamp = await packedRefsStamp(commonDir);
    const step = interleave;
    interleave = null;
    await step?.();
    return stamp;
  });
  return { updater, afterNextLook: (step) => void (interleave = step) };
}

describe('the ref updater', () => {
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

  test('an update whose git died holding the ref lock says the ref did not move', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    const { updater, afterNextLook } = updaterOver(world.a);
    const lock = path.join(world.a.dir, '.git', `${TRACKER_REF}.lock`);
    try {
      const start = (await trackerTip(world.a))!;
      const next = await world.a.git(['commit-tree', `${start}^{tree}`, '-p', start, '-m', 'next']);
      expect(await updater.update(TRACKER_REF, start, start)).toEqual({ moved: true });
      // The next look is the update's own; the one after is once git has prepared: kill it then.
      afterNextLook(() => afterNextLook(() => runningGit(/update-ref --stdin/).kill()));

      const update = await updater.update(TRACKER_REF, next, start);

      expect(update.moved).toBe(false);
      expect(await trackerTip(world.a)).toBe(start);
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

describe('the store after close', () => {
  test('a write in flight when the store closed, and a read after it, leave no git running', async ({
    world,
    grimoire,
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
    await vi.waitFor(() => expect(runningGits(from)).toEqual([]), { timeout: 5_000 });
  });
});

describe('the store after its long-lived gits died', () => {
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

/**
 * A git that never answers: it starts a child of its own, as git for
 * Windows' launcher does, appends both pids to the file it is given, and
 * both sleep.
 */
const WEDGED_GIT = `
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true });
appendFileSync(process.argv[1], process.pid + '\\n' + child.pid + '\\n');
setInterval(() => {}, 1 << 30);
`;

/** A real git behind a relay that stops passing its answers on once it is told to commit, and never exits. */
const SILENT_AFTER_COMMIT = `
const { spawn } = require('node:child_process');
const git = spawn('git', process.argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let told = false;
process.stdin.on('data', (chunk) => {
  if (/^commit$/m.test(chunk.toString())) told = true;
  git.stdin.write(chunk);
});
git.stdout.on('data', (chunk) => {
  if (!told) process.stdout.write(chunk);
});
setInterval(() => {}, 1 << 30);
`;

/** Runs `script` with node (given `args`, then `--` and git's own arguments) in place of each git `command` matches, until `restore`. */
function replaceGits(command: RegExp, script: string, args: readonly string[]): { restore(): void } {
  const replaced = (name: string, gitArgs: readonly string[], options: childProcess.SpawnOptions) =>
    name === 'git' && command.test(gitArgs.join(' '))
      ? realSpawn(process.execPath, ['-e', script, ...args, '--', ...gitArgs], options)
      : realSpawn(name, gitArgs, options);
  vi.mocked(childProcess.spawn).mockImplementation(replaced as unknown as typeof childProcess.spawn);
  return { restore: () => vi.mocked(childProcess.spawn).mockImplementation(realSpawn) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('a local git that stops answering', () => {
  const BUDGET_MS = 2_000;
  const STALL_MS = 300;

  test.for([
    ['the object reader', /cat-file --batch/],
    ['the ref updater', /update-ref --stdin/],
    ['a one-shot git', /config -z --get-regexp/],
  ] as const)(
    '%s: it is killed with all it started, the write gives BUSY within its budget, and the write later lands exactly once',
    async ([, command], { world, grimoire }) => {
      void grimoire; // initializes the tracker
      const before = (await trackerTip(world.a))!;
      const pidFile = path.join(world.root, 'wedged-pids');
      const wedged = replaceGits(command, WEDGED_GIT, [pidFile]);
      const store = await openTracker(world.a.dir, { budgetMs: BUDGET_MS, gitStallMs: STALL_MS });
      const pids = async () => (await readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
      try {
        const started = Date.now();
        const failure: unknown = await store.transact(keyWrite('wedged'), () => ({ result: null })).catch((error: unknown) => error);
        const took = Date.now() - started;

        expect(failure).toMatchObject({ code: 'BUSY', retryable: true, message: expect.stringContaining('stopped answering') });
        expect(took).toBeLessThan(BUDGET_MS + STALL_MS + 1_000);
        expect(await trackerTip(world.a)).toBe(before);
        // Each wedged git and the child it started (on POSIX only the git itself is killed: its tree is its own).
        const killed = (await pids()).filter((_, i) => process.platform === 'win32' || i % 2 === 0);
        expect(killed.length).toBeGreaterThan(0);
        await vi.waitFor(() => expect(killed.filter(alive)).toEqual([]), { timeout: 5_000 });

        wedged.restore();
        expect(await store.transact(keyWrite('wedged'), () => ({ result: null }))).toMatchObject({ replayed: false });
        expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
      } finally {
        wedged.restore();
        await store.close();
        for (const pid of (await pids()).filter(alive)) process.kill(pid);
      }
    },
  );

  test('a ref updater that stops answering once told to commit: the write lands exactly once, and says so', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    const before = (await trackerTip(world.a))!;
    const silent = replaceGits(/update-ref --stdin/, SILENT_AFTER_COMMIT, []);
    const store = await openTracker(world.a.dir, { budgetMs: 5_000, gitStallMs: STALL_MS });
    try {
      const write = await store.transact(keyWrite('silent'), () => ({ result: null }));

      expect(write.commit).toBe(await trackerTip(world.a));
      expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    } finally {
      silent.restore();
      await store.close();
    }
  });
});
