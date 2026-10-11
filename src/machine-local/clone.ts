// A clone's machine-local identity (spec §20): one hash of the git common
// dir's real path names the dashboard's session cookie and derives its default
// port, so every worktree and process of a clone agrees on both.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

/** The machine-local lock `start` holds while it serves the dashboard (coordination, frozen). */
export const START_LOCK = 'start';

/** What the `start` lock shows other processes, beside the holder's pid, start time and host. */
export interface StartLockData {
  readonly port: number;
  readonly nonce: string;
}

const DEFAULT_PORT_BASE = 47_000;
const DEFAULT_PORT_SPAN = 1_000;

/** sha256 (hex) of the git common dir's real path: the per-clone id. */
export async function cloneId(commonDir: string): Promise<string> {
  const real = await realpath(commonDir).catch(() => commonDir);
  return createHash('sha256').update(real, 'utf8').digest('hex');
}

/** The clone's default dashboard port: 47000–47999, from the per-clone id. */
export async function defaultDashboardPort(commonDir: string): Promise<number> {
  const id = await cloneId(commonDir);
  return DEFAULT_PORT_BASE + (Number.parseInt(id.slice(0, 8), 16) % DEFAULT_PORT_SPAN);
}
