// Bindings (spec §14 Binding; §3 Commits): a context binds to an attempt only
// through a write that names the attempt's handle, and only that write carries
// the `Grimoire-Attempt` trailer: the claim, an ending call, and `update` or
// `comment` naming the handle (a takeover's included). `release {abandoned}`,
// reads and every other write leave no trailer, so they bind nothing.
//
// Bindings are read from the trailers, from the attempt's start commit onward,
// filtered by handle, never by a time window. Seen-here rows only say where on
// this machine a bound context ran: a binding without a row is still bound,
// and a row without a matching write is ignored.
import { runGit } from '../git/run';
import type { AttemptRecord } from '../tracker/attempt';
import { issueRevision, parseIssue } from '../tracker/record';
import type { BindingCall } from './cut';
import { contextOf, sessionKey, type SeenHereRow } from './seen-here';

/** One binding write, as its commit records it. */
export interface Binding {
  readonly commit: string;
  /** `Grimoire-Op`: `claim`, `update`, `comment`, `close`, `release`, … */
  readonly op: string;
  /** `Grimoire-Issue`. */
  readonly issue: string | null;
  /** `Grimoire-Attempt`: the handle the write named. */
  readonly attempt: string;
  /** The commit's author: the person who made the write. */
  readonly person: string;
  /** The commit's time (whole seconds). */
  readonly at: string;
  /** `Grimoire-Actor`: the observed identity, ids only; empty when the trailer can't be read. */
  readonly actor: Readonly<Record<string, string>>;
  /**
   * What the write's result printed that names it (spec §10: every CLI write
   * prints its server-minted write id, or the handle for a claim): the handle
   * for a claim or an ending call, the comment's id, the issue's new revision.
   * A CLI call is found by it in its shell tool result (spec §14 CLI calls).
   * Empty when the commit doesn't show it.
   */
  readonly printed: readonly string[];
}

/** The ops whose binding writes end the attempt (spec §14: an ending call). */
const ENDING_OPS = new Set(['close', 'release', 'reassign']);

/** One file a commit changed, as `git log --name-status` lists it. */
interface Changed {
  readonly status: string;
  readonly path: string;
}

function changedFiles(text: string | undefined): Changed[] {
  return (text ?? '').split('\n').flatMap((line) => {
    const match = /^([A-Z])[0-9]*\t(.+)$/.exec(line.trim());
    return match ? [{ status: match[1]!, path: match[2]! }] : [];
  });
}

/**
 * What a binding write's result printed, read back from its commit (spec §3
 * Layout): the handle for a claim or an ending call; for a comment, the name
 * of the comment file it added; for an update, the revision of the issue
 * record it wrote.
 */
async function printedBy(
  repoRoot: string,
  commit: string,
  write: Pick<Binding, 'op' | 'attempt' | 'issue'>,
  files: readonly Changed[],
): Promise<string[]> {
  const { op, attempt, issue } = write;
  if (op === 'claim' || ENDING_OPS.has(op)) return [attempt];
  if (issue === null) return [];
  const issueDir = (file: Changed) => file.path.startsWith('issues/') && file.path.includes(`/${issue}/`);
  if (op === 'comment') {
    const added = files.find((file) => file.status === 'A' && issueDir(file) && /\/comments\/[^/]+\.md$/.test(file.path));
    const id = added && /\/comments\/([^/]+)\.md$/.exec(added.path)?.[1];
    return id ? [id] : [];
  }
  if (op === 'update') {
    const record = files.find((file) => file.status === 'M' && issueDir(file) && file.path.endsWith(`/${issue}/issue.md`));
    if (!record) return [];
    const blob = await runGit(repoRoot, ['cat-file', 'blob', `${commit}:${record.path}`]);
    if (blob.code !== 0) return [];
    try {
      return [issueRevision(parseIssue(blob.stdout))];
    } catch {
      return [];
    }
  }
  return [];
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** The `Grimoire-*` trailers of a commit message: one per line in its last paragraph. */
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
    for (const [key, field] of Object.entries(parsed)) if (typeof field === 'string') actor[key] = field;
    return actor;
  } catch {
    return {};
  }
}

/**
 * The binding writes of `attempt`, oldest first: the commits reachable from
 * `tips` and not from the attempt's start commit whose `Grimoire-Attempt`
 * names its handle. A start commit this clone doesn't have (a shallow
 * history) leaves only the handle to filter by.
 */
export async function readBindings(
  repoRoot: string,
  attempt: Pick<AttemptRecord, 'id' | 'start'>,
  tips: readonly string[],
): Promise<Binding[]> {
  const heads = [...new Set(tips.filter((tip) => tip !== ''))];
  if (heads.length === 0) return [];
  const log = (exclude: readonly string[]) =>
    runGit(repoRoot, [
      'log',
      '--reverse',
      '--topo-order',
      '--no-color',
      '--no-renames',
      '--name-status',
      `--format=${RECORD}%H${FIELD}%ae${FIELD}%cI${FIELD}%B${FIELD}`,
      '--fixed-strings',
      `--grep=Grimoire-Attempt: ${attempt.id}`,
      ...heads,
      ...exclude,
      '--',
    ]);
  const start = attempt.start.start_commit;
  let run = start ? await log([`^${start}`]) : await log([]);
  if (run.code !== 0 && start) run = await log([]);
  if (run.code !== 0) throw new Error(`git log failed reading ${attempt.id}'s bindings: ${run.stderr.trim()}`);
  const bindings: Binding[] = [];
  for (const record of run.stdout.toString('utf8').split(RECORD)) {
    const [commit, person, at, message, files] = record.split(FIELD);
    if (!commit || message === undefined) continue;
    const trailers = trailersOf(message);
    if (trailers.get('Grimoire-Attempt') !== attempt.id) continue;
    const write = { op: trailers.get('Grimoire-Op') ?? '', attempt: attempt.id, issue: trailers.get('Grimoire-Issue') ?? null };
    bindings.push({
      commit,
      ...write,
      person: person ?? '',
      at: at ?? '',
      actor: actorOf(trailers.get('Grimoire-Actor')),
      printed: await printedBy(repoRoot, commit, write, changedFiles(files)),
    });
  }
  return bindings;
}

/** One context bound to an attempt: what the cut needs to find and window its transcript. */
export interface BoundContext {
  /** The session key (spec §3): the name of its session record, and of its seen-here row. */
  readonly key: string;
  readonly client: string | null;
  readonly session: string | null;
  readonly context: string | null;
  /** Its binding writes, oldest first. */
  readonly bindings: readonly Binding[];
  /**
   * Each binding write as the cut looks for it: by call id; else (a CLI call,
   * or a Codex MCP call without `callId`) by what it printed, its operation and
   * the time grimoire saw it.
   */
  readonly bindingCalls: readonly BindingCall[];
  /** Bound only through `update` or `comment`: its window ends with its last turn naming the issue. */
  readonly writeOnly: boolean;
  /** This machine's seen-here row for it, when there is one. */
  readonly row: SeenHereRow | null;
}

/** A trailer's actor as the session key reads it. */
const factsOf = (actor: Readonly<Record<string, string>>) => ({
  client: actor.client ?? '',
  nonce: actor.nonce ?? '',
  ...(actor.session !== undefined ? { session: actor.session } : {}),
  ...(actor.context !== undefined ? { context: actor.context } : {}),
});

const keyOfActor = (actor: Readonly<Record<string, string>>): string => sessionKey(factsOf(actor));

const keyOfRow = (row: SeenHereRow): string =>
  sessionKey({
    client: row.client,
    nonce: row.nonce,
    ...(row.session !== null ? { session: row.session } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  });

/**
 * Groups binding writes by context (session key), in the order each context
 * first bound, and attaches this machine's seen-here row for each. Rows of
 * another attempt, or with no binding write of theirs among `bindings`, are
 * ignored.
 */
export function boundContexts(bindings: readonly Binding[], rows: readonly SeenHereRow[]): BoundContext[] {
  const groups = new Map<string, Binding[]>();
  for (const binding of bindings) {
    const key = keyOfActor(binding.actor);
    const group = groups.get(key);
    if (group) group.push(binding);
    else groups.set(key, [binding]);
  }
  const rowsByKey = new Map<string, SeenHereRow>();
  for (const row of rows) {
    if (bindings.some((binding) => binding.attempt === row.handle)) rowsByKey.set(`${row.handle}/${keyOfRow(row)}`, row);
  }
  return [...groups].map(([key, writes]) => {
    const latest = writes.at(-1)!.actor;
    return {
      key,
      client: latest.client ?? null,
      session: latest.session ?? null,
      context: contextOf(factsOf(latest)),
      bindings: writes,
      bindingCalls: writes.map((write): BindingCall =>
        write.actor.call !== undefined
          ? { id: write.actor.call, at: write.at }
          : { grimoire: write.op, printed: write.printed, at: write.at },
      ),
      writeOnly: writes.every((write) => write.op !== 'claim' && !ENDING_OPS.has(write.op)),
      row: rowsByKey.get(`${writes[0]!.attempt}/${key}`) ?? null,
    };
  });
}
