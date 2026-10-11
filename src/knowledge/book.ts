// The skill book: every evolved skill as one tracker view's ledger makes it,
// with the text of each version it serves (spec §18, §15), and the one writer
// of skill changes. The core's skill ops and the decision ops read and write
// through here; no surface reads the ledger itself.
import type { SecretScanner } from '../scanner';
import { checkHygiene } from '../scanner';
import type { TrackerDraft, TrackerView } from '../tracker';
import { BoundedMap } from '../tracker/objects';
import { deriveSkills, type SkillState } from './derive';
import { ledgerRecordId, parseLedgerRecord, serializeLedgerRecord, type LedgerEntry, type LedgerKind } from './ledger';
import { normalizeSkillText, parseSkillText, skillVersionOf, type SkillParts } from './skill-text';

/** One skill agents get: its served version's text. */
export interface ServedSkill {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** The version's text, byte for byte as stored (normalized). */
  readonly text: string;
}

export interface SkillBook {
  /** Every skill the ledger names, by name. */
  readonly skills: ReadonlyMap<string, SkillState>;
  /** The skills agents get, by name; delivery aside (the store setting is the caller's to apply). */
  readonly served: readonly ServedSkill[];
  /** How many skills the ledger makes active: what the cap counts. */
  readonly active: number;
  /** A stored version's text, or null when it is missing or isn't the text its name says. */
  text(version: string): Promise<string | null>;
}

/** What one stored version holds, judged once per version (it never changes). */
interface VersionFacts {
  readonly text: string;
  readonly parts: SkillParts | null;
  /** Passes the content checks: parts, a description, no conflict markers, a clean secret scan. */
  readonly clean: boolean;
}

const parsed = new BoundedMap<string, LedgerEntry | null>(20_000);
const judged = new WeakMap<SecretScanner, BoundedMap<string, VersionFacts | null>>();
const books = new WeakMap<TrackerView, { scanner: SecretScanner; book: Promise<SkillBook> }>();

function entryOf(id: string, bytes: Buffer): LedgerEntry | null {
  let entry = parsed.get(id);
  if (entry === undefined) {
    entry = parseLedgerRecord(id, bytes);
    parsed.set(id, entry);
  }
  return entry;
}

async function factsOf(view: TrackerView, version: string, scanner: SecretScanner): Promise<VersionFacts | null> {
  let memo = judged.get(scanner);
  if (!memo) judged.set(scanner, (memo = new BoundedMap(5_000)));
  if (memo.has(version)) return memo.get(version)!;
  const bytes = await view.skillVersion(version);
  const text = bytes?.toString('utf8') ?? null;
  // Not stored, or not the normalized text its name is the hash of: nothing to serve.
  if (text === null || normalizeSkillText(text) !== text || skillVersionOf(text) !== version) return null;
  let parts: SkillParts | null = null;
  try {
    parts = parseSkillText(text);
  } catch {
    parts = null;
  }
  const hygiene = checkHygiene(text);
  const scan = scanner.scan(text);
  const clean =
    parts !== null &&
    parts.name !== '' &&
    parts.description.trim() !== '' &&
    hygiene.status === 'checked' &&
    !hygiene.findings.some((finding) => finding.check === 'conflict-marker') &&
    scan.status === 'scanned' &&
    scan.hits.length === 0;
  const facts = { text, parts, clean };
  memo.set(version, facts);
  return facts;
}

/** The skill book of `view` (memoized per view). `scanner` judges the served versions' content. */
export function readSkills(view: TrackerView, scanner: SecretScanner): Promise<SkillBook> {
  // A draft changes as its round writes: never remember its book.
  if ('putLedgerFile' in view) return buildBook(view, scanner);
  const known = books.get(view);
  if (known && known.scanner === scanner) return known.book;
  const book = buildBook(view, scanner);
  books.set(view, { scanner, book });
  book.catch(() => books.delete(view));
  return book;
}

async function buildBook(view: TrackerView, scanner: SecretScanner): Promise<SkillBook> {
  const files = await view.ledgerFiles();
  const entries = [...files].map(([id, bytes]) => entryOf(id, bytes)).filter((entry): entry is LedgerEntry => entry !== null);
  const versions = new Set(entries.map((entry) => entry.to).filter((version): version is string => version !== null));
  const facts = new Map(await Promise.all([...versions].map(async (v) => [v, await factsOf(view, v, scanner)] as const)));
  const skills = deriveSkills(entries, (skill, version) => {
    const fact = facts.get(version);
    return fact !== undefined && fact !== null && fact.clean && fact.parts!.name === skill;
  });
  const served: ServedSkill[] = [];
  for (const state of skills.values()) {
    if (!state.served) continue;
    const fact = facts.get(state.served.version)!;
    served.push({ name: state.name, version: state.served.version, description: fact.parts!.description, text: fact.text });
  }
  return {
    skills,
    served,
    active: [...skills.values()].filter((state) => state.status === 'active').length,
    async text(version) {
      return facts.get(version)?.text ?? (await factsOf(view, version, scanner))?.text ?? null;
    },
  };
}

/** One change to one skill, as a decision or edit op asks for it. */
export interface SkillChange {
  readonly kind: LedgerKind;
  readonly skill: string;
  /** The normalized text this change makes current, stored as a skill version (edit, accept, record, acknowledge). */
  readonly text?: string;
  /** Or a version already stored (restore, acknowledge); null for none. Ignored when `text` is given. */
  readonly to?: string | null;
  readonly proposal?: string;
  readonly reason?: string;
  readonly acks?: readonly string[];
  /** The versions the actor was shown (default: the version current when the change was made). */
  readonly saw?: readonly string[];
}

/** Who makes a change, as every ledger record carries it. */
export interface ChangeAuthor {
  readonly actor: Readonly<Record<string, unknown>>;
  /** The person's email. */
  readonly by: string;
  readonly surface: string;
  /** This clone's tag (see `cloneTag`). */
  readonly clone: string;
  /** `human review` unless said otherwise. */
  readonly basis?: string;
}

export interface WrittenChange {
  /** The new ledger record's id. */
  readonly record: string;
  /** The version the change makes current (null: none). */
  readonly version: string | null;
  /** The version that was current before it (null: none). */
  readonly from: string | null;
}

/**
 * Adds one change to `draft`: the skill version's text (when the change
 * writes one) and the ledger record, which follows every record of the skill
 * nothing else followed yet. Checks are the caller's; this only writes.
 */
export async function writeSkillChange(
  draft: TrackerDraft,
  scanner: SecretScanner,
  change: SkillChange,
  author: ChangeAuthor,
): Promise<WrittenChange> {
  const book = await readSkills(draft, scanner);
  const state = book.skills.get(change.skill);
  const from = state?.version ?? null;
  const to = change.text !== undefined ? skillVersionOf(change.text) : (change.to ?? null);
  const record = serializeLedgerRecord({
    kind: change.kind,
    skill: change.skill,
    ...(change.proposal !== undefined ? { proposal: change.proposal } : {}),
    ...(change.reason !== undefined ? { reason: change.reason } : {}),
    ...(change.acks !== undefined ? { acks: change.acks } : {}),
    from,
    to,
    after: state?.heads ?? [],
    saw: change.saw ?? (from === null ? [] : [from]),
    basis: author.basis ?? 'human review',
    surface: author.surface,
    actor: author.actor,
    by: author.by,
    clone: author.clone,
    at: draft.now.toISOString(),
    extra: {},
  });
  const id = ledgerRecordId(record);
  if (change.text !== undefined) draft.putSkillVersion(to!, Buffer.from(change.text, 'utf8'));
  draft.putLedgerFile(id, record);
  return { record: id, version: to, from };
}
