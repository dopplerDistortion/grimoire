// Purge tombstones (spec §3 Delete and purge, §14 Purging one session record):
// `purges/<attempt-id>.md` for a purged trace,
// `purges/<attempt-id>/<session-key>.md` for one purged session record of an
// open attempt, and `purges/<proposal-id>.md` for a purged skill proposal. The frontmatter says who purged it, when and why; a session
// record's also says whether its facts went with the excerpt. When the facts
// were kept, the tombstone's body holds them: the record as it stood, without
// its excerpt text (excerpt status `purged`). The record itself is gone from
// the attempt either way, so no fold or write can bring its text back.
// Tombstones are add-only, and dominate every fold and every write path.
import { formatLine, lineValue, parseLines } from './lines';

/** What a session record's purge took: the excerpt alone (`kept`: the facts stay), or the excerpt with its facts. */
export type PurgedFacts = 'kept' | 'purged';

export interface PurgeTombstone {
  /** The person who purged it (git user.email). */
  readonly by: string;
  readonly at: string;
  readonly reason: string;
  /** A session record's only: whether its facts were kept. A tombstone that doesn't say took them. */
  readonly facts?: PurgedFacts;
  /** The kept facts: the session record without its text, as stored in the body; null when none were kept. */
  readonly kept: Buffer | null;
  readonly extra: Readonly<Record<string, string>>;
}

const KNOWN: ReadonlySet<string> = new Set(['by', 'at', 'reason', 'facts']);

export function serializePurge(tombstone: PurgeTombstone): Buffer {
  const lines = [formatLine('by', tombstone.by), formatLine('at', tombstone.at), formatLine('reason', tombstone.reason)];
  if (tombstone.facts !== undefined) lines.push(formatLine('facts', tombstone.facts));
  for (const key of Object.keys(tombstone.extra).sort()) if (!KNOWN.has(key)) lines.push(`${key}: ${tombstone.extra[key]}`);
  const head = Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
  return tombstone.kept && tombstone.facts === 'kept' ? Buffer.concat([head, tombstone.kept]) : head;
}

/** Reads a tombstone tolerantly: what it can't read comes back empty, a session tombstone without `facts` took them. */
export function parsePurge(bytes: Buffer): PurgeTombstone {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const str = (key: string) => {
    const value = values.get(key);
    return typeof value === 'string' ? value : '';
  };
  const facts = values.get('facts');
  const body = close < 0 ? Buffer.alloc(0) : bytes.subarray(Buffer.byteLength(text.slice(0, close + 5), 'utf8'));
  return {
    by: str('by'),
    at: str('at'),
    reason: str('reason'),
    ...(facts === 'kept' || facts === 'purged' ? { facts } : {}),
    kept: facts === 'kept' && body.length > 0 ? Buffer.from(body) : null,
    extra,
  };
}

/** Every purge tombstone a tree holds: traces by attempt handle, session records by handle, then session key, proposals by id. */
export interface PurgeIndex {
  readonly traces: ReadonlyMap<string, PurgeTombstone>;
  readonly sessions: ReadonlyMap<string, ReadonlyMap<string, PurgeTombstone>>;
  readonly proposals: ReadonlyMap<string, PurgeTombstone>;
}

export const NO_PURGES: PurgeIndex = { traces: new Map(), sessions: new Map(), proposals: new Map() };
