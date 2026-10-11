// Locks around tracker writes (spec §4, Write path).
//
// - An in-process FIFO queue: concurrent calls inside one process take turns.
// - The fairness lock: advisory, per clone, machine-local, heartbeated. It only
//   keeps writers from wasting compare-and-set rounds on each other; correctness
//   never depends on it. It is never reentrant by PID: every holder, even in the
//   same process, needs its own acquisition.
import { GrimoireError } from '../errors';
import { MachineLocalStore, type LockResult, type Locks } from '../machine-local';

/** Resolves when `ms` have passed. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Waiter {
  wake(): void;
  gaveUp: boolean;
}

/** A FIFO mutex whose waiters give up at a deadline. */
export class Turnstile {
  private busy = false;
  private readonly waiters: Waiter[] = [];

  /** Runs `task` once every earlier task has finished; null if `deadline` passes first. */
  async run<T>(deadline: number, task: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.busy && !(await this.wait(deadline))) return null;
    this.busy = true;
    try {
      return { value: await task() };
    } finally {
      this.handOff();
    }
  }

  private wait(deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        gaveUp: false,
        wake: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        waiter.gaveUp = true;
        resolve(false);
      }, Math.max(0, deadline - Date.now()));
      this.waiters.push(waiter);
    });
  }

  /** Passes the turn to the next waiter still waiting (staying busy), or frees the turnstile. */
  private handOff(): void {
    for (let next = this.waiters.shift(); next; next = this.waiters.shift()) {
      if (!next.gaveUp) return next.wake();
    }
    this.busy = false;
  }
}

export const HEARTBEAT_MS = 2_000;
/** A fairness lock with no heartbeat for this long has lapsed; the next writer takes it over. */
export const ABANDONED_AFTER_MS = 4 * HEARTBEAT_MS;
/** The fairness lock's name among the machine-local locks. */
export const FAIRNESS_LOCK = 'tracker-write';

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * The tracker fairness lock: the machine-local lock `tracker-write`
 * (`<git-common-dir>/grimoire/locks/tracker-write/`), held while its holder
 * lives and renewed every ~2 s. Not reentrant, even within one process.
 */
export class FairnessLock {
  private readonly locks: Locks;

  constructor(commonDir: string) {
    this.locks = new MachineLocalStore(commonDir).locks;
  }

  /** Waits for the lock until `deadline`; null when it is still held then. */
  async acquire(deadline: number): Promise<HeldLock | null> {
    let result: LockResult;
    try {
      result = await this.locks.acquire(FAIRNESS_LOCK, {
        waitMs: Math.max(0, deadline - Date.now()),
        ttlMs: ABANDONED_AFTER_MS,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EROFS') {
        throw new GrimoireError('NOT_WRITABLE', `this process can't write the live store (${code})`, {});
      }
      throw error;
    }
    if (result.status === 'held') return null;
    const { lock } = result;
    const heartbeat = setInterval(() => void lock.renew(ABANDONED_AFTER_MS).catch(() => {}), HEARTBEAT_MS);
    heartbeat.unref();
    return {
      release: async () => {
        clearInterval(heartbeat);
        await lock.release().catch(() => {});
      },
    };
  }
}
