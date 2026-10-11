// Session records (spec §3 The attempt directory, §14 Pending session records,
// Statuses): one `sessions/<session-key>.md` per attempt × bound context,
// written while the attempt is open and frozen by its seal. The frontmatter is
// the context's entry, written in every mode, plus the facts slices; the body
// is the excerpt text, in `excerpts` mode only. Everything is redacted before
// it is written: the excerpt went through the scanner, and paths through the
// home and repo rewrite. Keys this release doesn't know are kept.
import { formatLine, lineValue, parseLines } from '../tracker/lines';
import { compareReach, type Reach } from '../tracker/fold-records';
import type { EvidenceSource } from './evidence';
import type { ExcerptStatus } from './cut';
import type { StepOrigin } from './steps';

/**
 * The excerpt statuses a record carries (spec §14 Statuses): a cut's, plus
 * - `off`: the mode commits no excerpt text (`facts`, `none`, or the machine
 *   cap, noted `capped`);
 * - `no_transcript`: a context with no transcript to cut (a generic client);
 * - `purged`: a human purged the record (read from its tombstone, never written).
 */
export type RecordExcerptStatus = ExcerptStatus | 'off' | 'no_transcript' | 'purged';

/**
 * - `tail_unflushed`: a binding call was past the transcript's flushed end;
 * - `source: pending`: the seal kept the pending record over its own cut;
 * - `capped`: this machine's `capture.excerpts_max` turned the excerpt off.
 */
export type RecordNote = 'tail_unflushed' | 'source: pending' | 'capped';

/**
 * The facts statuses (spec §14 Statuses); `facts_complete` needs every bound
 * context `scanned`. `partial`: a cut that found no window to scan, every
 * binding call being past the transcript's flushed end.
 */
export type FactsStatus = 'scanned' | 'events_only' | 'not_found' | 'unreadable' | 'unmatched' | 'budget' | 'partial' | 'purged';

export interface SessionRecord {
  /** The client family (`claude-code`, `codex`) or the client's own name. */
  readonly client: string;
  readonly client_version: string | null;
  /** The transcript reader's version; null when no transcript was read. */
  readonly reader_version: number | null;
  readonly session: string | null;
  readonly context: string | null;
  /** Which identity source settled the session. */
  readonly source: EvidenceSource | null;
  readonly window_start: StepOrigin | null;
  readonly window_end: StepOrigin | null;
  /** Steps in the window. */
  readonly steps: number;
  /** Steps the excerpt shows. */
  readonly steps_kept: number;
  /** The excerpt's length. */
  readonly characters: number;
  readonly excerpt: RecordExcerptStatus;
  readonly excerpt_notes: readonly RecordNote[];
  readonly facts: FactsStatus;
  /** The skill reads slice (`{name, version, via, at, session, context}`): filled by the skill-read facts. */
  readonly skills_read: readonly unknown[];
  /** The observed and referenced commits slice: filled by the commit facts. */
  readonly commits: readonly unknown[];
  /**
   * How far the cut reached: its last step (time and line uuid or ordinal),
   * or for a facts-only record the latest `skill_read` event's time and the
   * event count. A record is replaced only by a successful cut reaching
   * strictly further.
   */
  readonly reach: Reach | null;
  /** When the cut was made: a cut made after the attempt ended never counts. */
  readonly cut_at: string;
  /** For a transcript that wasn't found: the roots searched, home and repo rewritten. */
  readonly roots: readonly string[];
  /** The excerpt text; null in `facts` and `none` mode and whenever no excerpt was cut. */
  readonly text: string | null;
  readonly extra: Readonly<Record<string, string>>;
}

const KEYS = [
  'client',
  'client_version',
  'reader_version',
  'session',
  'context',
  'source',
  'window_start',
  'window_end',
  'steps',
  'steps_kept',
  'characters',
  'excerpt',
  'excerpt_notes',
  'facts',
  'skills_read',
  'commits',
  'reach',
  'cut_at',
  'roots',
] as const;
const KNOWN: ReadonlySet<string> = new Set(KEYS);

export function serializeSessionRecord(record: SessionRecord): Buffer {
  const lines: string[] = KEYS.map((key) => formatLine(key, record[key]));
  for (const key of Object.keys(record.extra).sort()) if (!KNOWN.has(key)) lines.push(`${key}: ${record.extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${record.text ?? ''}`, 'utf8');
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const origin = (value: unknown): StepOrigin | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { at, ref } = value as { at?: unknown; ref?: unknown };
  if (typeof at !== 'string') return null;
  return { at, ref: typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref : '' };
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Reads a session record; what it can't read comes back empty, and unknown keys are kept. */
export function parseSessionRecord(bytes: Buffer): SessionRecord {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const body = close < 0 ? '' : text.slice(close + 5);
  const readerVersion = values.get('reader_version');
  return {
    client: str(values.get('client')) ?? 'unknown',
    client_version: str(values.get('client_version')),
    reader_version: typeof readerVersion === 'number' ? readerVersion : null,
    session: str(values.get('session')),
    context: str(values.get('context')),
    source: str(values.get('source')) as EvidenceSource | null,
    window_start: origin(values.get('window_start')),
    window_end: origin(values.get('window_end')),
    steps: num(values.get('steps')),
    steps_kept: num(values.get('steps_kept')),
    characters: num(values.get('characters')),
    excerpt: (str(values.get('excerpt')) ?? 'not_found') as RecordExcerptStatus,
    excerpt_notes: list(values.get('excerpt_notes')).filter((note): note is RecordNote => typeof note === 'string'),
    facts: (str(values.get('facts')) ?? 'not_found') as FactsStatus,
    skills_read: list(values.get('skills_read')),
    commits: list(values.get('commits')),
    reach: origin(values.get('reach')),
    cut_at: str(values.get('cut_at')) ?? '',
    roots: list(values.get('roots')).filter((root): root is string => typeof root === 'string'),
    text: body === '' ? null : body,
    extra,
  };
}

/**
 * Whether a record came from a cut that succeeded: it reached somewhere, and
 * nothing went wrong with its excerpt (cut, or none by the mode) or its facts
 * (scanned, or a facts-only record's events).
 */
export function cutSucceeded(record: Pick<SessionRecord, 'excerpt' | 'facts' | 'reach'>): boolean {
  if (record.reach === null) return false;
  if (record.excerpt === 'cut') return true;
  return (record.excerpt === 'off' || record.excerpt === 'no_transcript') && (record.facts === 'scanned' || record.facts === 'events_only');
}

/** Whether `fresh` may replace `stored` (spec §14): it succeeded, and it reaches strictly further. */
export function replaces(fresh: SessionRecord, stored: SessionRecord | null): boolean {
  return cutSucceeded(fresh) && (stored === null || compareReach(fresh.reach, stored.reach) > 0);
}
