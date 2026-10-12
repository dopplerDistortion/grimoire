// Chore-run records (spec §3 Layout, §16 Chore-run records):
// `knowledge/chore-runs/<a>/<b>/<run-id>.md`, one per chore run that ended,
// written once by grimoire's own code and never edited. Runs carry random ids,
// so two clones' records fold to their union; duplicate runs merge that way.
// They carry no LLM free text: only ids, hashes, counts, reason codes, and the
// self-reported client and model as short fields marked unverified.
//
// Expired and abandoned runs are never committed (they stay machine-local).
// The knowledge engine derives due-ness from these records: which (trace,
// outcome) pairs a compile consumed, when the last compile was, which pairs
// failed compiles saw, and which compiles a Skill Proposer run consumed.
import { randomBytes } from 'node:crypto';
import { TREE_MODE } from '../git/objects';
import { ID_ALPHABET } from './ids';
import { formatLine, lineValue, parseLines } from './lines';
import type { FileEdit, ObjectSource } from './objects';
import { sortedUnique } from './record';

export const CHORE_RUNS_DIR = 'knowledge/chore-runs';
export const RUN_PREFIX = 'cr-';
export const RUN_LENGTH = 10;
export const RUN_PATTERN = /^cr-[0-9a-hjkmnp-tv-z]{10}$/;

/** A fresh run id: `cr-` and 10 crypto-random Crockford characters. */
export function randomRunId(): string {
  return RUN_PREFIX + [...randomBytes(RUN_LENGTH)].map((byte) => ID_ALPHABET[byte & 31]).join('');
}

/** `knowledge/chore-runs/<a>/<b>/<run-id>.md`, sharded by the id's first two characters. */
export function choreRunFile(id: string): string {
  const suffix = id.slice(RUN_PREFIX.length);
  return `${CHORE_RUNS_DIR}/${suffix[0]}/${suffix[1]}/${id}.md`;
}

/** The two knowledge chores (spec §16). */
export type ChoreKind = 'wiki-maintainer' | 'skill-proposer';
export const CHORE_KINDS: readonly ChoreKind[] = ['wiki-maintainer', 'skill-proposer'];

/**
 * How a run ended: a Wiki Maintainer run `compiled`, a Skill Proposer run
 * `proposed` or found `no_action`, and either `failed` after its one fix-up.
 */
export type ChoreResult = 'compiled' | 'proposed' | 'no_action' | 'failed';

/** One pair a compile consumed: the trace, the outcome it was compiled under, and where it went. */
export interface ConsumedPair {
  /** The trace: its attempt handle. */
  readonly trace: string;
  /** The verdict the pair had when it was compiled: `pass` or `fail`. */
  readonly outcome: string;
  /** The pattern pages it went to; empty when it went to `no_pattern`. */
  readonly slugs: readonly string[];
  /** It showed no pattern. The agent's reason stays in the machine-local served-item log. */
  readonly no_pattern: boolean;
}

/** One item the run was served, with the hash of what it was served. */
export interface ServedRef {
  readonly item: string;
  readonly hash: string;
}

export interface ChoreRunRecord {
  readonly id: string;
  readonly kind: string;
  readonly result: string;
  /** `session`, `manual`, `runner` or `scheduled`. */
  readonly origin: string;
  /** How admission isolated it: `claude-chore-agent`, `codex-subagent`, `codex-root`, `unidentified` or `runner`. */
  readonly isolation: string;
  /** The client and model the run reported for itself: short, length-capped, never verified. */
  readonly unverified: { readonly client: string | null; readonly model: string | null };
  /** The recorded actor: the person plus the observed agent facts. */
  readonly actor: Readonly<Record<string, unknown>>;
  readonly started_at: string;
  /** When it ended. */
  readonly at: string;
  /** Compiled: every batch pair and where it went (no reasons). */
  readonly consumption: readonly ConsumedPair[];
  /** Compiled: the page versions it wrote, by slug. */
  readonly pages: Readonly<Record<string, string>>;
  /** Every item it was served, with its hash. */
  readonly served: readonly ServedRef[];
  /** Proposed, no_action or failed proposer runs: the compile runs it consumed. */
  readonly consumed: readonly string[];
  /** Proposed: the proposal's id. */
  readonly proposal: string | null;
  /** Failed: the reason codes. */
  readonly reasons: readonly string[];
  /** Failed compiles: the pair ids it was served (`<trace>@<outcome>`), which the 2-strike rule counts. */
  readonly pairs: readonly string[];
  /** Compiled: the set-aside sides of conflicted pages its reconciling writes resolved, as `<slug>/<side id>`. */
  readonly resolved: readonly string[];
  /** Keys this release doesn't know, as their raw value text. */
  readonly extra: Readonly<Record<string, string>>;
}

export type NewChoreRun = Omit<ChoreRunRecord, 'extra'>;

const KEYS = [
  'kind',
  'result',
  'origin',
  'isolation',
  'unverified',
  'actor',
  'started_at',
  'at',
  'consumption',
  'pages',
  'served',
  'consumed',
  'proposal',
  'reasons',
  'pairs',
  'resolved',
] as const;
const KNOWN: ReadonlySet<string> = new Set(KEYS);

/** Longest a self-reported field may be. */
export const UNVERIFIED_LIMIT = 64;

const capped = (value: string | null) => (value === null ? null : [...value.replace(/[\r\n]+/g, ' ')].slice(0, UNVERIFIED_LIMIT).join(''));

export function serializeChoreRun(record: NewChoreRun | ChoreRunRecord): Buffer {
  const values: Record<(typeof KEYS)[number], unknown> = {
    kind: record.kind,
    result: record.result,
    origin: record.origin,
    isolation: record.isolation,
    unverified: { client: capped(record.unverified.client), model: capped(record.unverified.model) },
    actor: record.actor,
    started_at: record.started_at,
    at: record.at,
    consumption: record.consumption.map((pair) => ({
      trace: pair.trace,
      outcome: pair.outcome,
      slugs: sortedUnique(pair.slugs),
      no_pattern: pair.no_pattern,
    })),
    pages: Object.fromEntries(Object.entries(record.pages).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    served: record.served.map((ref) => ({ item: ref.item, hash: ref.hash })),
    consumed: sortedUnique(record.consumed),
    proposal: record.proposal,
    reasons: [...record.reasons],
    pairs: sortedUnique(record.pairs),
    resolved: sortedUnique(record.resolved),
  };
  const lines = KEYS.map((key) => formatLine(key, values[key]));
  const extra = 'extra' in record ? record.extra : {};
  for (const key of Object.keys(extra).sort()) if (!KNOWN.has(key)) lines.push(`${key}: ${extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** A chore-run record; what it can't read comes back empty, and unknown keys are kept. */
export function parseChoreRun(id: string, bytes: Buffer): ChoreRunRecord {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const unverified = object(values.get('unverified'));
  const consumption = Array.isArray(values.get('consumption')) ? (values.get('consumption') as unknown[]) : [];
  const served = Array.isArray(values.get('served')) ? (values.get('served') as unknown[]) : [];
  return {
    id,
    kind: str(values.get('kind')),
    result: str(values.get('result')),
    origin: str(values.get('origin')),
    isolation: str(values.get('isolation')),
    unverified: { client: strOrNull(unverified.client), model: strOrNull(unverified.model) },
    actor: object(values.get('actor')),
    started_at: str(values.get('started_at')),
    at: str(values.get('at')),
    consumption: consumption.map(object).flatMap((pair) =>
      typeof pair.trace === 'string' && typeof pair.outcome === 'string'
        ? [{ trace: pair.trace, outcome: pair.outcome, slugs: sortedUnique(strings(pair.slugs)), no_pattern: pair.no_pattern === true }]
        : [],
    ),
    pages: Object.fromEntries(Object.entries(object(values.get('pages'))).filter((e): e is [string, string] => typeof e[1] === 'string')),
    served: served.map(object).flatMap((ref) => (typeof ref.item === 'string' && typeof ref.hash === 'string' ? [{ item: ref.item, hash: ref.hash }] : [])),
    consumed: sortedUnique(strings(values.get('consumed'))),
    proposal: strOrNull(values.get('proposal')),
    reasons: strings(values.get('reasons')),
    pairs: sortedUnique(strings(values.get('pairs'))),
    resolved: sortedUnique(strings(values.get('resolved'))),
    extra,
  };
}

const byAt = (x: ChoreRunRecord, y: ChoreRunRecord) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** What every read sees of the chore runs that ended. */
export interface ChoreRunView {
  /** Every chore-run record, oldest end first (then by id). */
  records(): Promise<readonly ChoreRunRecord[]>;
}

/** The chore-run records of one tracker tree, read once on first use. */
export class ChoreRunReader implements ChoreRunView {
  private loaded: Promise<readonly ChoreRunRecord[]> | null = null;

  constructor(
    private readonly source: ObjectSource,
    private readonly rootTree: string,
  ) {}

  records(): Promise<readonly ChoreRunRecord[]> {
    if (!this.loaded) {
      const loading = this.load();
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = null;
      });
      this.loaded = loading;
    }
    return this.loaded;
  }

  private async load(): Promise<readonly ChoreRunRecord[]> {
    const records: ChoreRunRecord[] = [];
    const walk = async (oid: string, depth: number): Promise<void> => {
      const entries = await this.source.tree(oid);
      if (depth < 2) {
        await Promise.all(entries.filter((e) => e.mode === TREE_MODE).map((e) => walk(e.oid, depth + 1)));
        return;
      }
      for (const e of entries) {
        const id = e.name.slice(0, -3);
        if (e.mode !== TREE_MODE && e.name.endsWith('.md') && RUN_PATTERN.test(id)) records.push(parseChoreRun(id, await this.source.blob(e.oid)));
      }
    };
    const dir = await this.source.entryAt(this.rootTree, CHORE_RUNS_DIR);
    if (dir && dir.mode === TREE_MODE) await walk(dir.oid, 0);
    return records.sort(byAt);
  }
}

/** Chore runs as a write round changes them. */
export interface ChoreRunDraft extends ChoreRunView {
  /** Adds the record of a run that ended. One id is written once: a second record of it is refused. */
  add(record: NewChoreRun): Promise<ChoreRunRecord>;
}

export class ChoreRunDraftState implements ChoreRunDraft {
  private readonly added = new Map<string, { bytes: Buffer; record: ChoreRunRecord }>();

  constructor(private readonly base: ChoreRunReader) {}

  async records(): Promise<readonly ChoreRunRecord[]> {
    return [...(await this.base.records()), ...[...this.added.values()].map((a) => a.record)].sort(byAt);
  }

  async add(record: NewChoreRun): Promise<ChoreRunRecord> {
    if (!RUN_PATTERN.test(record.id)) throw new Error(`a chore run id is cr- and 10 Crockford characters, not ${JSON.stringify(record.id)}`);
    // Append-only: a record, once written, is never replaced.
    if (this.added.has(record.id) || (await this.base.records()).some((base) => base.id === record.id)) {
      throw new Error(`the chore run ${record.id} already has its record`);
    }
    const bytes = serializeChoreRun(record);
    const added = parseChoreRun(record.id, bytes);
    this.added.set(record.id, { bytes, record: added });
    return added;
  }

  fileEdits(): Map<string, FileEdit> {
    return new Map([...this.added].map(([id, { bytes }]) => [choreRunFile(id), bytes]));
  }
}
