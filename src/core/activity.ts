// `activity` (spec §20, dashboard read ops): the tracker's writes, newest
// first, as their commits' trailers record them (spec §3, Commits): the
// person (the commit's author), the observed actor (client, session; ids
// only), the op, the issue and the attempt. An `update` or `resolve` also
// names the issue fields it changed, read from the issue record before and
// after. The issue timeline reads one issue's; the activity feed reads all.
//
// It reads the history the view beside it shows (ADR 0007): both tips of a
// fold, not the local tip alone.
import { invalid } from '../errors';
import { runGit } from '../git/run';
import { issueFile } from '../tracker/layout';
import { parseIssue, type IssueRecord } from '../tracker/record';
import { decodeCursor, encodeCursor } from './budget';
import { define, oneLine } from './op';
import { s } from './schema';

export interface ActivityEntry {
  commit: string;
  /** The commit's time. */
  at: string;
  /** `Grimoire-Op`: create, update, comment, claim, close, … */
  op: string;
  issue: string | null;
  attempt: string | null;
  /** The person who made the write (the commit's author email). */
  person: string;
  /** `Grimoire-Actor`: kind, client, session, context (ids only); empty when it can't be read. */
  actor: Record<string, string>;
  /** An update or resolve: the issue fields it changed, by name. */
  fields?: string[];
}

export interface ActivityResult {
  entries: ActivityEntry[];
  /** Continues with older writes; null when nothing is left. */
  cursor: string | null;
}

const FIELD = '\x1f';
const RECORD = '\x1e';
/** The ops whose entries name the issue fields they changed. */
const FIELD_OPS = new Set(['update', 'resolve']);
const COMPARED = ['title', 'status', 'body', 'labels', 'parent', 'blocked_by', 'links'] as const;

function trailersOf(message: string): Map<string, string> {
  const trailers = new Map<string, string>();
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
  for (const line of (paragraphs.at(-1) ?? '').split('\n')) {
    const match = /^(Grimoire-[A-Za-z]+): (.*)$/.exec(line);
    if (match && !trailers.has(match[1]!)) trailers.set(match[1]!, match[2]!);
  }
  return trailers;
}

function actorOf(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const actor: Record<string, string> = {};
    // The nonce identifies a process, not a person or session: readers don't need it.
    for (const [key, field] of Object.entries(parsed)) if (typeof field === 'string' && key !== 'nonce') actor[key] = field;
    return actor;
  } catch {
    return {};
  }
}

/** Blobs by `<rev>:<path>` through one `git cat-file --batch`; a missing one maps to null. */
export async function readBlobs(root: string, specs: readonly string[]): Promise<Map<string, Buffer | null>> {
  const found = new Map<string, Buffer | null>();
  if (specs.length === 0) return found;
  const run = await runGit(root, ['cat-file', '--batch'], { input: specs.map((spec) => `${spec}\n`).join('') });
  if (run.code !== 0) return found;
  const out = run.stdout;
  let at = 0;
  for (const spec of specs) {
    const newline = out.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = out.subarray(at, newline).toString('utf8').split(' ');
    at = newline + 1;
    if (header.length === 3 && header[1] === 'blob') {
      const size = Number(header[2]);
      found.set(spec, out.subarray(at, at + size));
      at += size + 1;
    } else {
      found.set(spec, null);
      // A tree or commit (not expected here) still carries its content: skip it.
      if (header.length === 3 && /^\d+$/.test(header[2]!)) at += Number(header[2]) + 1;
    }
  }
  return found;
}

function parsed(blob: Buffer | null | undefined): IssueRecord | null {
  if (!blob) return null;
  try {
    return parseIssue(blob);
  } catch {
    return null;
  }
}

type LogOptions = { skip?: number; max?: number; grep?: readonly [string, string] };

/** One write as `git log` gives it: the entry, and its commit's parents. */
interface LogRecord {
  readonly entry: ActivityEntry;
  readonly parents: readonly string[];
}

async function logRecords(root: string, tips: readonly string[], options: LogOptions): Promise<LogRecord[]> {
  const grep = options.grep;
  const run = await runGit(root, [
    'log',
    '--date-order',
    '--no-color',
    `--format=${RECORD}%H${FIELD}%P${FIELD}%ae${FIELD}%cI${FIELD}%B${FIELD}`,
    ...(options.skip ? [`--skip=${options.skip}`] : []),
    ...(options.max !== undefined ? [`--max-count=${options.max}`] : []),
    ...(grep === undefined ? [] : ['--fixed-strings', `--grep=${grep[0]}: ${grep[1]}`]),
    ...tips,
    '--',
  ]);
  if (run.code !== 0) throw new Error(`git log failed reading the tracker's activity: ${run.stderr.trim()}`);
  const records: LogRecord[] = [];
  for (const [commit, parents, person, at, message] of run.stdout
    .toString('utf8')
    .split(RECORD)
    .map((record) => record.split(FIELD))
    .filter(([commit, , , , message]) => commit && message !== undefined)) {
    const trailers = trailersOf(message!);
    records.push({
      entry: {
        commit: commit!,
        at: at ?? '',
        op: trailers.get('Grimoire-Op') ?? '',
        issue: trailers.get('Grimoire-Issue') ?? null,
        attempt: trailers.get('Grimoire-Attempt') ?? null,
        person: person ?? '',
        actor: actorOf(trailers.get('Grimoire-Actor')),
      },
      parents: (parents ?? '').split(' ').filter(Boolean),
    });
  }
  return records;
}

/**
 * The tracker's writes from `tips` back (a view's `parents`: its tip, or both
 * tips of a fold), newest first, as their trailers record them (no field
 * names): `skip` and `max` page through the commits; `grep` keeps only
 * commits whose message holds `<name>: <value>`. The grep matches the text
 * anywhere, so callers check the entry's own field.
 */
export async function logEntries(root: string, tips: readonly string[], options: LogOptions = {}): Promise<ActivityEntry[]> {
  return (await logRecords(root, tips, options)).map((record) => record.entry);
}

const isCommitId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

export const activity = define({
  name: 'activity',
  description: 'The tracker’s writes, newest first, from their commit trailers: person, client and session, op, issue, attempt, and the fields an update changed. Pass `issue` for one issue’s. For people: the dashboard and a person’s terminal.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({
    issue: s.optional(s.string({ ...oneLine, description: 'only this issue’s writes (any read ref)' })),
    limit: s.optional(s.integer({ min: 1, max: 200, description: 'entries per page (default 50)' })),
    cursor: s.optional(s.string(oneLine)),
  }),
  async run(input, { tracker }): Promise<ActivityResult> {
    const view = await tracker.read();
    const issue = input.issue === undefined ? null : view.resolveRead(input.issue, 'issue');
    const limit = input.limit ?? 50;
    // The view's parents: its tip, or both tips of a fold. The cursor pins them, so later writes don't shift the pages.
    let tips: readonly string[];
    let skip = 0;
    if (input.cursor !== undefined) {
      const state = decodeCursor(input.cursor, 'activity') as { t?: unknown; s?: unknown; i?: unknown } | null;
      const pinned = state && Array.isArray(state.t) && state.t.length > 0 && state.t.every(isCommitId) ? (state.t as string[]) : null;
      if (!state || !pinned || typeof state.s !== 'number' || (state.i ?? null) !== issue) {
        throw invalid({ cursor: 'is not a cursor from this activity read; pass the cursor a previous result returned' });
      }
      tips = pinned;
      skip = state.s;
    } else {
      tips = view.parents;
    }
    if (tips.length === 0) return { entries: [], cursor: null };

    const root = tracker.location.root;
    const records = await logRecords(root, tips, { skip, max: limit + 1, ...(issue === null ? {} : { grep: ['Grimoire-Issue', issue] as const }) });
    const more = records.length > limit;
    // The grep matches the text anywhere; the trailer must name the issue.
    const page = records.slice(0, limit).filter(({ entry }) => issue === null || entry.issue === issue);
    const compared = page.filter(({ entry }) => entry.issue !== null && FIELD_OPS.has(entry.op));
    const spec = (commit: string, id: string) => `${commit}:${issueFile(id)}`;
    const blobs = await readBlobs(
      root,
      compared.flatMap(({ entry, parents }) => [entry.commit, ...parents].map((commit) => spec(commit, entry.issue!))),
    );
    for (const { entry, parents } of compared) {
      const after = parsed(blobs.get(spec(entry.commit, entry.issue!)));
      const befores = parents.map((parent) => parsed(blobs.get(spec(parent, entry.issue!))));
      if (!after || befores.length === 0 || !befores.every((before) => before !== null)) continue;
      // A write on a fold commits with both tips as parents: what one side changed came in with the fold. The write
      // changed a field only when its record differs from every parent's.
      entry.fields = COMPARED.filter((field) => befores.every((before) => JSON.stringify(before![field]) !== JSON.stringify(after[field]))).sort();
    }
    return { entries: page.map(({ entry }) => entry), cursor: more ? encodeCursor('activity', { t: tips, s: skip + limit, i: issue }) : null };
  },
});
