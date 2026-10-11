// Chore due-ness (spec §16 Due-ness): chores are offered while due, never
// queued, and due-ness is recomputed from the tracker whenever something asks.
// At most one chore of each kind is due at a time, and every threshold is a
// store setting (the caller reads them; see ChoreThresholds).
//
// Input pairs are (trace, current outcome): an ended attempt whose verdict is
// pass or fail, settled (ended long enough ago, or set by a human), and not
// quarantined. A purged trace is gone from the tracker, so it is never one.
// A pair is compiled when the latest compile that consumed its trace consumed
// it under the verdict it has now: an outcome flip makes it uncompiled again,
// and it carries the verdict it was compiled under as its flip context.
import type { ChoreKind, ChoreRunRecord, TrackerView, WikiConflict } from '../../tracker';
import { activeQuarantine } from './quarantine';

/** The store settings due-ness reads (spec §16: every threshold is a store setting). */
export interface ChoreThresholds {
  /** `knowledge.loop` is `paused`: no chore becomes due. */
  readonly paused: boolean;
  /** How long after its attempt ended a pair is settled. */
  readonly settleMs: number;
  /** Uncompiled pairs that make the Wiki Maintainer due… */
  readonly compilePairs: number;
  /** …with at least this many fails among them. */
  readonly compileFails: number;
  /** How long after the last compile one uncompiled fail makes it due. */
  readonly compileWaitMs: number;
  readonly batchPairs: number;
  readonly batchFails: number;
  readonly batchPasses: number;
  /** Failed compile runs that set a pair aside. */
  readonly strikes: number;
  /** Fails among unconsumed compiles that make the Skill Proposer due. */
  readonly proposeFails: number;
}

/** The verdict a pair was compiled under before its outcome flipped. */
export interface FlipContext {
  /** The verdict the latest compile consumed it under. */
  readonly from: string;
  /** The verdict it has now. */
  readonly to: string;
  /** The compile run that consumed it under `from`. */
  readonly compiled_in: string;
  /** Why the outcome is what it is now, and who set it. */
  readonly reason: string;
  readonly set_by: string;
}

/** One (trace, current outcome) pair. */
export interface ChorePair {
  /** `<trace>@<outcome>`: what a compile's served pairs and the 2-strike rule name. */
  readonly id: string;
  /** The trace: its attempt handle. */
  readonly trace: string;
  readonly issue: string;
  readonly outcome: 'pass' | 'fail';
  readonly reason: string;
  readonly set_by: string;
  /** When its attempt ended. */
  readonly ended_at: string;
  /** Any binding write of the attempt came from a chore-exposed session or process. */
  readonly wiki_exposed: boolean;
  readonly flip: FlipContext | null;
  /** Failed compile runs it was served in. */
  readonly strikes: number;
}

/** Why a chore is due, or why it isn't (spec §9 NOT_DUE: `why`). */
export interface DueState {
  readonly due: boolean;
  /** One short phrase: why it is due, or why not. */
  readonly why: string;
}

export interface WikiMaintainerDue extends DueState {
  /** Every uncompiled settled pair that isn't set aside, newest first. */
  readonly uncompiled: readonly ChorePair[];
  /** The batch a compile would take now: at most 8 pairs (5 fails, 3 passes), newest first. */
  readonly batch: readonly ChorePair[];
  /** Pairs the 2-strike rule set aside: shown, never offered. */
  readonly setAside: readonly ChorePair[];
  /** Conflicted pages (not quarantined): each makes the Wiki Maintainer due. */
  readonly conflicted: readonly string[];
  /** When the last compile ended, or null. */
  readonly lastCompile: string | null;
}

export interface SkillProposerDue extends DueState {
  /** The compile runs no Skill Proposer run consumed yet, oldest first. */
  readonly compiles: readonly string[];
  /** Fail pairs among them. */
  readonly fails: number;
  /** The pending proposal holding the slot, or null when it is free. */
  readonly pending: string | null;
}

export interface ChoresDue {
  readonly paused: boolean;
  readonly 'wiki-maintainer': WikiMaintainerDue;
  readonly 'skill-proposer': SkillProposerDue;
  /** The chore to run next, or null when none is due: a compile first, then a proposal if one became due, alternating. */
  readonly next: ChoreKind | null;
}

/**
 * What the proposal half of the knowledge engine tells due-ness (spec §18):
 * whether the pending slot is held, and whether a proposal went stale or
 * lapsed since a given time. Proposals arrive with the Skill Proposer; until
 * then the slot is always free and nothing goes stale.
 */
export interface ProposalSignals {
  readonly pending: string | null;
  staleOrLapsedSince(at: string | null): boolean;
}

export const NO_PROPOSALS: ProposalSignals = { pending: null, staleOrLapsedSince: () => false };

export interface DueOptions {
  readonly now: Date;
  readonly thresholds: ChoreThresholds;
  /** Kinds with an open run on this machine: not due while it runs. */
  readonly inProgress?: ReadonlySet<ChoreKind>;
  /** A manual run waives the thresholds only. */
  readonly manual?: boolean;
  readonly proposals?: ProposalSignals;
}

const isCompile = (run: ChoreRunRecord) => run.kind === 'wiki-maintainer' && run.result === 'compiled';
const isProposerEnd = (run: ChoreRunRecord) =>
  run.kind === 'skill-proposer' && (run.result === 'proposed' || run.result === 'no_action' || run.result === 'failed');

const newestFirst = (x: ChorePair, y: ChorePair) =>
  x.ended_at > y.ended_at ? -1 : x.ended_at < y.ended_at ? 1 : x.trace < y.trace ? -1 : x.trace > y.trace ? 1 : 0;

/** The pairs of `view`, uncompiled or not, with what the chore-run records say about each. */
export async function chorePairs(view: TrackerView, options: Pick<DueOptions, 'now' | 'thresholds'>): Promise<{ pairs: ChorePair[]; compiled: Set<string> }> {
  const runs = await view.choreRuns.records();
  const quarantined = (await activeQuarantine(view)).traces;
  // The verdict each trace was last compiled under (records run oldest first).
  const lastCompiled = new Map<string, { outcome: string; run: string }>();
  for (const run of runs.filter(isCompile)) for (const pair of run.consumption) lastCompiled.set(pair.trace, { outcome: pair.outcome, run: run.id });
  const strikes = new Map<string, number>();
  for (const run of runs) {
    if (run.kind !== 'wiki-maintainer' || run.result !== 'failed') continue;
    for (const pair of run.pairs) strikes.set(pair, (strikes.get(pair) ?? 0) + 1);
  }
  const now = options.now.getTime();
  const pairs: ChorePair[] = [];
  const compiled = new Set<string>();
  for (const attempt of view.allAttempts()) {
    const { end, outcome } = attempt;
    if (!end || !outcome || (outcome.verdict !== 'pass' && outcome.verdict !== 'fail')) continue;
    if (quarantined.has(attempt.id)) continue;
    const humanSet = outcome.set_by.startsWith('human:');
    const ended = Date.parse(end.at);
    if (!humanSet && !(ended + options.thresholds.settleMs <= now)) continue;
    const id = `${attempt.id}@${outcome.verdict}`;
    const last = lastCompiled.get(attempt.id);
    if (last?.outcome === outcome.verdict) compiled.add(id);
    pairs.push({
      id,
      trace: attempt.id,
      issue: attempt.issue,
      outcome: outcome.verdict,
      reason: outcome.reason,
      set_by: outcome.set_by,
      ended_at: end.at,
      wiki_exposed: attempt.start.wiki_exposed || end.wiki_exposed,
      flip:
        last && last.outcome !== outcome.verdict
          ? { from: last.outcome, to: outcome.verdict, compiled_in: last.run, reason: outcome.reason, set_by: outcome.set_by }
          : null,
      strikes: strikes.get(id) ?? 0,
    });
  }
  return { pairs: pairs.sort(newestFirst), compiled };
}

/** The batch a compile takes: newest first, at most `batchPairs`, with at most `batchFails` fails and `batchPasses` passes. */
function batchOf(pairs: readonly ChorePair[], t: ChoreThresholds): ChorePair[] {
  const batch: ChorePair[] = [];
  let fails = 0;
  let passes = 0;
  for (const pair of pairs) {
    if (batch.length >= t.batchPairs) break;
    if (pair.outcome === 'fail' ? fails >= t.batchFails : passes >= t.batchPasses) continue;
    if (pair.outcome === 'fail') fails++;
    else passes++;
    batch.push(pair);
  }
  return batch;
}

async function conflictedPages(view: TrackerView, quarantinedPages: { has(slug: string): boolean }): Promise<string[]> {
  const pages = await view.wiki.pages();
  const sides = await Promise.all(pages.map(async (page): Promise<[string, readonly WikiConflict[]]> => [page.slug, await view.wiki.conflicts(page.slug)]));
  return sides.filter(([slug, list]) => list.length > 0 && !quarantinedPages.has(slug)).map(([slug]) => slug);
}

/** Every chore's due-ness in `view` (spec §16): recomputed on every ask. */
export async function choresDue(view: TrackerView, options: DueOptions): Promise<ChoresDue> {
  const t = options.thresholds;
  const now = options.now.getTime();
  const inProgress = options.inProgress ?? new Set<ChoreKind>();
  const proposals = options.proposals ?? NO_PROPOSALS;
  const runs = await view.choreRuns.records();
  const quarantine = await activeQuarantine(view);

  // The Wiki Maintainer.
  const { pairs, compiled } = await chorePairs(view, options);
  const open = pairs.filter((pair) => !compiled.has(pair.id));
  const setAside = open.filter((pair) => pair.strikes >= t.strikes);
  const uncompiled = open.filter((pair) => pair.strikes < t.strikes);
  const fails = uncompiled.filter((pair) => pair.outcome === 'fail');
  const conflicted = await conflictedPages(view, quarantine.pages);
  const compiles = runs.filter(isCompile);
  const lastCompile = compiles.at(-1)?.at ?? null;
  // A lone fail waits from the last compile, or with none yet, from when the oldest uncompiled fail ended.
  const waitedFrom = lastCompile ?? fails.at(-1)?.ended_at ?? null;
  const waited = waitedFrom !== null && now - Date.parse(waitedFrom) >= t.compileWaitMs;
  const wikiWhy = ((): DueState => {
    if (t.paused) return { due: false, why: 'the knowledge loop is paused' };
    if (inProgress.has('wiki-maintainer')) return { due: false, why: 'a Wiki Maintainer run is in progress on this machine' };
    if (conflicted.length > 0) return { due: true, why: `${conflicted.length} conflicted wiki page${conflicted.length === 1 ? '' : 's'}` };
    if (uncompiled.length >= t.compilePairs && fails.length >= t.compileFails) {
      return { due: true, why: `${uncompiled.length} uncompiled traces, ${fails.length} failing` };
    }
    if (fails.length >= 1 && waited) return { due: true, why: `${fails.length} uncompiled failing trace${fails.length === 1 ? '' : 's'}, and no compile for a while` };
    if (options.manual && uncompiled.length > 0) return { due: true, why: 'a manual run' };
    if (uncompiled.length === 0) return { due: false, why: 'no uncompiled settled traces' };
    return { due: false, why: `${uncompiled.length} uncompiled traces (${fails.length} failing), below the thresholds` };
  })();
  const wiki: WikiMaintainerDue = { ...wikiWhy, uncompiled, batch: batchOf(uncompiled, t), setAside, conflicted, lastCompile };

  // The Skill Proposer.
  const proposerRuns = runs.filter(isProposerEnd);
  const consumed = new Set(proposerRuns.flatMap((run) => run.consumed));
  const unconsumed = compiles.filter((run) => !consumed.has(run.id));
  const failing = new Set(
    unconsumed.flatMap((run) => run.consumption.filter((pair) => pair.outcome === 'fail' && !quarantine.traces.has(pair.trace)).map((pair) => pair.trace)),
  );
  const lastProposer = proposerRuns.at(-1)?.at ?? null;
  const proposerWhy = ((): DueState => {
    if (t.paused) return { due: false, why: 'the knowledge loop is paused' };
    if (proposals.pending !== null) return { due: false, why: 'a skill proposal is pending human review' };
    if (inProgress.has('skill-proposer')) return { due: false, why: 'a Skill Proposer run is in progress on this machine' };
    if (failing.size >= t.proposeFails) return { due: true, why: `${failing.size} failing traces in compiles not yet proposed from` };
    if (proposals.staleOrLapsedSince(lastProposer)) return { due: true, why: 'a proposal went stale or lapsed' };
    if (options.manual) return { due: true, why: 'a manual run' };
    return { due: false, why: `${failing.size} failing traces in compiles not yet proposed from, below the threshold` };
  })();
  const proposer: SkillProposerDue = { ...proposerWhy, compiles: unconsumed.map((run) => run.id), fails: failing.size, pending: proposals.pending };

  // A compile first; a proposal next when one became due, alternating during catch-up.
  const lastEnded = runs.filter((run) => isCompile(run) || isProposerEnd(run)).at(-1);
  const next: ChoreKind | null =
    wiki.due && proposer.due ? (lastEnded && isCompile(lastEnded) ? 'skill-proposer' : 'wiki-maintainer') : wiki.due ? 'wiki-maintainer' : proposer.due ? 'skill-proposer' : null;
  return { paused: t.paused, 'wiki-maintainer': wiki, 'skill-proposer': proposer, next };
}
