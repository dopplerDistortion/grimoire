import { setTimeout as sleep } from 'node:timers/promises';
import type { Json } from './docs';
import { isPidAlive, liveProcesses } from './process-info';
import { Held, holderOf, Slot, UNREADABLE_GRACE_MS, type Holder, type SlotState } from './slots';

export interface LockOptions {
  /** How long to wait for a held lock, in milliseconds (default 0: don't wait). */
  readonly waitMs?: number;
  /** Lapse after this long unless renewed (default: held while the holder process lives). */
  readonly ttlMs?: number;
  /** Extra fields for other processes to see (the `start` lock's port and nonce). */
  readonly data?: { readonly [key: string]: Json };
}

/** A lock this process holds: `renew(ttlMs)` and `release()`. */
export class Lock extends Held {}

export type LockResult =
  | { readonly status: 'acquired'; readonly lock: Lock }
  | { readonly status: 'held'; readonly holder: Holder };

export type LockState =
  | { readonly status: 'free' }
  | { readonly status: 'held'; readonly holder: Holder }
  /** Its holder process is gone (or it lapsed): the next acquirer takes it over. */
  | { readonly status: 'stale'; readonly holder: Holder | null };

export class LockHeldError extends Error {
  constructor(readonly holder: Holder) {
    super(`machine-local lock ${holder.name} is held by pid ${holder.pid} on ${holder.host}`);
    this.name = 'LockHeldError';
  }
}

/** How long a start-time verdict on a live pid is reused while polling. */
const LIVENESS_MEMO_MS = 2_000;
/** A hold younger than this, whose pid is alive, is taken to be live without a start-time check. */
const FRESH_HOLD_MS = 10_000;

/**
 * Exclusive locks, held while their holder process lives on this host (its pid
 * is there and its start time matches), until released, or until an optional
 * ttl lapses. Not reentrant: a second acquire in the same process is refused.
 */
export class Locks {
  private readonly liveness = new Map<string, { live: boolean; at: number }>();

  constructor(
    private readonly root: string,
    private readonly host: string,
  ) {}

  private slot(name: string): Slot {
    return new Slot(this.root, name, this.host);
  }

  /** Takes the lock, waiting up to `waitMs` while it is held. */
  async acquire(name: string, options: LockOptions = {}): Promise<LockResult> {
    const slot = this.slot(name);
    const deadline = Date.now() + (options.waitMs ?? 0);
    for (;;) {
      const result = await slot.take(
        {
          expires_at: options.ttlMs === undefined ? null : Date.now() + options.ttlMs,
          ...(options.data ? { data: options.data } : {}),
        },
        (state) => this.isStale(state),
      );
      if ('taken' in result) return { status: 'acquired', lock: new Lock(slot, result.taken) };
      if (Date.now() >= deadline) return { status: 'held', holder: holderOf(result.held) };
      await sleep(Math.min(20 + Math.random() * 40, Math.max(1, deadline - Date.now())));
    }
  }

  /** Runs `fn` holding the lock; throws LockHeldError if it stays held past `waitMs` (default 10 s). */
  async withLock<T>(name: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
    const result = await this.acquire(name, { waitMs: 10_000, ...options });
    if (result.status === 'held') throw new LockHeldError(result.holder);
    try {
      return await fn();
    } finally {
      await result.lock.release();
    }
  }

  /** The lock's state, without touching it. */
  async inspect(name: string): Promise<LockState> {
    const state = await this.slot(name).current();
    if (!state || state.holder?.released_at) return { status: 'free' };
    if (await this.isStale(state)) return { status: 'stale', holder: state.holder };
    return { status: 'held', holder: holderOf(state) };
  }

  private async isStale(state: SlotState): Promise<boolean> {
    const holder = state.holder;
    const now = Date.now();
    if (!holder) return now > state.mtimeMs + UNREADABLE_GRACE_MS;
    if (holder.released_at !== null) return true;
    if (holder.expires_at !== null && now > holder.expires_at) return true;
    if (holder.host !== this.host) return false;
    return !(await this.isLive(holder));
  }

  private async isLive(holder: Holder): Promise<boolean> {
    if (!isPidAlive(holder.pid)) return false;
    // For the pid to be reused, the holder must have died first; within moments
    // of taking the lock that is too unlikely to be worth asking the OS (which
    // costs a process spawn on some platforms). Older holds get the full check.
    const now = Date.now();
    if (now - holder.acquired_at < FRESH_HOLD_MS) return true;
    const key = `${holder.pid}:${holder.start_time}`;
    const memo = this.liveness.get(key);
    if (memo && now - memo.at < LIVENESS_MEMO_MS) return memo.live;
    const [live] = await liveProcesses([holder]);
    for (const [k, v] of this.liveness) if (now - v.at >= LIVENESS_MEMO_MS) this.liveness.delete(k);
    this.liveness.set(key, { live: live!, at: now });
    return live!;
  }
}
