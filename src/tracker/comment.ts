// Comments (spec §3, Comments): one write-once file per comment,
// `issues/<a>/<b>/<id>/comments/<utc-ms>-<n>-<rand4>.md`, never edited or
// deleted. Frontmatter: actor, at, kind, an optional attempt and the key hash.
import { randomBytes } from 'node:crypto';
import { ID_ALPHABET } from './ids';
import { formatLine, lineValue, parseLines } from './lines';

export type CommentKind = 'comment' | 'debrief';

export interface IssueComment {
  /** The file name without `.md`: `<utc-ms>-<n>-<rand4>`. */
  readonly id: string;
  /** ISO time; forced monotonic per issue, so comments order by it. */
  readonly at: string;
  readonly kind: string;
  /** Who wrote it: the person's email, plus the agent facts when an agent wrote it. */
  readonly actor: Readonly<Record<string, unknown>>;
  readonly attempt?: string;
  /** sha256 of the idempotency key it was written under. */
  readonly key?: string;
  /** Everything after the closing `---` line, byte for byte. */
  readonly body: string;
}

/** Where a comment sits in its issue's order, from its file name alone. */
export interface CommentEntry {
  readonly id: string;
  readonly at: string;
  readonly ms: number;
  readonly n: number;
}

const NAME = /^(\d{8})T(\d{6})(\d{3})Z-(\d+)-([0-9a-z]+)$/;

/** `20261011T031508750Z`: compact UTC with milliseconds, no `:`. */
export function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '');
}

/** The entry a comment file name (without `.md`) describes, or null when it isn't one. */
export function commentEntry(id: string): CommentEntry | null {
  const match = NAME.exec(id);
  if (!match) return null;
  const [, date, time, millis, n] = match;
  const iso = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6)}T${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4)}.${millis}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { id, at: new Date(ms).toISOString(), ms, n: Number(n) };
}

/** Comment order: time, then `n` (the order within one commit), then the name. */
export function byCommentOrder(a: CommentEntry, b: CommentEntry): number {
  return a.ms - b.ms || a.n - b.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function commentName(ms: number, n: number): string {
  const rand = [...randomBytes(4)].map((byte) => ID_ALPHABET[byte & 31]).join('');
  return `${compactUtc(ms)}-${n}-${rand}`;
}

export function serializeComment(comment: Omit<IssueComment, 'id'>): Buffer {
  const lines = [formatLine('actor', comment.actor), formatLine('at', comment.at), formatLine('kind', comment.kind)];
  if (comment.attempt !== undefined) lines.push(formatLine('attempt', comment.attempt));
  if (comment.key !== undefined) lines.push(formatLine('key', comment.key));
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${comment.body}`, 'utf8');
}

export function parseComment(id: string, bytes: Buffer): IssueComment {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map(
    close < 0 ? [] : parseLines(text.slice(4, close)).map(({ key, raw }) => [key, lineValue(raw)] as const),
  );
  const str = (key: string) => {
    const value = values.get(key);
    return typeof value === 'string' ? value : undefined;
  };
  const actor = values.get('actor');
  const attempt = str('attempt');
  const key = str('key');
  return {
    id,
    at: str('at') ?? commentEntry(id)?.at ?? '',
    kind: str('kind') ?? 'comment',
    actor: actor !== null && typeof actor === 'object' && !Array.isArray(actor) ? (actor as Record<string, unknown>) : {},
    ...(attempt !== undefined ? { attempt } : {}),
    ...(key !== undefined ? { key } : {}),
    body: close < 0 ? text : text.slice(close + 5),
  };
}
