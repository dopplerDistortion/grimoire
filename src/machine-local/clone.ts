// A clone's machine-local identity (spec §20): one hash of the git common
// dir's real path names the dashboard's session cookie and derives its default
// port, so every worktree and process of a clone agrees on both.
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { DocStore } from './docs';

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

const TAG = /^[0-9a-f]{16}$/;

/**
 * This clone's tag: a random id kept in the machine-local records, made on
 * first use. Committed knowledge records carry it, so provenance can tell a
 * local decision from another clone's without committing anything about the
 * machine.
 */
export async function cloneTag(records: DocStore): Promise<string> {
  const known = await records.read<string>('clone', 'tag');
  if (typeof known === 'string' && TAG.test(known)) return known;
  const made = await records.update<string>('clone', 'tag', (current) =>
    typeof current === 'string' && TAG.test(current) ? current : randomBytes(8).toString('hex'),
  );
  return made!;
}
