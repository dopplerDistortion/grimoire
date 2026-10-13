// Skill proposal records (spec §3 Layout, §18 Proposals; ADR 0005):
// `knowledge/proposals/<proposal-id>.md`, one per valid proposal a Skill
// Proposer run submitted, written once by grimoire's own code and never
// edited. A proposal is immutable and self-contained, so it can be accepted on
// any clone: its frontmatter holds the action, the target and its base, the
// ops, the citations with the served-input record (what each cited item was
// when it was served), the claims, the risk flags and who submitted it; its
// body is the whole proposed `SKILL.md` text, whose sha256 is `version`.
//
// Proposals carry random ids, so two clones' records fold to their union. No
// status is stored: pending, stale, accepted and the rest are derived from
// the skill ledger on read (src/knowledge/proposals.ts). Purging a proposal
// removes its file and writes `purges/<proposal-id>.md`; the tombstone
// dominates, so a tree that still holds the file reads as if it didn't.
import { randomBytes } from 'node:crypto';
import { TREE_MODE } from '../git/objects';
import { ID_ALPHABET } from './ids';
import { formatLine, lineValue, parseLines } from './lines';
import type { FileEdit, ObjectSource } from './objects';
import { sortedUnique } from './record';

export const PROPOSALS_DIR = 'knowledge/proposals';
export const PROPOSAL_PREFIX = 'pp-';
export const PROPOSAL_LENGTH = 10;
export const PROPOSAL_PATTERN = /^pp-[0-9a-hjkmnp-tv-z]{10}$/;

/** A fresh proposal id: `pp-` and 10 crypto-random Crockford characters. */
export function randomProposalId(): string {
  return PROPOSAL_PREFIX + [...randomBytes(PROPOSAL_LENGTH)].map((byte) => ID_ALPHABET[byte & 31]).join('');
}

/** `knowledge/proposals/<proposal-id>.md` */
export function proposalFile(id: string): string {
  return `${PROPOSALS_DIR}/${id}.md`;
}

/** One anchored edit of a patch, as submitted. */
export interface ProposalOp {
  readonly op: string;
  readonly anchor?: string;
  readonly text: string;
}

/** One cited item as it was served to the run: the served-input record. */
export interface CitedItem {
  readonly item: string;
  /** sha256 of the whole item as served. */
  readonly hash: string;
}

/** A cited trace as it stood at drafting: what the evidence minimum counted. */
export interface CitedTrace {
  readonly trace: string;
  readonly issue: string;
  /** The outcome at drafting: `pass`, `fail` or `none`. */
  readonly outcome: string;
  readonly wiki_exposed: boolean;
}

/** The labelled claims: the LLM's own words, shown last and unverified. */
export interface ProposalClaims {
  readonly rationale: string;
  readonly failures: readonly { readonly trace: string; readonly line: string }[];
  readonly expected_signal: string;
  readonly provenance: string;
}

/** A risk flag (spec §18 Risk flags): shown, never rejecting. */
export interface RiskFlag {
  readonly flag: string;
  readonly severity: 'red' | 'amber';
  /** Grimoire's own words. */
  readonly detail: string;
}

/** Where a token the proposal adds was found (spec §18, Token origin). */
export interface TokenOrigin {
  readonly token: string;
  readonly kind: 'command' | 'url' | 'package' | 'path';
  /** green: tracked files at the baseline; amber: agent debriefs or commits only; red: excerpts only, or nowhere. */
  readonly origin: 'green' | 'amber' | 'red';
  /** `baseline`, `debrief`, `commit`, `excerpt` or `nowhere`. */
  readonly found: string;
}

export interface ProposalRecord {
  readonly id: string;
  /** `create` or `patch`. */
  readonly action: string;
  /** The evolved skill's name. */
  readonly skill: string;
  /** The version the patch applies to; null for a create. */
  readonly base: string | null;
  /** The skill's ledger heads when the proposal was made: a later change of the skill makes it stale. */
  readonly after: readonly string[];
  /** The proposed version: the sha256 of `text`. */
  readonly version: string;
  /** Patch: the anchored edits, as submitted. */
  readonly ops: readonly ProposalOp[];
  /** The ids of the served items it cites, sorted. */
  readonly citations: readonly string[];
  /** The served-input record: each cited item with the hash it was served with. */
  readonly served: readonly CitedItem[];
  /** The cited pattern pages, by slug, and the cited traces as they stood at drafting. */
  readonly pages: readonly string[];
  readonly traces: readonly CitedTrace[];
  readonly claims: ProposalClaims;
  readonly flags: readonly RiskFlag[];
  readonly tokens: readonly TokenOrigin[];
  /** The chore run that drafted it. */
  readonly run: string;
  readonly origin: string;
  readonly isolation: string;
  /** The client and model the run reported for itself: short, never verified. */
  readonly unverified: { readonly client: string | null; readonly model: string | null };
  readonly actor: Readonly<Record<string, unknown>>;
  readonly at: string;
  /** The whole proposed `SKILL.md`, normalized. */
  readonly text: string;
  /** Keys this release doesn't know, as their raw value text. */
  readonly extra: Readonly<Record<string, string>>;
}

export type NewProposal = Omit<ProposalRecord, 'extra'>;

const KEYS = [
  'action',
  'skill',
  'base',
  'after',
  'version',
  'ops',
  'citations',
  'served',
  'pages',
  'traces',
  'claims',
  'flags',
  'tokens',
  'run',
  'origin',
  'isolation',
  'unverified',
  'actor',
  'at',
] as const;
const KNOWN: ReadonlySet<string> = new Set(KEYS);

export function serializeProposal(record: NewProposal | ProposalRecord): Buffer {
  const values: Record<(typeof KEYS)[number], unknown> = {
    action: record.action,
    skill: record.skill,
    base: record.base,
    after: sortedUnique(record.after),
    version: record.version,
    ops: record.ops.map((op) => ({ op: op.op, ...(op.anchor !== undefined ? { anchor: op.anchor } : {}), text: op.text })),
    citations: sortedUnique(record.citations),
    served: [...record.served].sort((x, y) => (x.item < y.item ? -1 : x.item > y.item ? 1 : 0)).map((ref) => ({ item: ref.item, hash: ref.hash })),
    pages: sortedUnique(record.pages),
    traces: [...record.traces]
      .sort((x, y) => (x.trace < y.trace ? -1 : x.trace > y.trace ? 1 : 0))
      .map((t) => ({ trace: t.trace, issue: t.issue, outcome: t.outcome, wiki_exposed: t.wiki_exposed })),
    claims: {
      rationale: record.claims.rationale,
      failures: record.claims.failures.map((f) => ({ trace: f.trace, line: f.line })),
      expected_signal: record.claims.expected_signal,
      provenance: record.claims.provenance,
    },
    flags: record.flags.map((f) => ({ flag: f.flag, severity: f.severity, detail: f.detail })),
    tokens: record.tokens.map((t) => ({ token: t.token, kind: t.kind, origin: t.origin, found: t.found })),
    run: record.run,
    origin: record.origin,
    isolation: record.isolation,
    unverified: { client: record.unverified.client, model: record.unverified.model },
    actor: record.actor,
    at: record.at,
  };
  const lines = KEYS.map((key) => formatLine(key, values[key]));
  const extra = 'extra' in record ? record.extra : {};
  for (const key of Object.keys(extra).sort()) if (!KNOWN.has(key)) lines.push(`${key}: ${extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${record.text}`, 'utf8');
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const objects = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);

/** A proposal record; what it can't read comes back empty, and unknown keys are kept. */
export function parseProposal(id: string, bytes: Buffer): ProposalRecord {
  const source = bytes.toString('utf8');
  const close = source.startsWith('---\n') ? source.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(source.slice(4, close))) {
    if (KNOWN.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  const claims = object(values.get('claims'));
  const unverified = object(values.get('unverified'));
  return {
    id,
    action: str(values.get('action')),
    skill: str(values.get('skill')),
    base: strOrNull(values.get('base')),
    after: sortedUnique(strings(values.get('after'))),
    version: str(values.get('version')),
    ops: objects(values.get('ops')).flatMap((op) =>
      typeof op.op === 'string' && typeof op.text === 'string'
        ? [{ op: op.op, ...(typeof op.anchor === 'string' ? { anchor: op.anchor } : {}), text: op.text }]
        : [],
    ),
    citations: sortedUnique(strings(values.get('citations'))),
    served: objects(values.get('served')).flatMap((ref) => (typeof ref.item === 'string' && typeof ref.hash === 'string' ? [{ item: ref.item, hash: ref.hash }] : [])),
    pages: sortedUnique(strings(values.get('pages'))),
    traces: objects(values.get('traces')).flatMap((t) =>
      typeof t.trace === 'string' ? [{ trace: t.trace, issue: str(t.issue), outcome: str(t.outcome), wiki_exposed: t.wiki_exposed === true }] : [],
    ),
    claims: {
      rationale: str(claims.rationale),
      failures: objects(claims.failures).flatMap((f) => (typeof f.trace === 'string' && typeof f.line === 'string' ? [{ trace: f.trace, line: f.line }] : [])),
      expected_signal: str(claims.expected_signal),
      provenance: str(claims.provenance),
    },
    flags: objects(values.get('flags')).flatMap((f) =>
      typeof f.flag === 'string' && (f.severity === 'red' || f.severity === 'amber') ? [{ flag: f.flag, severity: f.severity, detail: str(f.detail) }] : [],
    ),
    tokens: objects(values.get('tokens')).flatMap((t) =>
      typeof t.token === 'string' &&
      (t.kind === 'command' || t.kind === 'url' || t.kind === 'package' || t.kind === 'path') &&
      (t.origin === 'green' || t.origin === 'amber' || t.origin === 'red')
        ? [{ token: t.token, kind: t.kind, origin: t.origin, found: str(t.found) }]
        : [],
    ),
    run: str(values.get('run')),
    origin: str(values.get('origin')),
    isolation: str(values.get('isolation')),
    unverified: { client: strOrNull(unverified.client), model: strOrNull(unverified.model) },
    actor: object(values.get('actor')),
    at: str(values.get('at')),
    text: close < 0 ? '' : source.slice(close + 5),
    extra,
  };
}

const byAt = (x: ProposalRecord, y: ProposalRecord) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** What every read sees of the skill proposals. */
export interface ProposalView {
  /** Every proposal record, oldest first (then by id). */
  records(): Promise<readonly ProposalRecord[]>;
}

/** The proposal records of one tracker tree, read once on first use. */
export class ProposalReader implements ProposalView {
  private loaded: Promise<readonly ProposalRecord[]> | null = null;

  constructor(
    private readonly source: ObjectSource,
    private readonly rootTree: string,
    /** Proposals a tombstone purged: never read, even where the tree still holds them. */
    private readonly purged: ReadonlySet<string> = new Set(),
  ) {}

  /** Whether the tree holds the proposal's file, purged or not. */
  async holds(id: string): Promise<boolean> {
    const entry = await this.source.entryAt(this.rootTree, proposalFile(id));
    return entry !== null && entry !== undefined && entry.mode !== TREE_MODE;
  }

  records(): Promise<readonly ProposalRecord[]> {
    if (!this.loaded) {
      const loading = this.load();
      loading.catch(() => {
        if (this.loaded === loading) this.loaded = null;
      });
      this.loaded = loading;
    }
    return this.loaded;
  }

  private async load(): Promise<readonly ProposalRecord[]> {
    const dir = await this.source.entryAt(this.rootTree, PROPOSALS_DIR);
    if (!dir || dir.mode !== TREE_MODE) return [];
    const records: ProposalRecord[] = [];
    for (const e of await this.source.tree(dir.oid)) {
      const id = e.name.slice(0, -3);
      if (e.mode !== TREE_MODE && e.name.endsWith('.md') && PROPOSAL_PATTERN.test(id) && !this.purged.has(id)) records.push(parseProposal(id, await this.source.blob(e.oid)));
    }
    return records.sort(byAt);
  }
}

/** Proposals as a write round changes them. */
export interface ProposalDraft extends ProposalView {
  /** Adds a proposal. Append-only: an id already written is refused. */
  add(record: NewProposal): Promise<ProposalRecord>;
}

export class ProposalDraftState implements ProposalDraft {
  private readonly added = new Map<string, { bytes: Buffer; record: ProposalRecord }>();
  /** Proposals this round purges: gone from its reads. */
  private readonly hidden = new Set<string>();

  constructor(private readonly base: ProposalReader) {}

  async records(): Promise<readonly ProposalRecord[]> {
    return [...(await this.base.records()), ...[...this.added.values()].map((a) => a.record)].filter((record) => !this.hidden.has(record.id)).sort(byAt);
  }

  /** Purged this round: gone from every read, and never written (the draft writes the removal). */
  hide(id: string): void {
    this.hidden.add(id);
    this.added.delete(id);
  }

  async add(record: NewProposal): Promise<ProposalRecord> {
    if (!PROPOSAL_PATTERN.test(record.id)) throw new Error(`a proposal id is pp- and 10 Crockford characters, not ${JSON.stringify(record.id)}`);
    if (this.hidden.has(record.id) || this.added.has(record.id) || (await this.base.holds(record.id))) {
      throw new Error(`the proposal ${record.id} is already written`);
    }
    const bytes = serializeProposal(record);
    const added = parseProposal(record.id, bytes);
    this.added.set(record.id, { bytes, record: added });
    return added;
  }

  fileEdits(): Map<string, FileEdit> {
    return new Map([...this.added].map(([id, { bytes }]) => [proposalFile(id), bytes]));
  }
}
