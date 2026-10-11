// The issue record, `issues/<a>/<b>/<id>/issue.md` (spec §3): canonical
// frontmatter, then the body as verbatim bytes.
import { createHash } from 'node:crypto';
import { bareId } from './ids';
import { canonicalJson, formatLine, lineValue, parseLines } from './lines';

export interface IssueLink {
  /** A URL, a repo path or a git ref. */
  readonly target: string;
  readonly title: string;
}

export interface IssueRecord {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  /** `open`, `done` or `canceled`. */
  readonly status: string;
  /** Sorted, unique. */
  readonly labels: readonly string[];
  readonly parent: string | null;
  /** Sorted, unique. */
  readonly blocked_by: readonly string[];
  readonly links: readonly IssueLink[];
  readonly created_at: string;
  readonly created_by: string;
  readonly updated_at: string;
  /** Everything after the closing `---` line, byte for byte. */
  readonly body: string;
  /**
   * Frontmatter keys this release doesn't know, as their raw value text. They
   * are kept through every rewrite, after the known keys and sorted (ADR 0011).
   */
  readonly extra: Readonly<Record<string, string>>;
}

/** The known keys, in the order the canonical serializer writes them. */
const KNOWN_KEYS = [
  'id',
  'seq',
  'title',
  'status',
  'labels',
  'parent',
  'blocked_by',
  'links',
  'created_at',
  'created_by',
  'updated_at',
] as const;
const KNOWN = new Set<string>(KNOWN_KEYS);

/** Keys the revision ignores: identity and bookkeeping, never content (spec §3). */
const NOT_IN_REVISION = new Set(['id', 'seq', 'created_at', 'created_by', 'updated_at']);

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodePoint);
}

function canonicalLinks(links: readonly IssueLink[]): IssueLink[] {
  const seen = new Map<string, IssueLink>();
  for (const link of links) seen.set(canonicalJson([link.target, link.title]), link);
  return [...seen.values()]
    .sort((a, b) => byCodePoint(a.target, b.target) || byCodePoint(a.title, b.title))
    .map((link) => ({ target: link.target, title: link.title }));
}

function knownValues(record: IssueRecord): Record<(typeof KNOWN_KEYS)[number], unknown> {
  return {
    // A record kept apart by a collision lives under `<id>~<hash4>`, but keeps the id it was minted as.
    id: bareId(record.id),
    seq: record.seq,
    title: record.title,
    status: record.status,
    labels: sortedUnique(record.labels),
    parent: record.parent,
    blocked_by: sortedUnique(record.blocked_by),
    links: canonicalLinks(record.links),
    created_at: record.created_at,
    created_by: record.created_by,
    updated_at: record.updated_at,
  };
}

/** The canonical serializer: fixed key order, JSON values, unknown keys sorted last, verbatim body. */
export function serializeIssue(record: IssueRecord): Buffer {
  const known = knownValues(record);
  const lines = KNOWN_KEYS.map((key) => formatLine(key, known[key]));
  for (const key of Object.keys(record.extra).sort(byCodePoint)) {
    if (!KNOWN.has(key)) lines.push(`${key}: ${record.extra[key]}`);
  }
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${record.body}`, 'utf8');
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asLinks(value: unknown): IssueLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v: unknown) => {
    if (v === null || typeof v !== 'object') return [];
    const { target, title } = v as Record<string, unknown>;
    return typeof target === 'string' ? [{ target, title: asString(title) }] : [];
  });
}

export function parseIssue(bytes: Buffer): IssueRecord {
  const text = bytes.toString('utf8');
  if (!text.startsWith('---\n')) throw new Error('issue record has no frontmatter');
  const close = text.indexOf('\n---\n', 3);
  const closeAtEnd = text.endsWith('\n---') ? text.length - 4 : -1;
  const end = close >= 0 ? close : closeAtEnd;
  if (end < 0) throw new Error('issue record frontmatter is not closed');
  const body = close >= 0 ? text.slice(close + 5) : '';
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of parseLines(text.slice(4, end))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const parent = values.get('parent');
  const seq = values.get('seq');
  return {
    id: asString(values.get('id')),
    seq: typeof seq === 'number' ? seq : 0,
    title: asString(values.get('title')),
    status: asString(values.get('status'), 'open'),
    labels: sortedUnique(asStrings(values.get('labels'))),
    parent: typeof parent === 'string' ? parent : null,
    blocked_by: sortedUnique(asStrings(values.get('blocked_by'))),
    links: asLinks(values.get('links')),
    created_at: asString(values.get('created_at')),
    created_by: asString(values.get('created_by')),
    updated_at: asString(values.get('updated_at')),
    body,
    extra,
  };
}

/**
 * The revision: sha256 (hex) of the canonical JSON of every frontmatter key
 * except id, seq, created_at, created_by and updated_at (unknown keys included,
 * by their JSON value), then a newline, then the body's UTF-8 bytes. Opaque to
 * callers; equal on every release that keeps the same keys (ADR 0011).
 */
export function issueRevision(record: IssueRecord): string {
  const content: Record<string, unknown> = {};
  const known = knownValues(record);
  for (const key of KNOWN_KEYS) if (!NOT_IN_REVISION.has(key)) content[key] = known[key];
  for (const [key, raw] of Object.entries(record.extra)) {
    if (!KNOWN.has(key)) content[key] = lineValue(raw);
  }
  return createHash('sha256').update(`${canonicalJson(content)}\n`, 'utf8').update(record.body, 'utf8').digest('hex');
}

/**
 * Which record this is when one id was minted on two clones: 4 hex characters
 * of the sha256 of what never changes about a record (when and by whom it was
 * created). A collision keeps each record under `<id>~<hash4>`.
 */
export function collisionHash(record: IssueRecord): string {
  return createHash('sha256').update(`${record.created_at}\n${record.created_by}`, 'utf8').digest('hex').slice(0, 4);
}
