// `chore_submit` (spec §8 tools, §16 Results, Failures and replays, Chore-run
// records; §18 Proposals, Mechanical checks; ADR 0005, 0006): a chore run hands
// grimoire its result, grimoire checks it fail-closed and writes every output
// itself. A Wiki Maintainer result's pages, the index and log derived from
// them, and the run's chore-run record land in one tracker commit; so do a
// Skill Proposer's proposal record and its chore-run record. A refused result
// gets reason codes and exactly one fix-up; a second refusal ends the run
// `failed`.
import { GrimoireError } from '../errors';
import { proposalStates, readSkills } from '../knowledge';
import {
  activeQuarantine,
  addedTokens,
  checkCompile,
  checkProposal,
  keepInvalidResult,
  lapsed,
  logNoPattern,
  riskFlags,
  servedLog,
  updateRun,
  writeCompile,
  type OpenRun,
  type ProposeContext,
  type Rejection,
  type ServedLog,
} from '../knowledge/chores';
import type { MachineLocalStore } from '../machine-local';
import type { SecretScanner } from '../scanner';
import { randomProposalId, type ChoreKind, type ChoreRunRecord, type NewChoreRun, type RiskFlag, type TokenOrigin, type TrackerDraft, type TrackerView, type WriteSpec } from '../tracker';
import { recordedActor } from './attempts';
import { heldRun, KIND_NAMES, storeOf, withRunLock } from './chores';
import { define, oneLine, writer, type OpEnv } from './op';
import { handwrittenTexts, stubCollides, tokenOrigins } from './proposal-sources';
import { s } from './schema';
import { storeSetting } from './settings';

/** What a proposal's submit tells the agent, and all it tells it (spec §16). */
export const PENDING_REVIEW = 'pending human review';

export interface ChoreSubmitResult {
  run: string;
  kind: ChoreKind;
  /**
   * `compiled` (Wiki Maintainer) or `proposed` (Skill Proposer): written;
   * `no_action`: the Skill Proposer found nothing to propose, recorded on the run;
   * `invalid`: refused, one fix-up left; `failed`: refused again, the run ended.
   */
  result: 'compiled' | 'proposed' | 'no_action' | 'invalid' | 'failed';
  /** Proposed: the proposal's id, and only that: never an echo of its text. */
  proposal?: string;
  /** Proposed: "pending human review". */
  status?: typeof PENDING_REVIEW;
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

/** The run's record is in the tracker already: its commit landed, but this machine never recorded the run's end. */
class AlreadyRecorded extends Error {
  constructor(readonly record: ChoreRunRecord) {
    super('recorded');
  }
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What a kind's result is called in its summaries, and the `Grimoire-Op` its commits carry. */
const RESULT_NOUN: Readonly<Record<ChoreKind, string>> = { 'wiki-maintainer': 'compile', 'skill-proposer': 'proposal' };
const OP_OF: Readonly<Record<ChoreKind, string>> = { 'wiki-maintainer': 'compile', 'skill-proposer': 'propose' };

function proposedSummary(proposal: string, run: string): string {
  return `grimoire chores: 1 skill proposal ${PENDING_REVIEW} (${proposal}); run ${run}`;
}

function noActionSummary(compiles: number, run: string): string {
  return `grimoire chores: Skill Proposer found nothing to propose; ${plural(compiles, 'compile')} consumed; run ${run}`;
}

function failedSummary(kind: ChoreKind, reasons: readonly string[], run: string): string {
  return `grimoire chores: ${RESULT_NOUN[kind]} failed after its fix-up (${reasons.join(', ')}); nothing written; run ${run}`;
}

/** Throws AlreadyRecorded when the tracker holds the run's record: a retry then replays, never writing again. */
async function refuseRecorded(draft: TrackerDraft, run: OpenRun): Promise<void> {
  const record = (await draft.choreRuns.records()).find((other) => other.id === run.id);
  if (record) throw new AlreadyRecorded(record);
}

/** A step after the commit landed: its failure can't undo the commit, so the call still answers (spec §9). */
async function afterCommit(step: Promise<unknown>): Promise<void> {
  await step.catch(() => undefined);
}

/** What a submit whose record landed answered, rebuilt from that record (the run's end was never recorded here). */
function outcomeOf(record: ChoreRunRecord, run: OpenRun): ChoreSubmitResult {
  if (record.result === 'compiled') {
    const traces = record.consumption.length;
    const pages = Object.keys(record.pages).length;
    const conflicts = record.resolved.length === 0 ? '' : `, ${plural(record.resolved.length, 'conflict')} resolved`;
    const summary = `grimoire chores: compile done, ${plural(traces, 'trace')}, ${plural(pages, 'page')}${conflicts}; run ${run.id}`;
    return { run: run.id, kind: run.kind, result: 'compiled', traces, pages, summary };
  }
  if (record.result === 'proposed' && record.proposal !== null) {
    return { run: run.id, kind: run.kind, result: 'proposed', proposal: record.proposal, status: PENDING_REVIEW, summary: proposedSummary(record.proposal, run.id) };
  }
  if (record.result === 'no_action') return { run: run.id, kind: run.kind, result: 'no_action', summary: noActionSummary(record.consumed.length, run.id) };
  const reasons = [...record.reasons];
  return { run: run.id, kind: run.kind, result: 'failed', reasons, fix_ups_left: 0, summary: failedSummary(run.kind, reasons, run.id) };
}

/**
 * Finishes a run whose record the tracker holds though this machine still has
 * it open (the process stopped between the commit and the run's end): ends it
 * and replays, asking again for the sync the stopped call may not have asked for.
 */
async function recover(record: ChoreRunRecord, run: OpenRun, store: MachineLocalStore, { tracker, requestSync }: OpEnv, now: Date): Promise<ChoreSubmitResult> {
  const outcome = outcomeOf(record, run);
  await endRun(store, run.id, now, outcome, record.result === 'failed' ? 2 : undefined);
  const tip = (await tracker.tips()).local;
  if (tip) requestSync(tip);
  return { ...outcome, replayed: true };
}

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
    // Under the run's lock no page, submit or abandon of it interleaves: the run checked open below stays open until this submit ends it.
    return withRunLock(store, input.run, async () => {
      const now = tracker.now();
      const run = await heldRun(store, ctx, input.run, now);
      const key = input.idempotency_key ?? null;
      if (run.state === 'ended' && run.outcome) return { ...(run.outcome as unknown as ChoreSubmitResult), replayed: true as const };
      if (run.state !== 'open') throw new GrimoireError('NOT_FOUND', `the chore run ${run.id} has ended (${run.state})`, { run: run.id, state: run.state });
      if (key !== null && run.refused?.key === key) return { ...(run.refused.outcome as unknown as ChoreSubmitResult), replayed: true as const };
      switch (run.kind) {
        case 'wiki-maintainer':
          return submitCompile(input.result, key, run, store, author, env, now);
        case 'skill-proposer':
          return submitProposal(input.result, key, run, store, author, env, now);
        default:
          throw new GrimoireError('INVALID', `the chore run ${run.id} is a ${KIND_NAMES[run.kind as ChoreKind] ?? run.kind} run, whose results this release doesn't take`, {
            fields: { run: 'is not a chore run this release knows' },
          });
      }
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
      await refuseRecorded(draft, run);
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
      await draft.choreRuns.add({
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
    // The commit landed: what follows is this machine's bookkeeping. Should it fail, a retry finds the record and replays.
    await afterCommit(logNoPattern(store, run.id, noPattern));
    await afterCommit(endRun(store, run.id, now, write.result));
    // An accepted chore submit triggers the automatic sync (spec §4).
    if (write.commit) requestSync(write.commit);
    return write.replayed ? { ...write.result, replayed: true } : write.result;
  } catch (error) {
    if (error instanceof AlreadyRecorded) return recover(error.record, run, store, env, now);
    if (!(error instanceof Refused)) throw error;
    return refuse(error.rejection, result, key, run, store, recorded, author, env, idempotency, now);
  }
}

/**
 * A refused result (spec §16 One fix-up): the first gets reason codes and one
 * fix-up; the second ends the run `failed`, its record committed with the
 * reason codes and, for a compile, the served pairs the 2-strike rule counts
 * (a failed Skill Proposer run consumes its compiles). The result text
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
      summary: `grimoire chores: ${RESULT_NOUN[run.kind]} result refused (${reasons.join(', ')}); one fix-up left; run ${run.id}`,
    };
    const at = now.toISOString();
    await updateRun(store, run.id, (open) => ({ ...open, failures, last_call_at: at, refused: { key, outcome: outcome as never } }));
    return outcome;
  }
  const served = new Set(recorded.served.map((ref) => ref.item));
  const write = await tracker.transact<ChoreSubmitResult>({ op: OP_OF[run.kind], author, actor, ...idempotency }, async (draft) => {
    await draft.choreRuns.add({
      ...recorded,
      result: 'failed',
      // A refused result's self-reports may hold anything: none is committed.
      unverified: { client: null, model: null },
      at: draft.now.toISOString(),
      consumption: [],
      pages: {},
      reasons,
      pairs: run.kind === 'wiki-maintainer' ? run.batch.filter((pair) => served.has(`trace:${pair.trace}`)).map((pair) => pair.pair) : [],
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
        summary: failedSummary(run.kind, reasons, run.id),
      },
    };
  });
  await afterCommit(endRun(store, run.id, now, write.result, failures));
  if (write.commit) requestSync(write.commit);
  return write.replayed ? { ...write.result, replayed: true } : write.result;
}

/**
 * RUN_SUPERSEDED for a late Skill Proposer submit whose compiles another
 * proposer run consumed meanwhile (spec §16 Late submits), on this clone or
 * arriving by sync.
 */
async function refuseProposerConsumed(draft: TrackerDraft, run: OpenRun): Promise<void> {
  const compiles = new Set(run.compiles);
  for (const record of await draft.choreRuns.records()) {
    if (record.id === run.id || record.kind !== 'skill-proposer') continue;
    if (record.consumed.some((id) => compiles.has(id))) {
      throw new GrimoireError('RUN_SUPERSEDED', `the chore run ${run.id} expired, and the Skill Proposer run ${record.id} has consumed its compiles since`);
    }
  }
}

/**
 * PENDING_LIMIT while the pending slot is full (spec §18 Pending lifecycle):
 * at most proposals.pending_limit pending proposals, judged on the merged
 * view, so every worktree and clone shares the slot.
 */
async function refusePending(view: TrackerView, scanner: SecretScanner): Promise<void> {
  const limit = storeSetting(view, 'proposals.pending_limit') as number;
  const book = await readSkills(view, scanner);
  const pending = proposalStates(await view.proposals.records(), book.skills).filter((state) => state.status === 'pending');
  if (pending.length >= limit) {
    throw new GrimoireError('PENDING_LIMIT', `a skill proposal is already pending human review (${pending.map((state) => state.record.id).join(', ')}); end this run with chore_abandon`, {
      pending: pending.map((state) => state.record.id),
    });
  }
}

/** Whether a result asks for a proposal (not no_action): only those need the pending slot. */
const proposes = (result: unknown) => result !== null && typeof result === 'object' && ['create', 'patch'].includes((result as { action?: unknown }).action as string);

/** A Skill Proposer submit (spec §16 Results: Skill Proposer; §18). */
async function submitProposal(
  result: unknown,
  key: string | null,
  run: OpenRun,
  store: MachineLocalStore,
  author: { name: string; email: string },
  env: OpEnv,
  now: Date,
): Promise<ChoreSubmitResult> {
  const { tracker, actor, scanner, requestSync, ctx } = env;
  const root = ctx.repo.root;
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
    // Proposed, no_action and failed alike consume the run's compiles.
    consumed: [...run.compiles],
    proposal: null,
  };
  const handwritten = await handwrittenTexts(root);
  const collisions = new Map<string, Promise<boolean>>();
  const contextOf = async (view: TrackerView): Promise<ProposeContext> => {
    const quarantine = await activeQuarantine(view);
    return {
      view,
      run,
      served: served as ServedLog,
      scanner,
      book: await readSkills(view, scanner),
      maxActive: storeSetting(view, 'skills.max_active') as number,
      descriptionMax: storeSetting(view, 'skills.description_max') as number,
      handwritten,
      collides: (name) => {
        let known = collisions.get(name);
        if (!known) collisions.set(name, (known = stubCollides(root, name)));
        return known;
      },
      servableTrace: async (trace) => view.attempt(trace)?.end != null && !quarantine.traces.has(trace),
      servablePage: (slug) => !quarantine.pages.has(slug),
    };
  };

  // A first look on the view as it stands: token origins ask git about the checkout, which no write round should wait on.
  const view = await tracker.read();
  if (proposes(result)) await refusePending(view, scanner);
  const first = await checkProposal(result, await contextOf(view));
  let tokens: { version: string; origins: TokenOrigin[] } | null = null;
  if (first.ok && first.plan.action !== 'no_action') {
    tokens = { version: first.plan.version, origins: await tokenOrigins(root, addedTokens(first.plan), view, first.plan.traces.map((t) => t.trace)) };
  }

  try {
    const write = await tracker.transact<ChoreSubmitResult>({ op: 'propose', author, actor, ...idempotency }, async (draft) => {
      await refuseRecorded(draft, run);
      if (late) await refuseProposerConsumed(draft, run);
      if (proposes(result)) await refusePending(draft, scanner);
      const check = await checkProposal(result, await contextOf(draft));
      if (!check.ok) throw new Refused(check.rejection);
      const { plan } = check;
      const at = draft.now.toISOString();
      if (plan.action === 'no_action') {
        await draft.choreRuns.add({ ...recorded, result: 'no_action', unverified: plan.unverified, at, consumption: [], pages: {}, reasons: [], pairs: [], resolved: [] });
        return { result: { run: run.id, kind: run.kind, result: 'no_action', summary: noActionSummary(run.compiles.length, run.id) } };
      }
      // The text the first look traced is the text this round writes; anything else moved its base meanwhile.
      if (tokens === null || tokens.version !== plan.version) {
        throw new GrimoireError('BASE_MOVED', `the evolved skill ${plan.skill} changed while this proposal was checked; read it again`, { skill: plan.skill });
      }
      const flags: RiskFlag[] = riskFlags(plan);
      const id = randomProposalId();
      await draft.proposals.add({
        id,
        action: plan.action,
        skill: plan.skill,
        base: plan.base,
        after: plan.after,
        version: plan.version,
        ops: plan.ops,
        citations: plan.citations,
        served: plan.served,
        pages: plan.pages,
        traces: plan.traces,
        claims: plan.claims,
        flags,
        tokens: tokens.origins,
        run: run.id,
        origin: run.origin,
        isolation: run.isolation,
        unverified: plan.unverified,
        actor: recorded.actor,
        at,
        text: plan.text,
      });
      await draft.choreRuns.add({ ...recorded, result: 'proposed', proposal: id, unverified: plan.unverified, at, consumption: [], pages: {}, reasons: [], pairs: [], resolved: [] });
      return { result: { run: run.id, kind: run.kind, result: 'proposed', proposal: id, status: PENDING_REVIEW, summary: proposedSummary(id, run.id) } };
    });
    await afterCommit(endRun(store, run.id, now, write.result));
    if (write.commit) requestSync(write.commit);
    return write.replayed ? { ...write.result, replayed: true } : write.result;
  } catch (error) {
    if (error instanceof AlreadyRecorded) return recover(error.record, run, store, env, now);
    if (!(error instanceof Refused)) throw error;
    return refuse(error.rejection, result, key, run, store, recorded, author, env, idempotency, now);
  }
}
