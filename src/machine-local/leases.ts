import type { Json } from './docs';
import { isPidAlive } from './process-info';
import { Held, holderOf, Slot, UNREADABLE_GRACE_MS, type Holder, type SlotState } from './slots';

export interface LeaseOptions {
  /** How long the lease lasts unless renewed, in milliseconds. */
  readonly ttlMs: number;
  /** Extra fields for other processes to see. */
  readonly data?: { readonly [key: string]: Json };
}

/** A lease this process holds: `renew(ttlMs)` and `release()`. */
export class Lease extends Held {}

export type LeaseResult =
  | { readonly status: 'acquired'; readonly lease: Lease }
  | { readonly status: 'held'; readonly holder: Holder };

export type LeaseState =
  | { readonly status: 'free' }
  | { readonly status: 'held'; readonly holder: Holder }
  /** Lapsed, or its holder process is gone: the next acquirer takes it over. */
  | { readonly status: 'expired'; readonly holder: Holder | null };

/**
 * Non-blocking, expiring leases: background work takes one and skips when it
 * is held (spec §13). A lease is free once released, once past its expiry, or
 * once its holder's pid is gone from this host.
 */
export class Leases {
  constructor(
    private readonly root: string,
    private readonly host: string,
  ) {}

  private slot(name: string): Slot {
    return new Slot(this.root, name, this.host);
  }

  /** Takes the lease if it is free, and never waits. */
  async acquire(name: string, options: LeaseOptions): Promise<LeaseResult> {
    const slot = this.slot(name);
    const result = await slot.take(
      { expires_at: Date.now() + options.ttlMs, ...(options.data ? { data: options.data } : {}) },
      async (state) => this.lapsed(state, Date.now()),
    );
    if ('taken' in result) return { status: 'acquired', lease: new Lease(slot, result.taken) };
    return { status: 'held', holder: holderOf(result.held) };
  }

  /** The lease's state, without touching it. */
  async inspect(name: string): Promise<LeaseState> {
    const state = await this.slot(name).current();
    if (!state || state.holder?.released_at) return { status: 'free' };
    if (this.lapsed(state, Date.now())) return { status: 'expired', holder: state.holder };
    return { status: 'held', holder: holderOf(state) };
  }

  private lapsed(state: SlotState, now: number): boolean {
    const holder = state.holder;
    if (!holder) return now > state.mtimeMs + UNREADABLE_GRACE_MS;
    if (holder.released_at !== null) return true;
    if (holder.expires_at !== null && now > holder.expires_at) return true;
    return holder.host === this.host && !isPidAlive(holder.pid);
  }
}
