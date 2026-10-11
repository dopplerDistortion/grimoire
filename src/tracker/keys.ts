// Idempotency keys (spec §3): `keys/<yyyy-mm>/<h2>/<sha256>.json`, scoped to
// the host repo's tracker, looked up first in every round, kept 30 days.
import { createHash } from 'node:crypto';
import { GrimoireError } from '../errors';
import { keyFile, KEYS_DIR } from './layout';
import { canonicalJson } from './lines';
import type { TrackerObjects } from './objects';

export const KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface Idempotency {
  /** The caller's key, unique per intended write. */
  readonly key: string;
  /** What the key promises stays the same on a replay; any JSON value. */
  readonly fingerprint: unknown;
}

interface StoredKey {
  at: string;
  op: string;
  fingerprint: string;
  result: unknown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The months a live key may have been written in: the last 30 days. */
function liveMonths(now: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(now.getTime() - KEY_LIFETIME_MS);
  cursor.setUTCDate(1);
  while (monthOf(cursor) <= monthOf(now)) {
    months.push(monthOf(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * The stored result for `idempotency` at the tree `root`: a replay. Null when
 * the key is unused or expired. IDEMPOTENCY_MISMATCH when the key was used
 * for another op or another fingerprint.
 */
export async function lookupKey(
  objects: TrackerObjects,
  root: string,
  op: string,
  idempotency: Idempotency,
  now: Date,
): Promise<{ result: unknown } | null> {
  const hash = sha256(idempotency.key);
  for (const month of liveMonths(now).reverse()) {
    const bytes = await objects.fileAt(root, keyFile(month, hash));
    if (!bytes) continue;
    const stored = JSON.parse(bytes.toString('utf8')) as StoredKey;
    if (now.getTime() - Date.parse(stored.at) > KEY_LIFETIME_MS) return null;
    if (stored.op !== op || stored.fingerprint !== sha256(canonicalJson(idempotency.fingerprint))) {
      throw new GrimoireError(
        'IDEMPOTENCY_MISMATCH',
        `the idempotency key was already used for a different ${stored.op}`,
        {},
      );
    }
    return { result: stored.result };
  }
  return null;
}

/**
 * The file edits that record `result` under the key, and prune every month
 * directory whose keys have all expired.
 */
export async function keyEdits(
  objects: TrackerObjects,
  root: string,
  op: string,
  idempotency: Idempotency,
  result: unknown,
  now: Date,
): Promise<Map<string, Uint8Array | null>> {
  const edits = new Map<string, Uint8Array | null>();
  const live = new Set(liveMonths(now));
  for (const entry of await objects.dirAt(root, KEYS_DIR)) {
    if (/^\d{4}-\d{2}$/.test(entry.name) && entry.name < monthOf(now) && !live.has(entry.name)) {
      edits.set(`${KEYS_DIR}/${entry.name}`, null);
    }
  }
  const stored: StoredKey = {
    at: now.toISOString(),
    op,
    fingerprint: sha256(canonicalJson(idempotency.fingerprint)),
    result,
  };
  edits.set(keyFile(monthOf(now), sha256(idempotency.key)), Buffer.from(`${JSON.stringify(stored)}\n`, 'utf8'));
  return edits;
}
