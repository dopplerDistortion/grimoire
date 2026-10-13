// `knowledge_overview` (spec §20 Knowledge, Overview; dashboard read ops): the
// knowledge layer on one screen. The loop and delivery switches, the pending
// proposal with its age, red-flag and cited-trace counts, the backlog of
// uncompiled settled pairs, the last compile and the cap (n / 8); what is due,
// or why not (nothing here starts a chore); the state counts (stale, lapsed,
// contested, forks, set-aside, quarantined); pickup; the recent decisions with
// the accept rate and the median time to decision; the set-aside pairs; and
// the recent chore runs. The runner's card is this machine's, served by
// `start` beside the ops (the core can't read the runner).
import { decisionHistory, type DecisionHistory } from '../knowledge/gate';
import { proposalStates, readSkills } from '../knowledge';
import { activeQuarantine } from '../knowledge/chores';
import type { ChoreKind } from '../tracker';
import { choreRunRows, type ChoreRunRow } from './chore-runs';
import { dueChoresIn, storeOf } from './chores';
import { define } from './op';
import { flagsOf } from './proposals';
import { s } from './schema';
import { machineSetting, storeSetting } from './settings';
import { deliveryOn } from './skills';

const HOUR = 3_600_000;
/** How many recent decisions and chore runs the overview lists. */
const RECENT = 5;

/** The pending proposal, as the overview's tile and Attention show it. */
export interface PendingProposalSummary {
  id: string;
  skill: string;
  action: string;
  at: string;
  age_hours: number;
  /** Red flags an accept must acknowledge now, the live evidence flag included. */
  red_flags: number;
  /** Cited traces and pages. */
  traces: number;
  pages: number;
}

/** A set-aside pair: a pair the 2-strike rule took out of compiles (shown, never offered). */
export interface SetAsidePair {
  pair: string;
  trace: string;
  issue: string;
  outcome: string;
  strikes: number;
  ended_at: string;
}

export interface RecentDecision {
  id: string;
  skill: string;
  action: string;
  status: string;
  decided_at: string;
  by: string;
  /** Hours from drafting to the decision. */
  hours: number | null;
}

export interface KnowledgeOverviewResult {
  loop: 'on' | 'paused';
  delivery: 'on' | 'off';
  /** This machine's `knowledge.pickup`. */
  pickup: string;
  /** The oldest pending proposal, or null. */
  pending: PendingProposalSummary | null;
  pending_count: number;
  pending_limit: number;
  /** Uncompiled settled pairs, set-aside ones aside. */
  backlog: { pairs: number; fails: number; passes: number };
  last_compile: { run: string; at: string } | null;
  /** Active evolved skills against skills.max_active. */
  cap: { active: number; max: number; over: boolean };
  /** What is due, or why not. */
  due: { paused: boolean; next: ChoreKind | null } & Record<ChoreKind, { due: boolean; why: string }>;
  counts: { stale: number; lapsed: number; contested: number; forks: number; set_aside: number; quarantined: number };
  history: DecisionHistory;
  /** The latest decisions, newest first. */
  decisions: RecentDecision[];
  set_aside: SetAsidePair[];
  /** The latest chore runs, newest first. */
  runs: ChoreRunRow[];
}

const hoursBetween = (from: string, to: string): number | null => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.round((ms / HOUR) * 100) / 100 : null;
};

export const knowledgeOverview = define({
  name: 'knowledge_overview',
  description:
    'The knowledge layer at a glance: the loop and delivery switches, the pending proposal, the backlog, the last compile, the cap, what is due or why not, the state counts, pickup, recent decisions with the accept rate, set-aside pairs and recent chore runs. Starts nothing. Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({}),
  async run(_input, { ctx, tracker, scanner }): Promise<KnowledgeOverviewResult> {
    const view = await tracker.read();
    const now = tracker.now();
    const store = storeOf(tracker, ctx);
    const book = await readSkills(view, scanner);
    const records = await view.proposals.records();
    const states = proposalStates(records, book.skills);
    const due = await dueChoresIn(view, store, now);
    const wiki = due['wiki-maintainer'];
    const quarantine = await activeQuarantine(view);

    const pendingStates = states.filter((state) => state.status === 'pending').sort((x, y) => (x.record.at < y.record.at ? -1 : x.record.at > y.record.at ? 1 : 0));
    const oldest = pendingStates[0];
    let pending: PendingProposalSummary | null = null;
    if (oldest) {
      const { flags } = await flagsOf(view, oldest.record, quarantine);
      pending = {
        id: oldest.record.id,
        skill: oldest.record.skill,
        action: oldest.record.action,
        at: oldest.record.at,
        age_hours: Math.max(0, Math.floor((now.getTime() - Date.parse(oldest.record.at)) / HOUR)),
        red_flags: flags.length,
        traces: oldest.record.traces.length,
        pages: oldest.record.pages.length,
      };
    }

    const compiles = (await view.choreRuns.records()).filter((run) => run.kind === 'wiki-maintainer' && run.result === 'compiled');
    const last = compiles.reduce<(typeof compiles)[number] | null>((latest, run) => (latest === null || run.at > latest.at ? run : latest), null);
    const skills = [...book.skills.values()];
    const max = storeSetting(view, 'skills.max_active') as number;
    const decided = states
      .filter((state) => state.decision !== null)
      .sort((x, y) => (x.decision!.at > y.decision!.at ? -1 : x.decision!.at < y.decision!.at ? 1 : 0))
      .slice(0, RECENT);

    return {
      loop: due.paused ? 'paused' : 'on',
      delivery: deliveryOn(view) ? 'on' : 'off',
      pickup: String(await machineSetting(tracker.location.commonDir, 'knowledge.pickup')),
      pending,
      pending_count: pendingStates.length,
      pending_limit: storeSetting(view, 'proposals.pending_limit') as number,
      backlog: {
        pairs: wiki.uncompiled.length,
        fails: wiki.uncompiled.filter((pair) => pair.outcome === 'fail').length,
        passes: wiki.uncompiled.filter((pair) => pair.outcome === 'pass').length,
      },
      last_compile: last ? { run: last.id, at: last.at } : null,
      cap: { active: book.active, max, over: book.active > max },
      due: {
        paused: due.paused,
        next: due.next,
        'wiki-maintainer': { due: wiki.due, why: wiki.why },
        'skill-proposer': { due: due['skill-proposer'].due, why: due['skill-proposer'].why },
      },
      counts: {
        stale: states.filter((state) => state.status === 'stale').length,
        lapsed: states.filter((state) => state.status === 'lapsed').length,
        contested: skills.reduce((n, state) => n + state.contested.length, 0),
        forks: skills.filter((state) => state.superseded.length > 0).length,
        set_aside: wiki.setAside.length,
        quarantined: quarantine.pages.size + quarantine.traces.size,
      },
      history: decisionHistory(states),
      decisions: decided.map((state) => ({
        id: state.record.id,
        skill: state.record.skill,
        action: state.record.action,
        status: state.status,
        decided_at: state.decision!.at,
        by: state.decision!.by,
        hours: hoursBetween(state.record.at, state.decision!.at),
      })),
      set_aside: wiki.setAside.map((pair) => ({ pair: pair.id, trace: pair.trace, issue: pair.issue, outcome: pair.outcome, strikes: pair.strikes, ended_at: pair.ended_at })),
      runs: (await choreRunRows(view, store, now)).slice(0, RECENT),
    };
  },
});
