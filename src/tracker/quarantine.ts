// Quarantine records (spec §18, The skill ledger: record kinds include
// quarantine mark and clear). A human's mark keeps a pattern page (or a trace)
// out of chores and evidence without editing or purging it; a clear names the
// marks it lifts. Both are ledger records: write-once and content-addressed at
// `knowledge/ledger/<sha256>.md`, the sha256 of their own bytes, in the
// ledger's line format and key names (`kind`, `from`/`to`, `saw`, `basis`,
// `surface`, `actor`, `by`, `at`). The ledger's other kinds (skill decisions
// and changes) share the directory and are read as nothing here. Records only
// accumulate, so two clones' ledgers fold by union, and whether a target is
// quarantined (a mark no clear names) is derived on read, never stored.
import { createHash } from 'node:crypto';
import { TREE_MODE } from '../git/objects';
import { formatLine, lineValue, parseLines } from './lines';
import type { FileEdit, ObjectSource } from './objects';
import { sortedUnique } from './record';

/** The ledger's directory (the skill ledger's records live here too). */
const LEDGER = 'knowledge/ledger';

export type QuarantineAction = 'quarantine-mark' | 'quarantine-clear';

export interface QuarantineRecord {
  /** The record's name: the sha256 of its bytes. */
  readonly id: string;
  /** The ledger record kind. */
  readonly kind: QuarantineAction;
  /** What it marks or clears: `{page: <slug>}` (a trace's target comes with trace quarantine). */
  readonly target: Readonly<Record<string, string>>;
  /** A clear's lifted marks, sorted (empty for a mark). */
  readonly clears: readonly string[];
  readonly reason: string;
  /** The target's version before and after: a quarantine never changes it, so both are the version the actor saw. */
  readonly from: string | null;
  readonly to: string | null;
  /** The versions of the target the actor was shown. */
  readonly saw: readonly string[];
  /** Why the actor may: `human review` in v1. */
  readonly basis: string;
  /** The surface it was made on: `cli` or `dashboard`. */
  readonly surface: string;
  /** The recorded actor: the person plus how they made it. */
  readonly actor: Readonly<Record<string, unknown>>;
  /** The person (an email). */
  readonly by: string;
  readonly at: string;
}

export type NewQuarantineRecord = Omit<QuarantineRecord, 'id' | 'at'>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function serialize(record: Omit<QuarantineRecord, 'id'>): Buffer {
  const lines = [
    formatLine('kind', record.kind),
    formatLine('target', record.target),
    formatLine('clears', sortedUnique(record.clears)),
    formatLine('reason', record.reason),
    formatLine('from', record.from),
    formatLine('to', record.to),
    formatLine('saw', [...record.saw]),
    formatLine('basis', record.basis),
    formatLine('surface', record.surface),
    formatLine('actor', record.actor),
    formatLine('by', record.by),
    formatLine('at', record.at),
  ];
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * A quarantine record, or null for anything else in the ledger: another kind,
 * or a file whose bytes don't hash to its name (not grimoire's write-once record).
 */
function parse(id: string, bytes: Buffer): QuarantineRecord | null {
  if (sha256(bytes) !== id) return null;
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) values.set(key, lineValue(raw));
  const kind = values.get('kind');
  if (kind !== 'quarantine-mark' && kind !== 'quarantine-clear') return null;
  const target = Object.fromEntries(Object.entries(object(values.get('target'))).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return {
    id,
    kind,
    target,
    clears: sortedUnique(strings(values.get('clears'))),
    reason: str(values.get('reason')),
    from: strOrNull(values.get('from')),
    to: strOrNull(values.get('to')),
    saw: strings(values.get('saw')),
    basis: str(values.get('basis')),
    surface: str(values.get('surface')),
    actor: object(values.get('actor')),
    by: str(values.get('by')),
    at: str(values.get('at')),
  };
}

const byAt = (x: QuarantineRecord, y: QuarantineRecord) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** What every read sees of quarantine. */
export interface QuarantineView {
  /** Every mark and clear, oldest first. */
  records(): Promise<readonly QuarantineRecord[]>;
}

/** The quarantine records in one tracker tree's ledger, read once on first use. */
export class QuarantineReader implements QuarantineView {
  private loaded: Promise<readonly QuarantineRecord[]> | null = null;

  constructor(
    private readonly source: ObjectSource,
    private readonly rootTree: string,
  ) {}

  records(): Promise<readonly QuarantineRecord[]> {
    return (this.loaded ??= (async () => {
      const files = (await this.source.dirAt(this.rootTree, LEDGER)).filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'));
      const records = await Promise.all(files.map(async (e) => parse(e.name.slice(0, -3), await this.source.blob(e.oid))));
      return records.filter((r): r is QuarantineRecord => r !== null).sort(byAt);
    })());
  }
}

/** Quarantine as a write round changes it. */
export interface QuarantineDraft extends QuarantineView {
  /** Adds a mark or a clear at the round's instant. Returns the record. */
  add(record: NewQuarantineRecord): QuarantineRecord;
}

export class QuarantineDraftState implements QuarantineDraft {
  private readonly added: { bytes: Buffer; record: QuarantineRecord }[] = [];

  constructor(
    private readonly base: QuarantineReader,
    private readonly now: Date,
  ) {}

  async records(): Promise<readonly QuarantineRecord[]> {
    return [...(await this.base.records()), ...this.added.map((a) => a.record)].sort(byAt);
  }

  add(record: NewQuarantineRecord): QuarantineRecord {
    const at = this.now.toISOString();
    const bytes = serialize({ ...record, at });
    const added: QuarantineRecord = { ...record, clears: sortedUnique(record.clears), id: sha256(bytes), at };
    this.added.push({ bytes, record: added });
    return added;
  }

  fileEdits(): Map<string, FileEdit> {
    return new Map(this.added.map(({ bytes, record }) => [`${LEDGER}/${record.id}.md`, bytes]));
  }
}
