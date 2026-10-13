// The skill ledger's records (spec §18, The skill ledger): append-only,
// write-once and content-addressed, at `knowledge/ledger/<sha256>.md`, written
// only by grimoire's code. Each record is frontmatter in the tracker's shared
// line format, known keys first in a fixed order, then any key this release
// doesn't know (kept, sorted; ADR 0011).
//
// Nothing aggregated is committed: which version is current, forks, contested
// decisions and blocked names are derived from the records on read
// (derive.ts). The fold needs no rule of its own: records never change, so two
// clones' ledgers fold to their union.
import { createHash } from 'node:crypto';
import { sortedUnique, type RecordProblem } from '../tracker';
import { formatLine, lineValue, parseLines } from '../tracker/lines';

/**
 * Record kinds this release derives from (spec §18): decisions on a proposal
 * (`accept` with per-flag acknowledgements, `reject`, `dismiss`,
 * `reconsider`), skill changes (`edit` by a human, `record` of a stray edit,
 * `restore`, `delete`, `eject`, `acknowledge`), `unblock`, the lift of a
 * name block, and `lapse`: an accept whose accept-time checks failed, so the
 * proposal lapsed (its reason codes in `reason`, comma-separated). A kind this
 * release doesn't know plays no part in a derivation.
 */
export type LedgerKind =
  | 'accept'
  | 'reject'
  | 'dismiss'
  | 'reconsider'
  | 'edit'
  | 'record'
  | 'restore'
  | 'delete'
  | 'eject'
  | 'acknowledge'
  | 'unblock'
  | 'lapse';

export interface LedgerRecord {
  readonly kind: string;
  /** The evolved skill's name. */
  readonly skill: string;
  /** Decisions: the proposal decided. */
  readonly proposal?: string;
  /** A reject's reason code (`suspicious`, `incorrect`, …). */
  readonly reason?: string;
  /** A reject's own words, with the reason `other` (secret-scanned before it is written). */
  readonly note?: string;
  /** An accept's acknowledged red flags. */
  readonly acks?: readonly string[];
  /** The version current before the change, as the actor saw it (null: none). */
  readonly from: string | null;
  /** The version the change makes current (null: none, as after a delete). */
  readonly to: string | null;
  /**
   * The ids of this skill's ledger records nothing else followed when the
   * actor acted (its heads): what the record comes after. Folds never use the
   * clock, so this is how one record is known to follow another.
   */
  readonly after: readonly string[];
  /** The versions the actor was shown. */
  readonly saw: readonly string[];
  /** `human review` in v1; `policy` is reserved. */
  readonly basis: string;
  /** The surface the change came from: `cli`, `dashboard`, … */
  readonly surface: string;
  readonly actor: Readonly<Record<string, unknown>>;
  /** The person (an email). */
  readonly by: string;
  /** The clone it was made in: an opaque id, so provenance can tell a local decision from another clone's. */
  readonly clone: string;
  readonly at: string;
  /** Keys this release doesn't know, as their raw value text. */
  readonly extra: Readonly<Record<string, string>>;
}

/** A record as read, with its id: the sha256 of its bytes. */
export interface LedgerEntry extends LedgerRecord {
  readonly id: string;
}

const KNOWN_KEYS = [
  'kind',
  'skill',
  'proposal',
  'reason',
  'note',
  'acks',
  'from',
  'to',
  'after',
  'saw',
  'basis',
  'surface',
  'actor',
  'by',
  'clone',
  'at',
] as const;
const KNOWN = new Set<string>(KNOWN_KEYS);

/** The bytes of a record: its known keys in order (optional ones only when set), then the unknown ones. */
export function serializeLedgerRecord(record: LedgerRecord): Buffer {
  const values: Record<string, unknown> = {
    kind: record.kind,
    skill: record.skill,
    proposal: record.proposal,
    reason: record.reason,
    note: record.note,
    acks: record.acks === undefined ? undefined : sortedUnique(record.acks),
    from: record.from,
    to: record.to,
    after: sortedUnique(record.after),
    saw: [...record.saw],
    basis: record.basis,
    surface: record.surface,
    actor: record.actor,
    by: record.by,
    clone: record.clone,
    at: record.at,
  };
  const lines = KNOWN_KEYS.filter((key) => values[key] !== undefined).map((key) => formatLine(key, values[key]));
  for (const key of Object.keys(record.extra).sort()) lines.push(`${key}: ${record.extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

export function ledgerRecordId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const version = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * A stored record, or null when its bytes don't hash to its id (not grimoire's
 * write-once record) or it names no skill. Unknown keys are kept.
 */
export function parseLedgerRecord(id: string, bytes: Buffer): LedgerEntry | null {
  if (ledgerRecordId(bytes) !== id) return null;
  const source = bytes.toString('utf8');
  const close = source.startsWith('---\n') ? source.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(source.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const skill = text(values.get('skill'));
  if (skill === '') return null;
  const actor = values.get('actor');
  return {
    id,
    kind: text(values.get('kind')),
    skill,
    ...(values.has('proposal') ? { proposal: text(values.get('proposal')) } : {}),
    ...(values.has('reason') ? { reason: text(values.get('reason')) } : {}),
    ...(values.has('note') ? { note: text(values.get('note')) } : {}),
    ...(values.has('acks') ? { acks: texts(values.get('acks')) } : {}),
    from: version(values.get('from')),
    to: version(values.get('to')),
    after: texts(values.get('after')),
    saw: texts(values.get('saw')),
    basis: text(values.get('basis')),
    surface: text(values.get('surface')),
    actor: actor !== null && typeof actor === 'object' && !Array.isArray(actor) ? (actor as Record<string, unknown>) : {},
    by: text(values.get('by')),
    clone: text(values.get('clone')),
    at: text(values.get('at')),
    extra,
  };
}

/**
 * What `doctor` finds wrong with a stored skill ledger record: null when its
 * bytes are what grimoire writes for what it holds (known keys in order,
 * unknown keys kept after them). The store's own checks name quarantine
 * records and a name that isn't the bytes' sha256 first.
 */
export function ledgerRecordProblem(id: string, bytes: Buffer): RecordProblem | null {
  if (ledgerRecordId(bytes) !== id) return { kind: 'non-canonical', why: 'its file name is not the sha256 of its bytes' };
  const entry = parseLedgerRecord(id, bytes);
  if (!entry) return { kind: 'unparsable', why: 'it names no skill' };
  const { id: _id, ...record } = entry;
  return serializeLedgerRecord(record).equals(bytes) ? null : { kind: 'non-canonical', why: 'it differs from what the canonical serializer writes for it' };
}
