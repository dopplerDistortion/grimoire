// What the human gate shows of a skill proposal and requires before an accept
// (spec §18 Risk flags, Review and decisions): the evidence minimum as it
// stands now (the live evidence flag), the red flags a person must each
// acknowledge, and the decision history. Derived on read; nothing here is
// committed except the acknowledgements an accept records.
import type { ProposalRecord, TrackerView } from '../tracker';
import { EVIDENCE } from './chores/propose';
import type { ActiveQuarantine } from './chores/quarantine';
import type { ProposalState } from './proposals';

/** A cited trace as it stood at drafting and as it stands now. */
export interface LiveTrace {
  trace: string;
  issue: string;
  outcome_at_drafting: string;
  /** The outcome now: `pass`, `fail`, `none`, or null once the trace is purged. */
  outcome_now: string | null;
  wiki_exposed: boolean;
  purged: boolean;
  quarantined: boolean;
  /** Whether it counts toward the evidence minimum now. */
  counts: boolean;
}

/** A cited pattern page now. */
export interface LivePage {
  slug: string;
  /** The page no longer exists. */
  gone: boolean;
  quarantined: boolean;
  counts: boolean;
}

export interface LiveEvidence {
  /** The evidence minimum holds now. */
  meets: boolean;
  pages: number;
  traces: number;
  issues: number;
  fails: number;
  traceRows: LiveTrace[];
  pageRows: LivePage[];
}

/** The evidence minimum re-evaluated on `view` (spec §18): what a purge, a quarantine or an outcome flip took away since drafting. */
export function liveEvidence(view: TrackerView, proposal: ProposalRecord, quarantine: ActiveQuarantine, pages: ReadonlySet<string>): LiveEvidence {
  const traceRows: LiveTrace[] = proposal.traces.map((cited) => {
    const attempt = view.attempt(cited.trace);
    const purged = view.tracePurge(cited.trace) !== undefined || !attempt;
    const quarantined = quarantine.traces.has(cited.trace);
    const now = purged || !attempt?.end ? null : (attempt.outcome?.verdict ?? 'none');
    return {
      trace: cited.trace,
      issue: cited.issue,
      outcome_at_drafting: cited.outcome,
      outcome_now: now,
      wiki_exposed: cited.wiki_exposed,
      purged,
      quarantined,
      counts: !purged && !quarantined && (now === 'pass' || now === 'fail'),
    };
  });
  const pageRows: LivePage[] = proposal.pages.map((slug) => {
    const gone = !pages.has(slug);
    const quarantined = quarantine.pages.has(slug);
    return { slug, gone, quarantined, counts: !gone && !quarantined };
  });
  const counted = traceRows.filter((row) => row.counts);
  const issues = new Set(counted.map((row) => row.issue)).size;
  const fails = counted.filter((row) => row.outcome_now === 'fail').length;
  const pageCount = pageRows.filter((row) => row.counts).length;
  return {
    meets: pageCount >= EVIDENCE.pages && counted.length >= EVIDENCE.traces && issues >= EVIDENCE.issues && fails >= EVIDENCE.fails,
    pages: pageCount,
    traces: counted.length,
    issues,
    fails,
    traceRows,
    pageRows,
  };
}

/** A flag a person must acknowledge before Accept or Accept-then-edit (spec §18 Review and decisions). */
export interface RedFlag {
  /** What an acknowledgement names. */
  flag: string;
  detail: string;
  /** Computed now (the live evidence flag), not at drafting. */
  live: boolean;
}

/** The id of the live evidence flag. */
export const EVIDENCE_FLAG = 'evidence';

/** Every red flag of a proposal: the red risk flags and token origins recorded at drafting, then the live evidence flag. */
export function redFlags(proposal: ProposalRecord, evidence: LiveEvidence): RedFlag[] {
  const flags: RedFlag[] = [];
  const seen = new Set<string>();
  const add = (flag: RedFlag) => {
    if (seen.has(flag.flag)) return;
    seen.add(flag.flag);
    flags.push(flag);
  };
  for (const risk of proposal.flags) if (risk.severity === 'red') add({ flag: risk.flag, detail: risk.detail, live: false });
  for (const token of proposal.tokens) {
    if (token.origin !== 'red') continue;
    add({
      flag: `token:${token.token}`,
      detail: `the ${token.kind} ${JSON.stringify(token.token)} the proposal adds appears ${token.found === 'excerpt' ? 'only in excerpts' : 'nowhere grimoire looked'}`,
      live: false,
    });
  }
  if (!evidence.meets) {
    const lost = [
      ...evidence.traceRows.filter((row) => row.purged).map((row) => `${row.trace} was purged`),
      ...evidence.traceRows.filter((row) => !row.purged && row.quarantined).map((row) => `${row.trace} was quarantined`),
      ...evidence.traceRows
        .filter((row) => !row.purged && !row.quarantined && row.outcome_now !== row.outcome_at_drafting)
        .map((row) => `${row.trace} went from ${row.outcome_at_drafting} to ${row.outcome_now}`),
      ...evidence.pageRows.filter((row) => row.gone).map((row) => `the page ${row.slug} is gone`),
      ...evidence.pageRows.filter((row) => !row.gone && row.quarantined).map((row) => `the page ${row.slug} was quarantined`),
    ];
    add({
      flag: EVIDENCE_FLAG,
      detail: `the evidence fell below the minimum since drafting (${lost.join('; ') || 'it no longer counts'}): now ${evidence.pages} pattern page${evidence.pages === 1 ? '' : 's'}, ${evidence.traces} traces from ${evidence.issues} issues, ${evidence.fails} failing; the minimum is ${EVIDENCE.pages} page and ${EVIDENCE.traces} traces from ${EVIDENCE.issues} issues, ${EVIDENCE.fails} failing`,
      live: true,
    });
  }
  return flags;
}

/** The decision history (spec §18): the accept rate with dismissals excluded, and the median time to decision. */
export interface DecisionHistory {
  /** Proposals a human decided accept or reject (lapses and dismissals aside). */
  decided: number;
  accepted: number;
  rejected: number;
  dismissed: number;
  /** accepted / (accepted + rejected); null with no verdict yet. */
  accept_rate: number | null;
  /** The median hours from a proposal to its first decision; null with none decided. */
  median_hours_to_decision: number | null;
  /** The baseline the rate is shown beside (the paper's ~29%). */
  baseline: number;
}

const ACCEPTED = new Set(['accepted', 'undone', 'contested', 'superseded']);

export function decisionHistory(states: readonly ProposalState[]): DecisionHistory {
  let accepted = 0;
  let rejected = 0;
  let dismissed = 0;
  const hours: number[] = [];
  for (const state of states) {
    if (ACCEPTED.has(state.status)) accepted++;
    else if (state.status === 'rejected') rejected++;
    else if (state.status === 'dismissed') dismissed++;
    else continue;
    const from = Date.parse(state.record.at);
    const to = Date.parse(state.decision?.at ?? '');
    if (Number.isFinite(from) && Number.isFinite(to)) hours.push(Math.max(0, to - from) / 3_600_000);
  }
  hours.sort((a, b) => a - b);
  const mid = hours.length >> 1;
  const median = hours.length === 0 ? null : hours.length % 2 === 1 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
  return {
    decided: accepted + rejected,
    accepted,
    rejected,
    dismissed,
    accept_rate: accepted + rejected === 0 ? null : accepted / (accepted + rejected),
    median_hours_to_decision: median === null ? null : Math.round(median * 100) / 100,
    baseline: 0.29,
  };
}
