// Shared by the write-path tests (write-path.test.ts, the critical section's
// performance guards; write-path.slow.test.ts, the clock and hung-git tests).
// Each of those files mocks node:child_process with pass-through spies, which
// these helpers read: import this only from a file that does.
import * as childProcess from 'node:child_process';
import path from 'node:path';
import { vi } from 'vitest';
import type { Checkout } from '#harness';
import { MachineLocalStore } from '../../src/machine-local';
import { FairnessLock } from '../../src/tracker/locks';
import { coreTest } from './support';

/**
 * How many times slower than an idle machine this one is right now at
 * starting a git and hearing back from it (1 at least): the slowest of three
 * real gits in `checkout`, against a third of a second, or
 * GRIMOIRE_TEST_SLOWNESS when that is more. A stall must stay well above how
 * long a real git takes, or a slow git is taken for a stuck one; and a kill,
 * a process start or a lock's release takes longer on a loaded machine too.
 */
export async function slownessOf(checkout: Checkout): Promise<number> {
  let slowest = 0;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    await checkout.gitResult(['rev-parse', '--git-common-dir']);
    slowest = Math.max(slowest, performance.now() - started);
  }
  return Math.max(1, slowest / 333, Number(process.env.GRIMOIRE_TEST_SLOWNESS) || 1);
}

/** The slowness the last test here ran at. */
let lastSlowness = 1;

/**
 * `coreTest`, and `paced(ms)`: `ms` scaled by how slow the machine is when
 * the test starts (see `slownessOf`), or by three quarters of what the last
 * test ran at when that is more: load comes in bursts, and three gits can
 * fall in a lull.
 */
export const test = coreTest.extend('paced', async ({ world }) => {
  const slowness = Math.max(await slownessOf(world.a), lastSlowness * 0.75);
  lastSlowness = slowness;
  return (ms: number) => Math.round(ms * slowness);
});

export const starters = () => [vi.mocked(childProcess.spawn), vi.mocked(childProcess.execFile)];

/** The processes started since the last `forgetStarts`, as `command arg…` lines. */
export function started(): string[] {
  return starters().flatMap((fn) =>
    fn.mock.calls.map(([command, args]) => [command, ...(Array.isArray(args) ? args : [])].join(' ')),
  );
}

export function forgetStarts(): void {
  for (const fn of starters()) fn.mockClear();
}

export const takeFairnessLock = FairnessLock.prototype.acquire;

/**
 * Watches the next write's turn at the fairness lock: `asked` resolves once
 * the write asks for the lock (it is ready, and waits for it), and `onTaken`
 * runs the moment the write has it.
 */
export function nextTurnAtTheLock(onTaken: () => void = () => {}): { asked: Promise<void> } {
  let ask!: () => void;
  const asked = new Promise<void>((resolve) => (ask = resolve));
  vi.spyOn(FairnessLock.prototype, 'acquire').mockImplementationOnce(async function (this: FairnessLock, ...args) {
    ask();
    const lock = await takeFairnessLock.apply(this, args);
    onTaken();
    return lock;
  });
  return { asked };
}

/**
 * Runs `write` while the fairness lock is held elsewhere: lets it get ready
 * (until it asks for the lock), runs `meanwhile` (what the lock's holder does
 * while the write waits), then lets go of the lock. Returns what the write
 * returned, and the processes started from when it took the lock on: inside
 * its critical section.
 */
export async function insideTheLock<T>(
  checkout: Checkout,
  write: () => Promise<T>,
  meanwhile?: () => Promise<void>,
): Promise<{ value: T; started: string[] }> {
  const machine = new MachineLocalStore(path.join(checkout.dir, '.git'));
  const held = await machine.locks.acquire('tracker-write');
  if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
  const { asked } = nextTurnAtTheLock(forgetStarts);
  const pending = write();
  await asked;
  await meanwhile?.();
  await held.lock.release();
  return { value: await pending, started: started() };
}

/** A write budget no test here spends: the writes that hold or wait for the fairness lock aren't timed. */
export const UNHURRIED = { writeBudgetMs: 150_000 };
