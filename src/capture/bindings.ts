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
import type { BindingCall } from './cut';
import { sessionKey, type SeenHereRow } from './seen-here';

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
}

/** The ops whose binding writes end the attempt (spec §14: an ending call). */
const ENDING_OPS = new Set(['close', 'release', 'reassign']);

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
      `--format=%H${FIELD}%ae${FIELD}%cI${FIELD}%B${RECORD}`,
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
    const [commit, person, at, message] = record.replace(/^\n/, '').split(FIELD);
    if (!commit || message === undefined) continue;
    const trailers = trailersOf(message);
    if (trailers.get('Grimoire-Attempt') !== attempt.id) continue;
    bindings.push({
      commit,
      op: trailers.get('Grimoire-Op') ?? '',
      issue: trailers.get('Grimoire-Issue') ?? null,
      attempt: attempt.id,
      person: person ?? '',
      at: at ?? '',
      actor: actorOf(trailers.get('Grimoire-Actor')),
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
  /** Each binding write as the cut looks for it: by call id, else by operation and time (T6's fallback). */
  readonly bindingCalls: readonly BindingCall[];
  /** Bound only through `update` or `comment`: its window ends with its last turn naming the issue. */
  readonly writeOnly: boolean;
  /** This machine's seen-here row for it, when there is one. */
  readonly row: SeenHereRow | null;
}

const keyOfActor = (actor: Readonly<Record<string, string>>): string =>
  sessionKey({
    client: actor.client ?? '',
    nonce: actor.nonce ?? '',
    ...(actor.session !== undefined ? { session: actor.session } : {}),
    ...(actor.context !== undefined ? { context: actor.context } : {}),
  });

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
      context: latest.context ?? null,
      bindings: writes,
      bindingCalls: writes.map((write): BindingCall =>
        write.actor.call !== undefined ? { id: write.actor.call, at: write.at } : { grimoire: write.op, at: write.at },
      ),
      writeOnly: writes.every((write) => write.op !== 'claim' && !ENDING_OPS.has(write.op)),
      row: rowsByKey.get(`${writes[0]!.attempt}/${key}`) ?? null,
    };
  });
}

/**
 * The attempt's worker kind (spec §14, Worker kind): `agent` when any binding
 * write by the attempt's own person had an agent actor, otherwise `human`.
 * Another person's agent never changes it.
 */
export function workerKindOf(bindings: readonly Binding[], assignee: string): 'agent' | 'human' {
  return bindings.some((binding) => binding.person === assignee && binding.actor.kind === 'agent') ? 'agent' : 'human';
}
