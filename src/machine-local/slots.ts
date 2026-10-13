import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createFileExclusive, readTextIfExists, removeFile } from './fs-atomic';
import type { Json } from './docs';
import { fileNameForKey } from './names';
import { currentHost, currentProcessStartTime } from './process-info';

// A slot is the shared mechanism under leases and locks: one directory per
// name, holding generation files `<n>.json`. The highest generation is the
// current holder. Taking a free slot means creating generation n+1 with an
// exclusive create, so of any number of racers exactly one succeeds. The
// highest generation file is never deleted (a release writes a released one above it),
// so generations only grow and a racer working from an old listing can't slip
// in under the current holder: it either meets an existing file, or finds a
// higher generation when it re-lists, and backs off. A holder's renew and
// release write the next generation the same way, never over the current one:
// on Windows a file can't be renamed over while anyone has it open, and with
// many waiters polling a lock, one of them nearly always is reading it.

/** Who holds a lease or a lock: the bytes of a generation file. Version-free. */
export interface Holder {
  /** The lease or lock name, as the caller gave it. */
  readonly name: string;
  /** A random id for this one acquisition. */
  readonly owner: string;
  readonly pid: number;
  /** The holder process's start time, epoch ms. */
  readonly start_time: number;
  readonly host: string;
  /** Epoch ms. */
  readonly acquired_at: number;
  /** Epoch ms after which the hold lapses, or null for no expiry. */
  readonly expires_at: number | null;
  /** Epoch ms when the holder let go, or null while held. */
  readonly released_at: number | null;
  /** Anything else the holder wants others to see. */
  readonly data?: { readonly [key: string]: Json };
}

export interface SlotState {
  readonly gen: number;
  /** null when the generation file can't be read yet (or ever). */
  readonly holder: Holder | null;
  /** When the generation file was last written, epoch ms. */
  readonly mtimeMs: number;
}

/** How long a generation file that can't be parsed counts as held. */
export const UNREADABLE_GRACE_MS = 30_000;

export interface NewHolder {
  readonly expires_at: number | null;
  readonly data?: { readonly [key: string]: Json };
}

export class Slot {
  readonly dir: string;

  constructor(
    root: string,
    readonly name: string,
    private readonly host: string = currentHost(),
    /** The slot's folder under `root`: the name's own, unless a listing found it. */
    folder: string = fileNameForKey(name),
  ) {
    this.dir = path.join(root, folder);
  }

  private genFile(gen: number): string {
    return path.join(this.dir, `${gen}.json`);
  }

  private async gens(): Promise<number[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    return names
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** The current generation, or null if the slot has never been taken. */
  async current(): Promise<SlotState | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const gens = await this.gens();
      const gen = gens[gens.length - 1];
      if (gen === undefined) return null;
      const file = this.genFile(gen);
      const [text, info] = await Promise.all([
        readTextIfExists(file),
        stat(file).catch(() => null),
      ]);
      // Pruned between the listing and the read: a higher generation exists.
      if (text === undefined || !info) continue;
      return { gen, holder: parseHolder(text), mtimeMs: info.mtimeMs };
    }
    return null;
  }

  /**
   * Takes the slot if `isFree` says its current holder no longer holds it.
   * Returns the new holder, or the current state when it is held.
   */
  async take(
    fresh: NewHolder,
    isFree: (state: SlotState) => Promise<boolean>,
  ): Promise<{ taken: Holder } | { held: SlotState }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.current();
      if (state && !(await isFree(state))) return { held: state };
      const gen = (state?.gen ?? 0) + 1;
      const now = Date.now();
      const holder: Holder = {
        name: this.name,
        owner: randomBytes(12).toString('hex'),
        pid: process.pid,
        start_time: currentProcessStartTime(),
        host: this.host,
        acquired_at: now,
        expires_at: fresh.expires_at,
        released_at: null,
        ...(fresh.data ? { data: fresh.data } : {}),
      };
      if (!(await this.writeNext(gen, holder))) continue; // a racer from an old listing: back off
      return { taken: holder };
    }
    const state = await this.current();
    if (state) return { held: state };
    throw new Error(`could not take machine-local slot ${this.name}`);
  }

  /**
   * Writes the holder's change as the next generation, if it still holds the
   * slot. Returns false when someone else has taken it since.
   */
  async rewrite(owner: string, change: (holder: Holder) => Holder): Promise<boolean> {
    const state = await this.current();
    if (!state?.holder || state.holder.owner !== owner) return false;
    return this.writeNext(state.gen + 1, change(state.holder));
  }

  /**
   * Creates generation `gen` holding `holder` and prunes the ones below it.
   * False when the generation exists, or a higher one appeared meanwhile.
   */
  private async writeNext(gen: number, holder: Holder): Promise<boolean> {
    if (!(await createFileExclusive(this.genFile(gen), serialize(holder)))) return false;
    const gens = await this.gens();
    if (gens[gens.length - 1] !== gen) return false;
    await Promise.all(gens.filter((g) => g < gen).map((g) => removeFile(this.genFile(g)).catch(() => false)));
    return true;
  }
}

function serialize(holder: Holder): string {
  return `${JSON.stringify(holder)}\n`;
}

function parseHolder(text: string): Holder | null {
  try {
    const value = JSON.parse(text) as Partial<Holder> | null;
    if (
      !value ||
      typeof value.owner !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.host !== 'string'
    ) {
      return null;
    }
    return {
      ...value,
      start_time: typeof value.start_time === 'number' ? value.start_time : 0,
      acquired_at: typeof value.acquired_at === 'number' ? value.acquired_at : 0,
      expires_at: typeof value.expires_at === 'number' ? value.expires_at : null,
      released_at: typeof value.released_at === 'number' ? value.released_at : null,
    } as Holder;
  } catch {
    return null;
  }
}

/** A lease or lock this process holds. */
export class Held {
  constructor(
    private readonly slot: Slot,
    /** The holder as written when it was taken. */
    readonly holder: Holder,
  ) {}

  get name(): string {
    return this.slot.name;
  }

  /** Moves the expiry to `ttlMs` from now; false if someone else has taken it since. */
  renew(ttlMs: number): Promise<boolean> {
    return this.slot.rewrite(this.holder.owner, (h) => ({ ...h, expires_at: Date.now() + ttlMs }));
  }

  /** Lets go. A no-op if someone else has taken it since. */
  async release(): Promise<void> {
    await this.slot.rewrite(this.holder.owner, (h) => ({ ...h, released_at: Date.now() }));
  }
}

/**
 * The names of the slots under `root` that have ever been taken, read from
 * their current holders (a slot's folder name may be a hash of its name). A
 * slot whose holder can't be read yet is left out: it lapses on its own.
 */
export async function slotNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const folder of (await readdir(root).catch(() => [] as string[])).sort()) {
    // Read the folder as listed: a hashed folder name is no slot name of its own.
    const state = await new Slot(root, folder, undefined, folder).current().catch(() => null);
    const name = state?.holder?.name;
    if (typeof name === 'string' && name !== '' && fileNameForKey(name) === folder) names.push(name);
  }
  return names;
}

/** A held slot whose file isn't readable yet is reported with a placeholder holder. */
export function holderOf(state: SlotState): Holder {
  return (
    state.holder ?? {
      name: '',
      owner: '',
      pid: 0,
      start_time: 0,
      host: '',
      acquired_at: state.mtimeMs,
      expires_at: state.mtimeMs + UNREADABLE_GRACE_MS,
      released_at: null,
    }
  );
}
