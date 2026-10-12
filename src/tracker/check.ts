// The tracker store's own health checks (spec §12 doctor, the store): what
// only the store can say about its refs and records, read straight from git
// without the merged view, so a record the view can't parse is reported
// rather than failing the whole report. Read-only: nothing here writes, and
// `removeStaleRefLocks` is the one repair (`doctor --fix`).
//
// - Records: each file grimoire's format names is parsed and compared with
//   what the canonical serializer writes, or, where the reader keeps no
//   unknown keys, checked line by line against the canonical form; records
//   named by a sha256 must hash to their names. Files this release doesn't
//   know are kept as they are (spec §5) and never reported. Records filed
//   under another id, and content a purge tombstone says is gone. Formats
//   another module owns (the skill ledger's records, capture's session
//   records) are checked through the hooks it hands in (`RecordFormats`).
// - History: edits to write-once files, commits grimoire didn't make, and
//   knowledge records committed without grimoire's trailers.
// - Refs: ref locks older than ~30 s, refs whose names block a tracker ref,
//   and how far the local and remote-tracking trackers moved apart.
import { createHash } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ObjectReader } from '../git/batch';
import { runGit } from '../git/run';
import { ATTEMPT_PATTERN, parseEnd, parseOutcome, parseStart, serializeEnd, serializeOutcome, serializeStart } from './attempt';
import { commentEntry } from './comment';
import { conflictName, parseConflict } from './conflict';
import { shardOf } from './ids';
import { GITATTRIBUTES, GITATTRIBUTES_FILE, FORMAT_FILE, LEDGER_DIR, SESSIONS_DIR, SETTINGS_FILE, SKILL_VERSIONS_DIR, TRACKER_REF } from './layout';
import { lineValue, parseLines } from './lines';
import { isQuarantineKind, QUARANTINE_KEYS } from './quarantine';
import { parseIssue, serializeIssue } from './record';
import { parseForward, parseTombstone, serializeForward, serializeTombstone } from './retired';
import { STALE_REF_LOCK_MS } from './store';
import { parsePage, serializePage, WIKI_CONFLICT_KEYS, WIKI_DIR, WIKI_EDIT_KEYS } from './wiki';

export type StoreSeverity = 'error' | 'warning' | 'info';

/** One thing the store checks found. */
export interface StoreFinding {
  /** What was found: `unparsable`, `non-canonical`, … */
  readonly kind: string;
  readonly severity: StoreSeverity;
  /** One line a person reads. */
  readonly message: string;
  /** The tracker path, ref or lock file it is about. */
  readonly subject?: string;
  readonly details?: { readonly [key: string]: string | number | boolean | null };
}

/** The tracker tips this clone holds: the local ref and each remote-tracking one. */
export interface TrackerTips {
  readonly local: string | null;
  /** By remote name. */
  readonly remotes: ReadonlyMap<string, string>;
}

/** The tracker refs as `git for-each-ref` lists them. */
export async function trackerTips(root: string): Promise<TrackerTips> {
  const run = await runGit(root, ['for-each-ref', '--format=%(objectname) %(refname)', TRACKER_REF, 'refs/remotes/']);
  let local: string | null = null;
  const remotes = new Map<string, string>();
  for (const line of run.code === 0 ? run.stdout.toString('utf8').split('\n') : []) {
    const [oid, ref] = line.trim().split(' ');
    if (!oid || !ref) continue;
    if (ref === TRACKER_REF) local = oid;
    const remote = /^refs\/remotes\/(.+)\/grimoire\/tracker$/.exec(ref)?.[1];
    if (remote !== undefined) remotes.set(remote, oid);
  }
  return { local, remotes };
}

/** One file of a tracker tree. */
interface TreeFile {
  readonly path: string;
  readonly oid: string;
}

async function treeFiles(root: string, tip: string): Promise<TreeFile[]> {
  const run = await runGit(root, ['ls-tree', '-r', '-z', '--full-tree', tip]);
  if (run.code !== 0) return [];
  return run.stdout
    .toString('utf8')
    .split('\0')
    .flatMap((entry) => {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
      return match ? [{ oid: match[1]!, path: match[2]! }] : [];
    });
}

/** Why a record isn't what grimoire writes: `unparsable` or `non-canonical`, with the reason. */
export interface RecordProblem {
  readonly kind: 'unparsable' | 'non-canonical';
  readonly why: string;
}

type RecordVerdict = RecordProblem | null;

/** Checks for record formats another module owns, handed in by whoever runs the store checks. */
export interface RecordFormats {
  /**
   * A skill ledger record (any kind but a quarantine's), already known to be
   * named by the sha256 of its bytes: what's wrong with it, or null.
   */
  readonly ledgerRecord?: (id: string, bytes: Buffer) => RecordProblem | null;
  /** A session record (capture's), its lines already known to be canonical: what's wrong with it, or null. */
  readonly sessionRecord?: (bytes: Buffer) => RecordProblem | null;
}

const unparsable = (why: string): RecordVerdict => ({ kind: 'unparsable', why });
const nonCanonical = (why: string): RecordVerdict => ({ kind: 'non-canonical', why });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Text as UTF-8, or null when the bytes aren't valid UTF-8. */
function utf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/**
 * CR where grimoire writes LF. A body is its author's verbatim bytes (a
 * Windows tool's output keeps its CRLF), so with a body only the
 * frontmatter, through its closing `---` line, must be LF-only.
 */
function hasForeignCR(text: string, body: boolean): boolean {
  if (!body) return text.includes('\r');
  const close = /\n---\r?\n/.exec(text.slice(3));
  return (close ? text.slice(0, 3 + close.index + close[0].length) : text).includes('\r');
}

/** Compares a record with what its serializer writes back from what it parsed (the serializer judges any body). */
function roundTrip(bytes: Buffer, rewrite: (bytes: Buffer) => Buffer): RecordVerdict {
  const text = utf8(bytes);
  if (text === null) return unparsable('it is not UTF-8 text');
  if (hasForeignCR(text, true)) return nonCanonical('it has CR line ends; grimoire writes LF');
  if (!text.startsWith('---\n')) return unparsable('it has no frontmatter');
  let written: Buffer;
  try {
    written = rewrite(bytes);
  } catch (error) {
    return unparsable(error instanceof Error ? error.message : String(error));
  }
  return written.equals(bytes) ? null : nonCanonical('it differs from what the canonical serializer writes for it');
}

/**
 * A frontmatter record whose reader keeps no unknown keys (comments, activity
 * entries): one `key: <JSON>` line each, the known keys in their order and
 * any unknown ones after them, sorted (spec §3, §5). A null `order` checks
 * the lines alone, for a record whose key order this release can't know.
 */
function canonicalFrontmatter(bytes: Buffer, order: readonly string[] | null, body: boolean): RecordVerdict {
  const text = utf8(bytes);
  if (text === null) return unparsable('it is not UTF-8 text');
  if (hasForeignCR(text, body)) return nonCanonical('it has CR line ends; grimoire writes LF');
  if (!text.startsWith('---\n')) return unparsable('it has no frontmatter');
  const close = text.indexOf('\n---\n', 3);
  if (close < 0) return unparsable('its frontmatter is not closed');
  if (!body && close + 5 !== text.length) return nonCanonical('it has text after its frontmatter');
  const keys: string[] = [];
  for (const line of text.slice(4, close).split('\n')) {
    const match = /^([^\s:][^:]*): (.*)$/.exec(line);
    if (!match) return nonCanonical(`its frontmatter line ${JSON.stringify(line)} is not \`key: value\``);
    let value: unknown;
    try {
      value = JSON.parse(match[2]!);
    } catch {
      return nonCanonical(`its ${match[1]} value is not JSON`);
    }
    if (JSON.stringify(value) !== match[2]) return nonCanonical(`its ${match[1]} value is not written the canonical way`);
    keys.push(match[1]!);
  }
  if (new Set(keys).size !== keys.length) return nonCanonical('a frontmatter key is repeated');
  if (order === null) return null;
  const known = keys.filter((key) => order.includes(key));
  const unknown = keys.filter((key) => !order.includes(key));
  const expected = [...[...known].sort((a, b) => order.indexOf(a) - order.indexOf(b)), ...[...unknown].sort()];
  if (expected.join('\n') !== keys.join('\n')) return nonCanonical('its frontmatter keys are out of the canonical order');
  return null;
}

/** `key: <JSON>` lines (the `format` marker): each canonical, LF-ended. */
function canonicalLines(bytes: Buffer, sorted: boolean): RecordVerdict {
  const text = utf8(bytes);
  if (text === null) return unparsable('it is not UTF-8 text');
  if (text.includes('\r')) return nonCanonical('it has CR line ends; grimoire writes LF');
  if (text !== '' && !text.endsWith('\n')) return nonCanonical('its last line has no line end');
  const lines = text === '' ? [] : text.slice(0, -1).split('\n');
  if (parseLines(text).length !== lines.length) return nonCanonical('a line is not `key: value`');
  const keys = parseLines(text).map((line) => line.key);
  if (sorted && keys.join('\n') !== [...keys].sort().join('\n')) return nonCanonical('its keys are not in key order');
  if (new Set(keys).size !== keys.length) return nonCanonical('a key is repeated');
  return null;
}

const COMMENT_KEYS = ['actor', 'at', 'kind', 'attempt', 'key'];
const ACTIVITY_KEYS = ['actor', 'at', 'kind', 'attempt', 'fields'];
const SHA256_NAME = /^[0-9a-f]{64}$/;

/** A write-once record named by the sha256 of its bytes (`<sha256>.md`): null when it is. */
function contentNamed(fileName: string, bytes: Buffer, what: string): RecordVerdict {
  const name = fileName.slice(0, -'.md'.length);
  if (!SHA256_NAME.test(name)) return nonCanonical(`${what} is named by the sha256 of its bytes`);
  return sha256(bytes) === name ? null : nonCanonical('its file name is not the sha256 of its bytes');
}

/** A frontmatter value, or undefined when the record has no such line. */
function frontmatterValue(bytes: Buffer, key: string): unknown {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const line = close < 0 ? undefined : parseLines(text.slice(4, close)).find((entry) => entry.key === key);
  return line === undefined ? undefined : lineValue(line.raw);
}

/**
 * The knowledge records (spec §17, §18): wiki pages round-trip through their
 * serializer; set-aside sides, human wiki edits, ledger records and skill
 * versions are named by the sha256 of their bytes, and their frontmatter is
 * canonical. The wiki's index and log are derived, regenerated by every
 * write: they are no record.
 */
function checkKnowledge(parts: readonly string[], bytes: Buffer, formats: RecordFormats): RecordVerdict | undefined {
  const file = parts.join('/');
  const last = parts[parts.length - 1]!;
  if (!last.endsWith('.md')) return undefined;
  if (file.startsWith(`${WIKI_DIR}/`)) {
    const [, , dir] = parts;
    if (dir === 'pages' && parts.length === 4) return roundTrip(bytes, (b) => serializePage(parsePage(last.slice(0, -3), b)));
    if (dir === 'conflicts' && parts.length === 5) return contentNamed(last, bytes, 'a set-aside side') ?? canonicalFrontmatter(bytes, WIKI_CONFLICT_KEYS, true);
    if (dir === 'edits' && parts.length === 4) return contentNamed(last, bytes, 'a wiki edit record') ?? canonicalFrontmatter(bytes, WIKI_EDIT_KEYS, false);
    return undefined;
  }
  if (file.startsWith(`${LEDGER_DIR}/`) && parts.length === 3) {
    const named = contentNamed(last, bytes, 'a ledger record');
    if (named) return named;
    if (isQuarantineKind(frontmatterValue(bytes, 'kind'))) return canonicalFrontmatter(bytes, QUARANTINE_KEYS, false);
    return formats.ledgerRecord ? formats.ledgerRecord(last.slice(0, -3), bytes) : null;
  }
  if (file.startsWith(`${SKILL_VERSIONS_DIR}/`) && parts.length === 3) return contentNamed(last, bytes, 'a skill version');
  return undefined;
}

/** What grimoire's format says about the file at `file`, or undefined for a file this release doesn't know. */
function checkRecord(file: string, bytes: Buffer, formats: RecordFormats): RecordVerdict | undefined {
  if (file === FORMAT_FILE) return canonicalLines(bytes, false);
  if (file === SETTINGS_FILE) return canonicalLines(bytes, true);
  if (file === GITATTRIBUTES_FILE) return bytes.toString('utf8') === GITATTRIBUTES ? null : nonCanonical(`it should read ${JSON.stringify(GITATTRIBUTES)}`);
  const parts = file.split('/');
  if (parts[0] === 'issues' && parts.length >= 5) {
    if (parts.length === 5 && parts[4] === 'issue.md') return roundTrip(bytes, (b) => serializeIssue(parseIssue(b)));
    if (parts.length === 6 && parts[4] === 'comments' && parts[5]!.endsWith('.md')) {
      if (!commentEntry(parts[5]!.slice(0, -3))) return nonCanonical('its file name is not a comment name (<utc-ms>-<n>-<rand4>)');
      return canonicalFrontmatter(bytes, COMMENT_KEYS, true);
    }
    if (parts.length === 6 && parts[4] === 'conflicts' && parts[5]!.endsWith('.md')) {
      const verdict = canonicalFrontmatter(bytes, ['fields', 'kept', 'theirs', 'base', 'at'], false);
      if (verdict) return verdict;
      parseConflict(bytes);
      return conflictName(bytes) === parts[5]!.slice(0, -3) ? null : nonCanonical('its file name is not the sha256 of its bytes');
    }
    return undefined;
  }
  if (parts[0] === 'attempts' && parts.length >= 6) {
    const name = parts.slice(5).join('/');
    if (name === 'start.md') return roundTrip(bytes, (b) => serializeStart(parseStart(b)));
    if (name === 'end.md') return roundTrip(bytes, (b) => serializeEnd(parseEnd(b)));
    if (name === 'issue-at-start.md') return roundTrip(bytes, (b) => serializeIssue(parseIssue(b)));
    if (parts.length === 7 && parts[5] === 'activity' && parts[6]!.endsWith('.md')) return canonicalFrontmatter(bytes, [...COMMENT_KEYS, ...ACTIVITY_KEYS.filter((key) => !COMMENT_KEYS.includes(key))], true);
    // Session records (spec §14): here, the shared line format and the excerpt body; capture owns their keys (`sessionRecord`).
    if (parts.length === 7 && parts[5] === SESSIONS_DIR && parts[6]!.endsWith('.md')) return canonicalFrontmatter(bytes, null, true) ?? formats.sessionRecord?.(bytes) ?? null;
    return undefined;
  }
  if (parts[0] === 'outcomes' && parts.length === 5 && parts[4]!.endsWith('.md')) return roundTrip(bytes, (b) => serializeOutcome(parseOutcome(b)));
  if (parts[0] === 'deleted' && parts.length === 2 && parts[1]!.endsWith('.md')) return roundTrip(bytes, (b) => serializeTombstone(parseTombstone(b)));
  if (parts[0] === 'forwards' && parts.length === 2 && parts[1]!.endsWith('.md')) return roundTrip(bytes, (b) => serializeForward(parseForward(b)));
  if (parts[0] === 'keys' && parts.length === 4 && parts[3]!.endsWith('.json')) {
    const text = utf8(bytes);
    if (text === null) return unparsable('it is not UTF-8 text');
    try {
      JSON.parse(text);
      return null;
    } catch {
      return unparsable('it is not JSON');
    }
  }
  if (parts[0] === 'knowledge') return checkKnowledge(parts, bytes, formats);
  return undefined;
}

/** Where an issue's files belong: its shard (`issues/<a>/<b>/<id>/`) must be the id's. */
function misplaced(file: string): string | null {
  const parts = file.split('/');
  if ((parts[0] !== 'issues' && parts[0] !== 'attempts' && parts[0] !== 'outcomes') || parts.length < 5) return null;
  const id = parts[3]!;
  const [a, b] = shardOf(id);
  return parts[1] === a && parts[2] === b ? null : `${parts.slice(0, 4).join('/')} is not under ${id}'s shard ${parts[0]}/${a}/${b}/`;
}

/** Reads every blob of `files` through one `git cat-file --batch`. */
async function readBlobs(root: string, files: readonly TreeFile[]): Promise<Map<string, Buffer>> {
  const reader = new ObjectReader(root);
  try {
    const unique = [...new Set(files.map((file) => file.oid))];
    const objects = await Promise.all(unique.map((oid) => reader.read(oid)));
    return new Map(unique.flatMap((oid, i) => (objects[i] ? [[oid, objects[i]!.content] as const] : [])));
  } finally {
    await reader.close();
  }
}

/** Of an issue directory's record: the id it holds when that doesn't name the directory (`<id>`, or `<id>~<hash4>` for a side of a collision). */
function idOfRecord(file: string, bytes: Buffer): string | null {
  const parts = file.split('/');
  if (parts[0] !== 'issues' || parts.length !== 5 || parts[4] !== 'issue.md') return null;
  let id: string;
  try {
    id = parseIssue(bytes).id;
  } catch {
    return null;
  }
  const dir = parts[3]!;
  return id === dir || dir.startsWith(`${id}~`) ? null : id;
}

/** The paths a purge tombstone says are gone: an attempt's, one session record's, or a proposal's. */
function purgedPaths(tombstone: string, paths: readonly string[]): string[] {
  const parts = tombstone.split('/');
  if (parts[0] !== 'purges' || !tombstone.endsWith('.md')) return [];
  if (parts.length === 3) {
    // purges/<attempt>/<session-key>.md: that one session record.
    const [attempt, key] = [parts[1]!, parts[2]!];
    return paths.filter((file) => {
      const p = file.split('/');
      return p[0] === 'attempts' && p[4] === attempt && p[5] === 'sessions' && p[6] === key;
    });
  }
  if (parts.length !== 2) return [];
  const name = parts[1]!.slice(0, -3);
  if (ATTEMPT_PATTERN.test(name)) {
    return paths.filter((file) => {
      const p = file.split('/');
      return (p[0] === 'attempts' && p[4] === name) || (p[0] === 'outcomes' && p.length === 5 && p[4] === `${name}.md`);
    });
  }
  return paths.filter((file) => file.startsWith('knowledge/proposals/') && file.split('/').some((p) => p === name || p === `${name}.md`));
}

export interface TreeInspection {
  /** Unparsable, non-canonical and misplaced records, and records filed under another id (`duplicate-id`). */
  readonly records: StoreFinding[];
  /** Content a purge tombstone says is gone but a tree still holds (`purged-present`). */
  readonly purged: StoreFinding[];
}

/**
 * The checks over the files of every tracker tip this clone holds (the local
 * ref and each remote-tracking one). A file is reported once however many
 * tips hold it.
 */
export async function inspectTrees(root: string, tips: TrackerTips, formats: RecordFormats = {}): Promise<TreeInspection> {
  const heads = [...new Set([tips.local, ...tips.remotes.values()].filter((tip): tip is string => tip !== null))];
  const seen = new Set<string>();
  const files: TreeFile[] = [];
  const records: StoreFinding[] = [];
  const purged: StoreFinding[] = [];
  for (const tip of heads) {
    const tree = await treeFiles(root, tip);
    const paths = tree.map((file) => file.path);
    for (const file of tree) {
      const left = purgedPaths(file.path, paths);
      const name = file.path.slice('purges/'.length, -'.md'.length);
      if (left.length > 0 && !purged.some((finding) => finding.subject === name)) {
        purged.push({
          kind: 'purged-present',
          severity: 'error',
          subject: name,
          message: `${name} was purged (${file.path}), but the tracker${tip === tips.local ? '' : ' a remote holds'} still has ${left.join(', ')}`,
          details: { tombstone: file.path, tip },
        });
      }
      const key = `${file.path}\0${file.oid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
  }
  const blobs = await readBlobs(root, files);
  for (const file of files) {
    const bytes = blobs.get(file.oid);
    if (!bytes) {
      records.push({ kind: 'unparsable', severity: 'error', subject: file.path, message: `${file.path}: its object ${file.oid} is missing from this clone` });
      continue;
    }
    let verdict: RecordVerdict | undefined;
    try {
      verdict = checkRecord(file.path, bytes, formats);
    } catch (error) {
      verdict = unparsable(error instanceof Error ? error.message : String(error));
    }
    if (verdict) {
      records.push({
        kind: verdict.kind,
        severity: 'error',
        subject: file.path,
        message: `${file.path} is ${verdict.kind === 'unparsable' ? 'unparsable' : 'not canonical'}: ${verdict.why}`,
        details: { blob: file.oid },
      });
    }
    const wrongShard = file.path.split('/').length === 5 ? misplaced(file.path) : null;
    if (wrongShard) records.push({ kind: 'misplaced', severity: 'error', subject: file.path, message: wrongShard });
    const claimed = idOfRecord(file.path, bytes);
    if (claimed !== null) {
      records.push({
        kind: 'duplicate-id',
        severity: 'error',
        subject: file.path,
        message: `${file.path} holds the record of ${claimed}, filed under another id`,
        details: { id: claimed },
      });
    }
  }
  return { records, purged };
}

// ---------------------------------------------------------------------------
// History: write-once edits, foreign commits, knowledge records without trailers.

/** Files grimoire writes once and never edits (spec §3, §18): comments, the attempt's files, activity entries, ledger records, skill versions. */
function writeOnce(file: string): boolean {
  const p = file.split('/');
  if (p[0] === 'issues') return p.length === 6 && p[4] === 'comments';
  if (p[0] === 'attempts') return (p.length === 6 && ['start.md', 'issue-at-start.md', 'end.md'].includes(p[5]!)) || (p.length === 7 && p[5] === 'activity');
  return file.startsWith('knowledge/ledger/') || file.startsWith('knowledge/skill-versions/');
}

/** The trailers every grimoire commit carries (spec §3, Commits). */
const TRAILERS = ['Grimoire-Actor', 'Grimoire-Op', 'Grimoire-Version'] as const;

interface LoggedCommit {
  readonly oid: string;
  readonly trailers: Readonly<Record<string, string>>;
  /** Each changed path with its status letters (one per parent in a merge). */
  readonly changes: readonly { readonly path: string; readonly status: string }[];
}

async function logCommits(root: string, heads: readonly string[]): Promise<LoggedCommit[]> {
  const fields = ['%H', ...TRAILERS.map((key) => `%(trailers:key=${key},valueonly,separator=%x2c)`)].join('%x1f');
  // -c: a merge lists only the paths that differ from every parent.
  const run = await runGit(root, ['-c', 'core.quotePath=false', 'log', '-c', '--raw', '--no-renames', '--no-abbrev', `--format=%x1e${fields}`, ...heads]);
  if (run.code !== 0) return [];
  return run.stdout
    .toString('utf8')
    .split('\x1e')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const [header = '', ...lines] = chunk.split('\n');
      const [oid = '', ...values] = header.split('\x1f');
      const trailers: Record<string, string> = {};
      TRAILERS.forEach((key, i) => {
        const value = (values[i] ?? '').trim();
        if (value !== '') trailers[key] = value;
      });
      const changes = lines.flatMap((line) => {
        const match = /^:+([^\t]+)\t(.+)$/.exec(line);
        if (!match) return [];
        const words = match[1]!.trim().split(/\s+/);
        return [{ path: match[2]!, status: words.at(-1)!.replace(/\d+$/, '') }];
      });
      return { oid, trailers, changes };
    });
}

/** Write-once edits, foreign commits and knowledge records without grimoire's trailers, over every tracker tip's history. */
export async function checkHistory(root: string, tips: TrackerTips): Promise<StoreFinding[]> {
  const heads = [...new Set([tips.local, ...tips.remotes.values()].filter((tip): tip is string => tip !== null))];
  if (heads.length === 0) return [];
  const findings: StoreFinding[] = [];
  for (const commit of await logCommits(root, heads)) {
    const missing = TRAILERS.filter((key) => commit.trailers[key] === undefined);
    const short = commit.oid.slice(0, 12);
    if (missing.length > 0) {
      const knowledge = commit.changes.filter((change) => change.path.startsWith('knowledge/'));
      findings.push(
        knowledge.length > 0
          ? {
              kind: 'knowledge-without-trailers',
              severity: 'error',
              subject: commit.oid,
              message: `commit ${short} changed knowledge records (${knowledge.map((change) => change.path).join(', ')}) without grimoire's trailers (${missing.join(', ')})`,
              details: { commit: commit.oid, missing: missing.join(', ') },
            }
          : {
              kind: 'foreign-commit',
              severity: 'warning',
              subject: commit.oid,
              message: `commit ${short} on the tracker was not made by grimoire (it has no ${missing.join(', ')})`,
              details: { commit: commit.oid, missing: missing.join(', ') },
            },
      );
    }
    for (const change of commit.changes) {
      if (writeOnce(change.path) && change.status.includes('M')) {
        findings.push({
          kind: 'write-once-edit',
          severity: 'error',
          subject: change.path,
          message: `${change.path} is written once, but commit ${short} changed it`,
          details: { commit: commit.oid },
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Refs: stale ref locks, directory/file conflicts, ahead and behind.

/** The lock files that block the tracker refs, relative to the git common directory. */
async function refLockCandidates(commonDir: string): Promise<string[]> {
  const candidates = ['refs/grimoire/tracker.lock', 'packed-refs.lock', 'reftable/tables.list.lock'];
  for (const remote of await readdir(path.join(commonDir, 'refs', 'remotes')).catch(() => [] as string[])) {
    candidates.push(`refs/remotes/${remote}/grimoire/tracker.lock`);
  }
  return candidates;
}

export interface RefLock {
  /** Relative to the git common directory, with forward slashes. */
  readonly name: string;
  readonly file: string;
  readonly ageMs: number;
}

/** The ref locks on the tracker refs older than ~30 s. */
export async function staleRefLocks(commonDir: string): Promise<RefLock[]> {
  const locks: RefLock[] = [];
  for (const name of await refLockCandidates(commonDir)) {
    const file = path.join(commonDir, ...name.split('/'));
    const info = await stat(file).catch(() => null);
    const age = info ? Date.now() - info.mtimeMs : 0;
    if (info?.isFile() && age > STALE_REF_LOCK_MS) locks.push({ name, file, ageMs: Math.round(age) });
  }
  return locks;
}

/** Removes the stale ref locks, each checked again right before (one refreshed meanwhile stays). */
export async function removeStaleRefLocks(commonDir: string): Promise<{ removed: RefLock[]; failed: { lock: RefLock; why: string }[] }> {
  const removed: RefLock[] = [];
  const failed: { lock: RefLock; why: string }[] = [];
  for (const lock of await staleRefLocks(commonDir)) {
    const again = (await staleRefLocks(commonDir)).find((candidate) => candidate.name === lock.name);
    if (!again) continue;
    try {
      await unlink(lock.file);
      removed.push(again);
    } catch (error) {
      failed.push({ lock: again, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}

/** Refs whose names block a tracker ref (`refs/grimoire`, `refs/remotes/<r>/grimoire`): git can't keep a file and a folder of one name. */
export async function directoryFileConflicts(root: string): Promise<string[]> {
  const run = await runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/grimoire', 'refs/remotes/']);
  if (run.code !== 0) return [];
  return run.stdout
    .toString('utf8')
    .split('\n')
    .map((ref) => ref.trim())
    .filter((ref) => ref === 'refs/grimoire' || /^refs\/remotes\/[^/]+\/grimoire$/.test(ref));
}

/** How far the local tracker and a remote-tracking one moved apart: commits only the local tip has, and only the remote's. */
export async function aheadBehind(root: string, local: string, remote: string): Promise<{ ahead: number; behind: number } | null> {
  const run = await runGit(root, ['rev-list', '--left-right', '--count', `${local}...${remote}`]);
  if (run.code !== 0) return null;
  const [ahead, behind] = run.stdout.toString('utf8').trim().split(/\s+/).map(Number);
  return ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind) ? null : { ahead, behind };
}
