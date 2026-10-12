// The chore ops (spec §8 tools, §16; ADR 0006): `chore_start` admits a caller
// grimoire can tell holds no open attempt and starts a run of the due chore;
// `chore_read` pages what grimoire serves the run, recording each item;
// `chore_abandon` ends a run consuming nothing. The knowledge engine
// (src/knowledge/chores) holds the rules; these are thin over it.
//
// The core also guards two things on every call (createCore): a claim or
// issue write from a context holding an open chore run is NOT_ISOLATED, and a
// write from a chore-exposed session or process carries the exposure basis on
// its actor (spec §14 Wiki-exposed).
import { GrimoireError } from '../errors';
import {
  checkAttemptFree,
  choreContextKey,
  chorePairs,
  choresDue,
  classifyCaller,
  exposureOf,
  lapsed,
  listRuns,
  live,
  liveRunOf,
  logServed,
  markExposure,
  OUTPUT_SCHEMAS,
  pageCount,
  pageOf,
  pageStart,
  pruneRuns,
  readRun,
  Serving,
  writeRun,
  LEASE_MS,
  type ChoreOrigin,
  type ChoresDue,
  type ChoreThresholds,
  type OpenRun,
  type ServedItem,
} from '../knowledge/chores';
import { observedEvidence } from '../capture/evidence';
import { LockHeldError, MachineLocalStore } from '../machine-local';
import { CHORE_KINDS, randomRunId, type ChoreKind, type TrackerStore, type TrackerView } from '../tracker';
import type { SecretScanner } from '../scanner';
import type { Actor, CallContext } from './context';
import { define, oneLine } from './op';
import { s } from './schema';
import { storeSetting } from './settings';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The store settings due-ness reads (spec §16: every threshold is a store setting). */
export function choreThresholds(view: Pick<TrackerView, 'settings'>): ChoreThresholds {
  const n = (key: string) => storeSetting(view, key) as number;
  return {
    paused: storeSetting(view, 'knowledge.loop') === 'paused',
    settleMs: n('chores.settle_hours') * HOUR,
    compilePairs: n('chores.compile_pairs'),
    compileFails: n('chores.compile_fails'),
    compileWaitMs: n('chores.compile_wait_days') * DAY,
    batchPairs: n('chores.batch_pairs'),
    batchFails: n('chores.batch_fails'),
    batchPasses: n('chores.batch_passes'),
    strikes: n('chores.strikes'),
    proposeFails: n('chores.propose_fails'),
  };
}

export const storeOf = (tracker: TrackerStore, ctx: CallContext) => new MachineLocalStore(tracker.location.commonDir, ctx.repo.root);

/** The chore kinds with a live run on this machine. */
async function kindsInProgress(store: MachineLocalStore, now: Date): Promise<Set<ChoreKind>> {
  return new Set((await listRuns(store)).filter((run) => live(run, now)).map((run) => run.kind));
}

/** What `status`, the SessionStart line and the dashboard show: every chore's due-ness now. */
export async function dueChores(tracker: TrackerStore, ctx: CallContext) {
  const view = await tracker.read();
  const now = tracker.now();
  return choresDue(view, { now, thresholds: choreThresholds(view), inProgress: await kindsInProgress(storeOf(tracker, ctx), now) });
}

/**
 * NOT_ISOLATED for a claim or issue write from a context that holds an open
 * chore run (spec §8, Chore contexts).
 */
export async function refuseChoreContext(store: MachineLocalStore, ctx: CallContext, now: Date): Promise<void> {
  const key = choreContextKey(ctx);
  if (key === null) return;
  const run = await liveRunOf(store, key, now);
  if (run) {
    throw new GrimoireError('NOT_ISOLATED', `this context holds the open chore run ${run.id}: a chore context never claims or writes issues`, {
      hint: 'finish the chore with chore_submit or chore_abandon; issue work belongs in another context',
    });
  }
}

/**
 * The actor of a write from a chore-exposed session or server process (spec
 * §14 Wiki-exposed): its `chore_exposure` names the basis. A claim records it
 * in `start.md`; later binding writes carry it on `Grimoire-Actor`.
 */
export async function exposedActor(store: MachineLocalStore, ctx: CallContext, actor: Actor, now: Date): Promise<Actor> {
  if (actor.kind !== 'agent') return actor;
  const session = observedEvidence(ctx).session;
  const basis = await exposureOf(store, { ...(session !== undefined ? { session } : {}), nonce: ctx.nonce }, now);
  if (basis === undefined) return actor;
  const { chore_exposure: _drop, ...rest } = actor;
  return { ...rest, chore_exposure: basis };
}

export const KIND_NAMES: Readonly<Record<ChoreKind, string>> = { 'wiki-maintainer': 'Wiki Maintainer', 'skill-proposer': 'Skill Proposer' };

function notDue(why: string, kinds?: Record<string, string>): GrimoireError {
  return new GrimoireError('NOT_DUE', `no chore to run: ${why}`, { why, ...(kinds ? { kinds } : {}) });
}

/** The origin of a run (spec §16, Origin): `scheduled` only restricts, so self-declaring it is safe. */
function originOf(ctx: CallContext, input: { manual?: boolean; origin?: string }): ChoreOrigin {
  if (input.origin === 'scheduled' || ctx.choreOrigin === 'scheduled') return 'scheduled';
  if (ctx.surface === 'runner') return 'runner';
  return input.manual ? 'manual' : 'session';
}

const SCHEDULED_PROPOSER = 'origin scheduled runs compile only: the Skill Proposer runs locally';

/** The chore a start runs: the one asked for, or the one due next; NOT_DUE when it isn't due. */
function pickKind(due: ChoresDue, asked: ChoreKind | undefined, origin: ChoreOrigin): ChoreKind {
  const kinds = { 'wiki-maintainer': due['wiki-maintainer'].why, 'skill-proposer': due['skill-proposer'].why };
  if (asked !== undefined) {
    if (asked === 'skill-proposer' && origin === 'scheduled') throw notDue(SCHEDULED_PROPOSER);
    if (!due[asked].due) throw notDue(`the ${KIND_NAMES[asked]} isn't due: ${due[asked].why}`);
    return asked;
  }
  if (origin === 'scheduled') {
    if (!due['wiki-maintainer'].due) throw notDue(`the Wiki Maintainer isn't due: ${kinds['wiki-maintainer']}`, { ...kinds, 'skill-proposer': SCHEDULED_PROPOSER });
    return 'wiki-maintainer';
  }
  if (due.next === null) {
    throw notDue(due.paused ? 'the knowledge loop is paused' : `Wiki Maintainer: ${kinds['wiki-maintainer']}; Skill Proposer: ${kinds['skill-proposer']}`, kinds);
  }
  return due.next;
}

/** The JSON a `chore_read` page is, as it is measured and returned. */
function pageEnvelope(run: string) {
  return (items: ServedItem[], cursor: string | null) => ({ run, items, ...(cursor !== null ? { truncated: true, cursor } : {}) });
}

/** Everything a run is served, against the tracker as it stands now. */
async function servingOf(view: TrackerView, run: OpenRun, ctx: CallContext, scanner: SecretScanner, now: Date): Promise<Serving> {
  const { pairs } = await chorePairs(view, { now, thresholds: choreThresholds(view) });
  return new Serving({ view, run, root: ctx.repo.root, scanner, pairs: new Map(pairs.map((pair) => [pair.trace, pair])) });
}

export interface ChoreBrief {
  /** The run handle: pass it to chore_read, chore_submit and chore_abandon. */
  run: string;
  kind: ChoreKind;
  origin: ChoreOrigin;
  isolation: string;
  /** Why the chore is due. */
  why: string;
  /** Wiki Maintainer: the batch, newest first: each pair (`<trace>@<outcome>`) goes into the consumption map. */
  pairs: { pair: string; trace: string; outcome: string }[];
  /** Wiki Maintainer: conflicted pages to reconcile (served with every side). */
  conflicted: string[];
  /** The items chore_read pages through, in order. */
  manifest: string[];
  /** How many chore_read pages the manifest takes. */
  pages: number;
  /** The run expires after this many minutes without a chore call. */
  lease_minutes: number;
  /** JSON Schema of the result to submit. */
  output_schema: Record<string, unknown>;
  next: string;
}

export const choreStart = define({
  name: 'chore_start',
  description: 'Grimoire maintenance chore. Use only while following the grimoire-chores skill.',
  kind: 'write',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    kind: s.optional(s.literal(CHORE_KINDS, 'which chore; default: the one due next')),
    manual: s.optional(s.boolean('true only when the user explicitly asked for this run: it waives the thresholds')),
    origin: s.optional(s.literal(['scheduled'], 'scheduled: a cloud scheduler run (compile only)')),
  }),
  async run(input, { ctx, tracker, scanner }): Promise<ChoreBrief> {
    const caller = classifyCaller(ctx);
    const view = await tracker.read();
    const store = storeOf(tracker, ctx);
    await checkAttemptFree(caller, view, store, ctx.person.email);
    const now = tracker.now();
    const origin = originOf(ctx, input);
    const manual = input.manual === true;
    // One start at a time on this machine, so no two runs of one chore start together.
    const { run, pages, why } = await withStartLock(store, async () => {
      await pruneRuns(store, now);
      const due = await choresDue(view, { now, thresholds: choreThresholds(view), inProgress: await kindsInProgress(store, now), manual });
      const kind = pickKind(due, input.kind, origin);
      const wiki = due['wiki-maintainer'];
      const at = now.toISOString();
      const fresh: OpenRun = {
        id: randomRunId(),
        kind,
        origin,
        isolation: caller.isolation,
        manual,
        context: caller.key,
        person: ctx.person.email ?? '',
        started_at: at,
        last_call_at: at,
        state: 'open',
        ended_at: null,
        reason: null,
        batch: kind === 'wiki-maintainer' ? wiki.batch.map((pair) => ({ pair: pair.id, trace: pair.trace, outcome: pair.outcome })) : [],
        conflicted: kind === 'wiki-maintainer' ? [...wiki.conflicted] : [],
        compiles: kind === 'skill-proposer' ? [...due['skill-proposer'].compiles] : [],
        manifest: [],
      };
      const serving = await servingOf(view, fresh, ctx, scanner, now);
      const manifest = await serving.manifest();
      const started: OpenRun = { ...fresh, manifest };
      await writeRun(store, started);
      return { run: started, pages: await pageCount(serving, manifest, pageEnvelope(started.id)), why: due[kind].why };
    });
    // A chore outside an isolated context marks its session, or its server process (spec §16, Exposure).
    if (caller.rootSession !== undefined) await markExposure(store, 'session', caller.rootSession, run.id, now);
    if (caller.process !== undefined) await markExposure(store, 'process', caller.process, run.id, now);
    return {
      run: run.id,
      kind: run.kind,
      origin,
      isolation: caller.isolation,
      why,
      pairs: [...run.batch],
      conflicted: [...run.conflicted],
      manifest: [...run.manifest],
      pages,
      lease_minutes: LEASE_MS / 60_000,
      output_schema: OUTPUT_SCHEMAS[run.kind],
      next: 'page the inputs with chore_read {run} until it returns no cursor, then submit the result with chore_submit {run, result}, or end the run with chore_abandon {run, reason}',
    };
  },
});

/** Runs `fn` under this machine's chore-start lock; BUSY when another start holds it past the wait. */
async function withStartLock<T>(store: MachineLocalStore, fn: () => Promise<T>): Promise<T> {
  try {
    return await store.locks.withLock('chore-start', fn);
  } catch (error) {
    if (error instanceof LockHeldError) throw new GrimoireError('BUSY', 'another chore is starting on this machine; try again', {});
    throw error;
  }
}

/** The run `id` on this machine, held by the calling context; RUN_SUPERSEDED for an expired one a newer run replaced. */
export async function heldRun(store: MachineLocalStore, ctx: CallContext, id: string, now: Date): Promise<OpenRun> {
  const run = await readRun(store, id.trim());
  if (!run) throw new GrimoireError('NOT_FOUND', `there is no chore run ${id} on this machine`, { run: id });
  if (choreContextKey(ctx) !== run.context) {
    throw new GrimoireError('NOT_ISOLATED', `the chore run ${run.id} belongs to another context`, {
      hint: 'only the context that started a chore run may page, submit or abandon it',
    });
  }
  if (lapsed(run, now)) {
    const newer = (await listRuns(store)).some((other) => other.kind === run.kind && other.id !== run.id && other.started_at > run.started_at);
    if (newer) throw new GrimoireError('RUN_SUPERSEDED', `the chore run ${run.id} expired and a newer run of its chore started`);
  }
  return run;
}

export interface ChoreReadResult {
  run: string;
  /** The served items: whole, or a part of one cut at its `text` (`offset`, `continues`). */
  items: ServedItem[];
  /** True when more remains: pass `cursor` for the next page. */
  truncated?: true;
  cursor?: string;
}

export const choreRead = define({
  name: 'chore_read',
  description: 'Grimoire maintenance chore. Use only while following the grimoire-chores skill.',
  kind: 'write',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    run: s.string({ ...oneLine, description: 'the run handle chore_start returned' }),
    item: s.optional(s.string({ ...oneLine, description: 'one served item by id (a page:<slug>, a handwritten:<path>, …); default: the run’s inputs in order' })),
    cursor: s.optional(s.string({ ...oneLine, description: 'the cursor the previous page returned' })),
  }),
  async run(input, { ctx, tracker, scanner }): Promise<ChoreReadResult> {
    const store = storeOf(tracker, ctx);
    const now = tracker.now();
    const run = await heldRun(store, ctx, input.run, now);
    if (run.state !== 'open') throw new GrimoireError('NOT_FOUND', `the chore run ${run.id} has ended (${run.state})`, { run: run.id, state: run.state });
    const view = await tracker.read();
    const serving = await servingOf(view, run, ctx, scanner, now);
    const item = input.item?.trim() ?? null;
    if (item !== null && (await serving.item(item)) === null) {
      throw new GrimoireError('NOT_FOUND', `${item} isn't an item this chore run is served`, { item });
    }
    const ids = item === null ? run.manifest : await serving.itemIds(item);
    const page = await pageOf(serving, ids, pageStart(input.cursor, item), pageEnvelope(run.id));
    await logServed(store, run.id, page.served, now);
    await writeRun(store, { ...run, last_call_at: now.toISOString() });
    return { run: run.id, items: page.items, ...(page.next !== null ? { truncated: true as const, cursor: page.next } : {}) };
  },
});

export interface ChoreAbandonResult {
  run: string;
  kind: ChoreKind;
  abandoned: true;
  /** True when the run was already abandoned: nothing changed. */
  replayed?: true;
  /** Grimoire's own summary: counts and ids only. */
  summary: string;
}

export const choreAbandon = define({
  name: 'chore_abandon',
  description: 'Grimoire maintenance chore. Use only while following the grimoire-chores skill.',
  kind: 'write',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    run: s.string({ ...oneLine, description: 'the run handle chore_start returned' }),
    reason: s.string({ nonBlank: true, description: 'why the run stops' }),
  }),
  async run(input, { ctx, tracker }): Promise<ChoreAbandonResult> {
    const store = storeOf(tracker, ctx);
    const now = tracker.now();
    const run = await heldRun(store, ctx, input.run, now);
    const summary = `grimoire chores: ${KIND_NAMES[run.kind]} run ${run.id} abandoned; nothing consumed`;
    if (run.state === 'abandoned') return { run: run.id, kind: run.kind, abandoned: true, replayed: true, summary };
    if (run.state !== 'open') throw new GrimoireError('NOT_FOUND', `the chore run ${run.id} has ended (${run.state})`, { run: run.id, state: run.state });
    const at = now.toISOString();
    await writeRun(store, { ...run, state: 'abandoned', ended_at: at, last_call_at: at, reason: input.reason.trim().slice(0, 2_000) });
    return { run: run.id, kind: run.kind, abandoned: true, summary };
  },
});
