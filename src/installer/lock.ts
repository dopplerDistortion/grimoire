// The exclusive install lock (spec §11): every change to `pkg/` and to the
// launcher happens under it, so two `init`s on one clone never interleave.
import { GrimoireError } from '../errors';
import type { MachineLocalStore } from '../machine-local';

/** The machine-local lock name (coordination, frozen). */
export const INSTALL_LOCK = 'install';

/** How long an install waits for another to finish: a copy is a few MB on a local disk. */
const INSTALL_WAIT_MS = 120_000;

/** Runs `fn` holding the install lock; BUSY when another install keeps it past the wait. */
export async function withInstallLock<T>(store: MachineLocalStore, fn: () => Promise<T>): Promise<T> {
  const result = await store.locks.acquire(INSTALL_LOCK, { waitMs: INSTALL_WAIT_MS });
  if (result.status === 'held') {
    throw new GrimoireError('BUSY', `another grimoire install is running in this clone (pid ${result.holder.pid} on ${result.holder.host})`, {
      holder: { pid: result.holder.pid, host: result.holder.host },
    });
  }
  try {
    return await fn();
  } finally {
    await result.lock.release();
  }
}
