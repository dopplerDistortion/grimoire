// Locks around tracker writes (spec §4, Write path).
//
// - An in-process FIFO queue: concurrent calls inside one process take turns.
// - The fairness lock: advisory, per clone, machine-local, heartbeated. It only
//   keeps writers from wasting compare-and-set rounds on each other; correctness
//   never depends on it. It is never reentrant by PID: every holder, even in the
//   same process, needs its own acquisition.
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';

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
/** A fairness lock with no heartbeat for this long is abandoned; the next writer takes it over. */
export const ABANDONED_AFTER_MS = 4 * HEARTBEAT_MS;

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * The tracker fairness lock: a file created exclusively under
 * `<git-common-dir>/grimoire/locks/`, holding `{token, pid, at}` as JSON, with
 * its mtime refreshed every ~2 s while held. Part of the frozen cross-pin
 * coordination data (spec §6).
 */
export class FairnessLock {
  readonly file: string;

  constructor(commonDir: string) {
    this.file = path.join(commonDir, 'grimoire', 'locks', 'tracker-write.lock');
  }

  /** Waits for the lock until `deadline`; null when it is still held then. */
  async acquire(deadline: number): Promise<HeldLock | null> {
    const token = randomBytes(8).toString('hex');
    let dirReady = false;
    for (;;) {
      try {
        if (!dirReady) {
          await mkdir(path.dirname(this.file), { recursive: true });
          dirReady = true;
        }
        const handle = await open(this.file, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          await handle.close();
        }
        return this.held(token);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EROFS') {
          throw new GrimoireError('NOT_WRITABLE', `this process can't write the live store (${code})`, {});
        }
        // EPERM: Windows reports a file in delete-pending state this way.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') throw error;
      }
      if (await this.abandoned()) {
        await unlink(this.file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return null;
      await sleep(2 + Math.random() * 8);
    }
  }

  private async abandoned(): Promise<boolean> {
    try {
      const info = await stat(this.file);
      return Date.now() - info.mtimeMs > ABANDONED_AFTER_MS;
    } catch {
      return false;
    }
  }

  private held(token: string): HeldLock {
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(this.file, now, now).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref();
    return {
      release: async () => {
        clearInterval(heartbeat);
        try {
          const content = JSON.parse(await readFile(this.file, 'utf8')) as { token?: string };
          if (content.token === token) await unlink(this.file);
        } catch {
          // Already gone, or taken over after we looked abandoned: nothing of ours to remove.
        }
      },
    };
  }
}
