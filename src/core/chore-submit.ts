// `chore_submit` (spec §8 tools, §16 Results, Failures and replays, Chore-run
// records; ADR 0006): a chore run hands grimoire its result, grimoire checks
// it fail-closed and writes every output itself. A Wiki Maintainer result's
// pages, the index and log derived from them, and the run's chore-run record
// land in one tracker commit. A refused result gets reason codes and exactly
// one fix-up; a second refusal ends the run `failed`.
import { GrimoireError } from '../errors';
import {
  activeQuarantine,
  checkCompile,
  keepInvalidResult,
  lapsed,
  logNoPattern,
  servedLog,
  updateRun,
  writeCompile,
  type OpenRun,
  type Rejection,
} from '../knowledge/chores';
import { LockHeldError, type MachineLocalStore } from '../machine-local';
import type { ChoreKind, NewChoreRun, TrackerDraft, WriteSpec } from '../tracker';
import { recordedActor } from './attempts';
import { heldRun, KIND_NAMES, storeOf } from './chores';
import { define, oneLine, writer, type OpEnv } from './op';
import { s } from './schema';

export interface ChoreSubmitResult {
  run: string;
  kind: ChoreKind;
  /** `compiled`: written; `invalid`: refused, one fix-up left; `failed`: refused again, the run ended. */
  result: 'compiled' | 'invalid' | 'failed';
  /** Refused: the reason codes. */
  reasons?: string[];
  /** Refused: what failed where, in grimoire's words (never the text found). */
  problems?: Record<string, string>;
  /** Refused: how many more submits this run may make. */
  fix_ups_left?: number;
  /** Compiled: the pairs consumed and the pages written. */
  traces?: number;
  pages?: number;
  /** True when this answers a submit made before: nothing changed. */
  replayed?: true;
  /** Grimoire's own summary: counts and ids only. */
  summary: string;
}

/** A result the checks refused, carried out of the write round so nothing commits. */
class Refused extends Error {
  constructor(readonly rejection: Rejection) {
    super('refused');
  }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * RUN_SUPERSEDED for a late submit whose inputs a compile consumed meanwhile
 * (spec §16 Late submits): any batch pair another compile took under the same
 * verdict, on this clone or arriving by sync.
 */
async function refuseConsumed(draft: TrackerDraft, run: OpenRun): Promise<void> {
  const pairs = new Set(run.batch.map((pair) => `${pair.trace}@${pair.outcome}`));
  for (const record of await draft.choreRuns.records()) {
    if (record.id === run.id || record.kind !== 'wiki-maintainer' || record.result !== 'compiled') continue;
    if (record.consumption.some((pair) => pairs.has(`${pair.trace}@${pair.outcome}`))) {
      throw new GrimoireError('RUN_SUPERSEDED', `the chore run ${run.id} expired, and the compile ${record.id} has consumed its inputs since`);
    }
  }
}

/** Runs `fn` holding the run's submit lock: two submits of one run never interleave. */
async function withRunLock<T>(store: MachineLocalStore, run: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await store.locks.withLock(`chore-submit/${run}`, fn);
  } catch (error) {
    if (error instanceof LockHeldError) throw new GrimoireError('BUSY', `another submit of the chore run ${run} is in progress; try again`, {});
    throw error;
  }
}

/** Marks the run ended, keeping the answer a retried submit replays (a run that stopped meanwhile stays as it is). */
async function endRun(store: MachineLocalStore, id: string, now: Date, outcome: ChoreSubmitResult, failures?: number): Promise<void> {
  const at = now.toISOString();
  await updateRun(store, id, (open) => ({ ...open, state: 'ended', ended_at: at, last_call_at: at, outcome: outcome as never, ...(failures !== undefined ? { failures } : {}) }));
}

export const choreSubmit = define({
  name: 'chore_submit',
  description: 'Grimoire maintenance chore. Use only while following the grimoire-chores skill.',
  kind: 'write',
  policy: 'agent',
  replay: 'idempotency-key',
  input: s.object({
    run: s.string({ ...oneLine, description: 'the run handle chore_start returned' }),
    result: s.unchecked({ type: 'object', description: 'the result, in the shape of the output_schema chore_start returned' }),
    idempotency_key: s.optional(s.string(oneLine)),
  }),
  async run(input, env): Promise<ChoreSubmitResult> {
    const { ctx, tracker } = env;
    const author = writer(ctx);
    const store = storeOf(tracker, ctx);
    return withRunLock(store, input.run.trim(), async () => {
      const now = tracker.now();
      const run = await heldRun(store, ctx, input.run, now);
      const key = input.idempotency_key ?? null;
      if (run.state === 'ended' && run.outcome) return { ...(run.outcome as unknown as ChoreSubmitResult), replayed: true as const };
      if (run.state !== 'open') throw new GrimoireError('NOT_FOUND', `the chore run ${run.id} has ended (${run.state})`, { run: run.id, state: run.state });
      if (key !== null && run.refused?.key === key) return { ...(run.refused.outcome as unknown as ChoreSubmitResult), replayed: true as const };
      if (run.kind !== 'wiki-maintainer') {
        throw new GrimoireError('INVALID', `the chore run ${run.id} is a ${KIND_NAMES[run.kind]} run, whose results this release doesn't take yet`, {
          fields: { run: 'is not a Wiki Maintainer run' },
        });
      }
      return submitCompile(input.result, key, run, store, author, env, now);
    });
  },
});

type Recorded = Omit<NewChoreRun, 'result' | 'unverified' | 'at' | 'consumption' | 'pages' | 'reasons' | 'pairs' | 'resolved'>;

/** A Wiki Maintainer submit. */
async function submitCompile(
  result: unknown,
  key: string | null,
  run: OpenRun,
  store: MachineLocalStore,
  author: { name: string; email: string },
  env: OpEnv,
  now: Date,
): Promise<ChoreSubmitResult> {
  const { tracker, actor, scanner, requestSync } = env;
  const served = await servedLog(store, run.id);
  const late = lapsed(run, now);
  const idempotency: Pick<WriteSpec, 'idempotency'> = key !== null ? { idempotency: { key, fingerprint: { run: run.id } } } : {};
  const recorded: Recorded = {
    id: run.id,
    kind: run.kind,
    origin: run.origin,
    isolation: run.isolation,
    actor: recordedActor(author.email, actor),
    started_at: run.started_at,
    served: served.items.map((entry) => ({ item: entry.item, hash: entry.hash })),
    consumed: [],
    proposal: null,
  };
  // The no_pattern reasons leave the round only here: never in the commit, nor in the stored replay.
  let noPattern: Readonly<Record<string, string>> = {};
  try {
    const write = await tracker.transact<ChoreSubmitResult>({ op: 'compile', author, actor, ...idempotency }, async (draft) => {
      if (late) await refuseConsumed(draft, run);
      const quarantine = await activeQuarantine(draft);
      const check = await checkCompile(result, {
        draft,
        run,
        served,
        scanner,
        servableTrace: async (trace) => draft.attempt(trace)?.end != null && !quarantine.traces.has(trace),
        servablePage: (slug) => !quarantine.pages.has(slug),
      });
      if (!check.ok) throw new Refused(check.rejection);
      const { plan } = check;
      const { versions, resolved } = await writeCompile(draft, plan);
      draft.choreRuns.add({
        ...recorded,
        result: 'compiled',
        unverified: plan.unverified,
        at: draft.now.toISOString(),
        consumption: plan.consumption,
        pages: versions,
        reasons: [],
        pairs: [],
        resolved,
      });
      // The log lists the compile: derive it again now that the record is in the round.
      await draft.wiki.refresh();
      noPattern = plan.noPattern;
      const created = plan.pages.filter((page) => page.action === 'create').length;
      const pages = plan.pages.length;
      const conflicts = resolved.length === 0 ? '' : `, ${plural(resolved.length, 'conflict')} resolved`;
      const summary = `grimoire chores: compile done, ${plural(plan.consumption.length, 'trace')}, ${plural(pages, 'page')} (${created} created, ${pages - created} updated)${conflicts}; run ${run.id}`;
      return { result: { run: run.id, kind: run.kind, result: 'compiled', traces: plan.consumption.length, pages, summary } };
    });
    await logNoPattern(store, run.id, noPattern);
    await endRun(store, run.id, now, write.result);
    // An accepted chore submit triggers the automatic sync (spec §4).
    if (write.commit) requestSync(write.commit);
    return write.replayed ? { ...write.result, replayed: true } : write.result;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return refuse(error.rejection, result, key, run, store, recorded, author, env, idempotency, now);
  }
}

/**
 * A refused result (spec §16 One fix-up): the first gets reason codes and one
 * fix-up; the second ends the run `failed`, its record committed with the
 * reason codes and the served pairs the 2-strike rule counts. The result text
 * stays on this machine, except after a secret-scan failure: then only the
 * reason codes and the matched rule ids are kept.
 */
async function refuse(
  rejection: Rejection,
  result: unknown,
  key: string | null,
  run: OpenRun,
  store: MachineLocalStore,
  recorded: Recorded,
  author: { name: string; email: string },
  { tracker, actor, requestSync }: OpEnv,
  idempotency: Pick<WriteSpec, 'idempotency'>,
  now: Date,
): Promise<ChoreSubmitResult> {
  const failures = (run.failures ?? 0) + 1;
  const { reasons, problems, rules } = rejection;
  await keepInvalidResult(store, failures, {
    run: run.id,
    at: now.toISOString(),
    reasons,
    rules,
    ...(rejection.secret ? {} : { problems, text: JSON.stringify(result) ?? 'undefined' }),
  });
  if (failures < 2) {
    const outcome: ChoreSubmitResult = {
      run: run.id,
      kind: run.kind,
      result: 'invalid',
      reasons,
      problems,
      fix_ups_left: 1,
      summary: `grimoire chores: compile result refused (${reasons.join(', ')}); one fix-up left; run ${run.id}`,
    };
    const at = now.toISOString();
    await updateRun(store, run.id, (open) => ({ ...open, failures, last_call_at: at, refused: { key, outcome: outcome as never } }));
    return outcome;
  }
  const served = new Set(recorded.served.map((ref) => ref.item));
  const write = await tracker.transact<ChoreSubmitResult>({ op: 'compile', author, actor, ...idempotency }, (draft) => {
    draft.choreRuns.add({
      ...recorded,
      result: 'failed',
      // A refused result's self-reports may hold anything: none is committed.
      unverified: { client: null, model: null },
      at: draft.now.toISOString(),
      consumption: [],
      pages: {},
      reasons,
      pairs: run.batch.filter((pair) => served.has(`trace:${pair.trace}`)).map((pair) => pair.pair),
      resolved: [],
    });
    return {
      result: {
        run: run.id,
        kind: run.kind,
        result: 'failed',
        reasons,
        problems,
        fix_ups_left: 0,
        summary: `grimoire chores: compile failed after its fix-up (${reasons.join(', ')}); nothing written; run ${run.id}`,
      },
    };
  });
  await endRun(store, run.id, now, write.result, failures);
  if (write.commit) requestSync(write.commit);
  return write.replayed ? { ...write.result, replayed: true } : write.result;
}
