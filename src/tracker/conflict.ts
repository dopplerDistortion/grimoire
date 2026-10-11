// Conflict records (spec §3 Layout, §4 Fold rules): what a fold set aside when
// both clones changed the same field of an issue, written once at
// `issues/<a>/<b>/<id>/conflicts/<hash>.md`, where the hash is of the record's
// own bytes. The fold never reads the clock, so every clone writes the same
// record for the same concurrent change. Resolving (a human op) removes it.
import { createHash } from 'node:crypto';
import { formatLine, lineValue, parseLines } from './lines';

/** The field a delete-against-edit conflict names: the issue was deleted on one side, edited on the other. */
export const DELETED_FIELD = 'deleted';

export interface ConflictRecord {
  /** The conflicted fields, sorted. */
  readonly fields: readonly string[];
  /** Each field's value as the fold kept it. */
  readonly kept: Readonly<Record<string, unknown>>;
  /** Each field's value the fold set aside. */
  readonly theirs: Readonly<Record<string, unknown>>;
  /** Each field's value before both changes. */
  readonly base: Readonly<Record<string, unknown>>;
  /** When the set-aside change was made (its side's `updated_at`). */
  readonly at: string;
  /** Keys this release doesn't know, kept raw. */
  readonly extra: Readonly<Record<string, string>>;
}

const KNOWN = new Set(['fields', 'kept', 'theirs', 'base', 'at']);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function serializeConflict(conflict: Omit<ConflictRecord, 'extra'>): Buffer {
  const lines = [
    formatLine('fields', [...conflict.fields].sort()),
    formatLine('kept', conflict.kept),
    formatLine('theirs', conflict.theirs),
    formatLine('base', conflict.base),
    formatLine('at', conflict.at),
  ];
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

export function parseConflict(bytes: Buffer): ConflictRecord {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const fields = values.get('fields');
  const at = values.get('at');
  return {
    fields: Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string').sort() : [],
    kept: record(values.get('kept')),
    theirs: record(values.get('theirs')),
    base: record(values.get('base')),
    at: typeof at === 'string' ? at : '',
    extra,
  };
}

/** The record's file name, without `.md`: the sha256 of its bytes. */
export function conflictName(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
