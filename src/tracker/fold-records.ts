// The record rules of the fold (spec §4, Fold rules) for files both sides
// changed: issue records, attempt ends, outcomes, session records, the store
// settings and the `format` marker. Each rule is symmetric: swapping the sides
// gives the same bytes.
import { createHash } from 'node:crypto';
import { DELETED_FIELD, serializeConflict } from './conflict';
import { parseEnd, parseOutcome } from './attempt';
import { canonicalJson, lineValue, parseLines } from './lines';
import { mergeText } from './merge-text';
import { parseIssue, serializeIssue, type IssueLink, type IssueRecord } from './record';
import { parseSetting, serializeSettings, settingLines } from './settings';

/** Orders two ISO times; unparsable ones compare as text. */
function compareTimes(x: string, y: string): number {
  const tx = Date.parse(x);
  const ty = Date.parse(y);
  if (!Number.isNaN(tx) && !Number.isNaN(ty) && tx !== ty) return tx - ty;
  return x < y ? -1 : x > y ? 1 : 0;
}

const bytesOf = (value: unknown) => Buffer.from(canonicalJson(value), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Which side's value stands when both changed a scalar: the later `updated_at`, then the lower bytes. */
function pickSide(a: IssueRecord, b: IssueRecord, aValue: unknown, bValue: unknown): 'a' | 'b' {
  const order = compareTimes(a.updated_at, b.updated_at);
  if (order !== 0) return order > 0 ? 'a' : 'b';
  return Buffer.compare(bytesOf(aValue), bytesOf(bValue)) <= 0 ? 'a' : 'b';
}

const equal = (x: unknown, y: unknown) => canonicalJson(x) === canonicalJson(y);

/** (base ∪ adds) − removes, by key. */
function foldSet<T>(base: readonly T[], a: readonly T[], b: readonly T[], key: (item: T) => string): T[] {
  const keyed = (items: readonly T[]) => new Map(items.map((item) => [key(item), item]));
  const [baseMap, aMap, bMap] = [keyed(base), keyed(a), keyed(b)];
  const out = new Map(baseMap);
  for (const side of [aMap, bMap]) {
    for (const [k, item] of side) if (!baseMap.has(k)) out.set(k, item);
    for (const k of baseMap.keys()) if (!side.has(k)) out.delete(k);
  }
  return [...out.values()];
}

/** Unknown keys: a one-sided change wins; a modification beats a delete; otherwise the lower hash. */
export function foldExtra(
  base: Readonly<Record<string, string>>,
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])) {
    const [x, y, o] = [a[key], b[key], base[key]];
    let value: string | undefined;
    if (x === y) value = x;
    else if (x === o) value = y;
    else if (y === o) value = x;
    else if (x === undefined || y === undefined) value = x ?? y;
    else value = sha256(x) <= sha256(y) ? x : y;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface IssueFold {
  readonly bytes: Buffer;
  /** The conflict record's bytes, when both sides changed a scalar or overlapping body text. */
  readonly conflict: Buffer | null;
}

/** Folds two versions of one `issue.md` over its base (null: both sides added it). */
export function foldIssue(baseBytes: Buffer | null, aBytes: Buffer, bBytes: Buffer): IssueFold {
  const a = parseIssue(aBytes);
  const b = parseIssue(bBytes);
  const base = baseBytes ? parseIssue(baseBytes) : null;
  const kept: Record<string, unknown> = {};
  const theirs: Record<string, unknown> = {};
  const baseValues: Record<string, unknown> = {};
  let setAsideAt = '';

  /** Records a field the fold settled for one side: what stands, and the other side's value set aside. */
  function setAside(field: keyof IssueRecord, value: unknown, aWins: boolean): void {
    kept[field] = value;
    theirs[field] = aWins ? b[field] : a[field];
    baseValues[field] = base ? base[field] : null;
    setAsideAt = (aWins ? b : a).updated_at;
  }

  /** A scalar: one-sided change wins; otherwise the later side, and the loser is set aside when `recorded`. */
  function scalar<K extends keyof IssueRecord>(field: K, recorded: boolean): IssueRecord[K] {
    const x: IssueRecord[K] = a[field];
    const y: IssueRecord[K] = b[field];
    if (equal(x, y)) return x;
    if (base && equal(x, base[field])) return y;
    if (base && equal(y, base[field])) return x;
    const aWins = pickSide(a, b, x, y) === 'a';
    if (recorded) setAside(field, aWins ? x : y, aWins);
    return aWins ? x : y;
  }

  // The body merges hunk by hunk; where hunks overlap, the side a scalar would pick keeps its change.
  let body: string;
  if (base) {
    const bodyWinner = pickSide(a, b, a.body, b.body);
    const text = mergeText(base.body, a.body, b.body, bodyWinner);
    body = text.text;
    if (text.conflicted) setAside('body', body, bodyWinner === 'a');
  } else {
    // Both sides added the record: with no base, the bodies are two values, not hunks to interleave.
    body = scalar('body', true);
  }

  const merged: IssueRecord = {
    id: scalar('id', false),
    seq: scalar('seq', false),
    title: scalar('title', true),
    status: scalar('status', true),
    labels: foldSet(base?.labels ?? [], a.labels, b.labels, (label) => label),
    parent: scalar('parent', true),
    blocked_by: foldSet(base?.blocked_by ?? [], a.blocked_by, b.blocked_by, (id) => id),
    links: foldSet<IssueLink>(base?.links ?? [], a.links, b.links, (link) => canonicalJson([link.target, link.title])),
    created_at: scalar('created_at', false),
    created_by: scalar('created_by', false),
    updated_at: compareTimes(a.updated_at, b.updated_at) >= 0 ? a.updated_at : b.updated_at,
    body,
    extra: foldExtra(base?.extra ?? {}, a.extra, b.extra),
  };
  const fields = Object.keys(kept).sort();
  return {
    bytes: serializeIssue(merged),
    conflict:
      fields.length === 0
        ? null
        : serializeConflict({ fields, kept, theirs, base: baseValues, at: setAsideAt }),
  };
}

/** How strongly an ending holds when two clones sealed one attempt (spec §4: done > canceled > release = release-abandoned > reassign > superseded). */
const ENDING_RANK: Readonly<Record<string, number>> = {
  done: 5,
  canceled: 4,
  release: 3,
  'release-abandoned': 3,
  reassign: 2,
  superseded: 1,
};

/** Two `end.md` for one attempt: the stronger ending stands, ties to the earliest. Returns [kept, set aside]. */
export function foldEnd(a: Buffer, b: Buffer): [Buffer, Buffer] {
  const [x, y] = [parseEnd(a), parseEnd(b)];
  const rank = (ENDING_RANK[y.ended] ?? 0) - (ENDING_RANK[x.ended] ?? 0);
  const aWins = rank !== 0 ? rank < 0 : (compareTimes(x.at, y.at) || Buffer.compare(a, b)) <= 0;
  return aWins ? [a, b] : [b, a];
}

/**
 * Two outcome records: a human beats grimoire, then the later time, then
 * fail, then the lower bytes. When both clones sealed the attempt differently
 * (`ends`: each side's `end.md`), grimoire's outcome derived from the end that
 * stood comes before the time, so the outcome never contradicts the end.
 */
export function foldOutcome(a: Buffer, b: Buffer, ends: readonly [Buffer, Buffer] | null): Buffer {
  const [x, y] = [parseOutcome(a), parseOutcome(b)];
  const ending = ends ? parseEnd(foldEnd(...ends)[0]).ended : null;
  const human = (o: { set_by: string }) => (o.set_by.startsWith('human:') ? 1 : 0);
  const sealed = (o: { set_by: string; reason: string }) => (o.set_by === 'grimoire' && o.reason === ending ? 1 : 0);
  const fail = (o: { verdict: string }) => (o.verdict === 'fail' ? 1 : 0);
  const order =
    human(x) - human(y) || sealed(x) - sealed(y) || compareTimes(x.at, y.at) || fail(x) - fail(y) || Buffer.compare(b, a);
  return order >= 0 ? a : b;
}

/**
 * How far a session record reaches (spec §14): its `reach` frontmatter value,
 * `{at, ref}` as capture records a cut's last step (`StepOrigin`): the step's
 * time, and its ref, a Claude Code line uuid or a Codex ordinal. A facts-only
 * record writes its event count as the ref. Null when the record has none.
 */
function reachOf(bytes: Buffer): { at: string; ordinal: bigint | null } | null {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (key !== 'reach') continue;
    const value = lineValue(raw) as { at?: unknown; ref?: unknown } | null;
    if (value && typeof value === 'object' && typeof value.at === 'string') {
      const ref = typeof value.ref === 'number' ? String(value.ref) : value.ref;
      return { at: value.at, ordinal: typeof ref === 'string' && /^\d+$/.test(ref) ? BigInt(ref) : null };
    }
  }
  return null;
}

/**
 * Two versions of one session record: the further reach wins (the later
 * time, then the higher ordinal when both refs are ordinals; line uuids don't
 * order), then the lower bytes.
 */
export function foldSession(a: Buffer, b: Buffer): Buffer {
  const [x, y] = [reachOf(a), reachOf(b)];
  const ordinals = (p: bigint | null, q: bigint | null) => (p === null || q === null || p === q ? 0 : p > q ? 1 : -1);
  const order =
    (x ? 1 : 0) - (y ? 1 : 0) ||
    (x && y ? compareTimes(x.at, y.at) || ordinals(x.ordinal, y.ordinal) : 0) ||
    Buffer.compare(b, a);
  return order >= 0 ? a : b;
}

/** A file of `key: <JSON>` lines (the shared line format), as raw values by key. */
function keyedLines(bytes: Buffer | null): Map<string, string> {
  return new Map(bytes ? parseLines(bytes.toString('utf8')).map(({ key, raw }) => [key, raw]) : []);
}

/**
 * Folds keyed lines: a key changed on one side takes that side's value, a
 * modification beats a delete, and `both` picks between two changed values.
 */
function foldKeyed(
  base: Map<string, string>,
  a: Map<string, string>,
  b: Map<string, string>,
  both: (key: string, x: string, y: string) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of new Set([...base.keys(), ...a.keys(), ...b.keys()])) {
    const [x, y, o] = [a.get(key), b.get(key), base.get(key)];
    let value: string | undefined;
    if (x === y) value = x;
    else if (x === o) value = y;
    else if (y === o) value = x;
    else if (x === undefined || y === undefined) value = x ?? y;
    else value = both(key, x, y);
    if (value !== undefined) out.set(key, value);
  }
  return out;
}

const byKey = ([x]: [string, string], [y]: [string, string]) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Store settings (`settings.yml`, spec §4) merge per key: when both sides
 * changed a key, the later `at` wins, ties broken by bytes. Unknown keys fold
 * the same way (spec §5).
 */
export function foldSettings(base: Buffer | null, a: Buffer, b: Buffer): Buffer {
  const at = (raw: string) => parseSetting(raw)?.at ?? '';
  const merged = foldKeyed(settingLines(base), settingLines(a), settingLines(b), (_key, x, y) => {
    const order = compareTimes(at(x), at(y));
    if (order !== 0) return order > 0 ? x : y;
    return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')) <= 0 ? x : y;
  });
  return serializeSettings(merged);
}

/** Orders semver strings by their numeric parts (anything unparsable sorts first). */
function compareVersions(x: string, y: string): number {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [px, py] = [parts(x), parts(y)];
  for (let i = 0; i < 3; i++) {
    const d = (px[i] ?? -1) - (py[i] ?? -1);
    if (d !== 0) return d;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The `format` marker (spec §5): markers only rise, so it folds to the
 * field-by-field maximum, and `requires` follows `compat`. Other keys fold per
 * key, the lower hash breaking a tie.
 */
export function foldMarker(base: Buffer | null, a: Buffer, b: Buffer): Buffer {
  const [x, y] = [keyedLines(a), keyedLines(b)];
  const int = (lines: Map<string, string>, key: string) => {
    const value = lineValue(lines.get(key) ?? 'null');
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  };
  const str = (lines: Map<string, string>, key: string) => {
    const value = lineValue(lines.get(key) ?? 'null');
    return typeof value === 'string' ? value : null;
  };
  const max = (p: number | null, q: number | null) => (p === null ? q : q === null ? p : Math.max(p, q));
  const [cx, cy] = [int(x, 'compat'), int(y, 'compat')];
  const [rx, ry] = [str(x, 'requires'), str(y, 'requires')];
  const requires =
    cx !== cy
      ? (cx ?? -Infinity) > (cy ?? -Infinity)
        ? rx
        : ry
      : rx === null || ry === null
        ? (rx ?? ry)
        : compareVersions(rx, ry) >= 0
          ? rx
          : ry;
  const known = new Set(['format', 'compat', 'requires']);
  const strip = (lines: Map<string, string>) => new Map([...lines].filter(([key]) => !known.has(key)));
  const rest = foldKeyed(strip(keyedLines(base)), strip(x), strip(y), (_key, p, q) => (sha256(p) <= sha256(q) ? p : q));
  const lines = [
    ...[
      ['format', max(int(x, 'format'), int(y, 'format'))],
      ['compat', max(cx, cy)],
      ['requires', requires],
    ]
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    ...[...rest].sort(byKey).map(([key, raw]) => `${key}: ${raw}`),
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/**
 * The conflict record a delete against an edit leaves: the issue was edited
 * on one side after the base, so it stays, and the delete is set aside.
 */
export function deleteConflict(tombstone: Buffer | null, edited: Buffer | null): Buffer {
  const deleted: Record<string, unknown> = {};
  if (tombstone) {
    const text = tombstone.toString('utf8');
    const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
    for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) deleted[key] = lineValue(raw);
  }
  const at = typeof deleted.at === 'string' ? deleted.at : '';
  return serializeConflict({
    fields: [DELETED_FIELD],
    kept: { [DELETED_FIELD]: false },
    theirs: { [DELETED_FIELD]: Object.keys(deleted).length > 0 ? deleted : true },
    base: { [DELETED_FIELD]: false },
    at: at || (edited ? parseIssue(edited).updated_at : ''),
  });
}
