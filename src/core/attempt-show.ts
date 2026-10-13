// `attempt_show` (spec §20 Attempt page, dashboard read ops): one attempt as
// a person audits what an agent did:
//
// - the outcome, with its history (each version of the mutable outcome record
//   from the tracker's history, oldest first);
// - the start facts (how it opened, the actor, the delivery switch, the
//   offered versions, wiki-exposed) and the end facts (how it ended, by whom,
//   the referenced commits);
// - the capture status (spec §14 Statuses): each bound context's entry with
//   its excerpt and facts statuses and the excerpt itself as text, any purge
//   tombstone of its record, `facts_complete`, the wiki-exposed basis (the
//   claim's, each binding write's on `Grimoire-Actor`, and the seal's OR),
//   and every commit with its `via`;
// - the knowledge use: the pattern pages and the skill proposals citing it;
// - its quarantine mark, if any.
//
// A purged trace (spec §3) shows its tombstone and nothing else.
import { GrimoireError } from '../errors';
import { runGit } from '../git/run';
import { proposalStates, readSkills, type ProposalStatus } from '../knowledge';
import { activeQuarantine } from '../knowledge/chores/quarantine';
import type { SecretScanner } from '../scanner';
import { parseSessionRecord } from '../capture/session-record';
import { type AttemptRecord, type TrackerView } from '../tracker';
import { outcomeFile } from '../tracker/layout';
import { parseOutcome } from '../tracker/attempt';
import { logEntries, readBlobs } from './activity';
import { parseHandle } from './attempts';
import { traceCapture, type CaptureEntry } from './capture';
import { citingPages, citingProposals } from './citing';
import { derivations } from './derive';
import { define, oneLine } from './op';
import { s } from './schema';
import { staleCutoff } from './stale';

export interface ShownOutcome {
  verdict: string;
  reason: string;
  /** `grimoire` or `human:<email>`. */
  set_by: string;
  at: string;
}

/** One bound context on the attempt page: its capture entry, its excerpt, and its record's purge. */
export interface ShownContext extends CaptureEntry {
  /** The excerpt as cut (inert source text); null when none was kept (facts or none mode, a failed cut, a purge). */
  text: string | null;
  /** The tombstone of its purged record: the excerpt alone (`facts: kept`) or with its facts. */
  purge: { by: string; at: string; reason: string; facts: string } | null;
}

/** One write that found the calling session or process chore-exposed (spec §14 Wiki-exposed). */
export interface ExposureHit {
  commit: string;
  at: string;
  op: string;
  /** `session` or `process`: what the exposure mark matched. */
  basis: string;
  client: string | null;
  session: string | null;
}

export interface AttemptShowResult {
  attempt: string;
  /** `purged`: only the tombstone is left. */
  state: 'open' | 'ended' | 'purged';
  purged: { by: string; at: string; reason: string } | null;
  /** The attempt's issue; title null when the issue was deleted since. */
  issue: { id: string; title: string | null; status: string } | null;
  start: {
    assignee: string;
    actor: Record<string, unknown>;
    opened: string;
    at: string;
    start_commit: string;
    wiki_exposed: boolean;
    /** The delivery switch at the opening; null when `start.md` doesn't record it. */
    delivery: string | null;
    /** The evolved skills the opening checkout offered; null when nothing is known of them (a human assign). */
    skills_offered: unknown[] | null;
  } | null;
  end: {
    ended: string;
    ended_by: Record<string, unknown>;
    at: string;
    debrief: string | null;
    worker_kind: string;
    wiki_exposed: boolean;
    field_changes: string[];
    commits: unknown[];
  } | null;
  outcome: ShownOutcome | null;
  /** Every verdict the outcome record held, oldest first (the last is the current one). */
  outcome_history: ShownOutcome[];
  /** An open attempt's latest write on its issue, and whether that is older than this machine's stale threshold. */
  last_activity_at: string | null;
  stale: boolean;
  /** Two clones sealed it differently: the seals a fold set aside. */
  set_aside: number;
  capture: {
    contexts: ShownContext[];
    facts_complete: boolean;
    wiki_exposed: { exposed: boolean; at_start: boolean; at_end: boolean | null; hits: ExposureHit[] };
    /** Observed commits (each context's, with its key) and referenced ones (`end.md`'s). */
    commits: Record<string, unknown>[];
  };
  knowledge: { pages: { slug: string; title: string; kind: string }[]; proposals: { id: string; skill: string; action: string; at: string; status: ProposalStatus }[] };
  quarantine: { by: string; at: string; reason: string } | null;
}

const NO_CAPTURE: AttemptShowResult['capture'] = { contexts: [], facts_complete: false, wiki_exposed: { exposed: false, at_start: false, at_end: null, hits: [] }, commits: [] };

/**
 * Each version the outcome record of `record` held, oldest first, over the
 * history of `tips` (the view's parents: both tips of a fold). The full
 * history: simplifying at a fold's merge would drop one side's verdicts.
 */
async function outcomeHistory(root: string, tips: readonly string[], record: AttemptRecord): Promise<ShownOutcome[]> {
  const file = outcomeFile(record.issue, record.id);
  const run = await runGit(root, ['log', '--full-history', '--date-order', '--format=%H', ...tips, '--', file]);
  if (run.code !== 0) return [];
  const commits = run.stdout.toString('utf8').split('\n').filter(Boolean).reverse();
  const blobs = await readBlobs(root, commits.map((commit) => `${commit}:${file}`));
  const history: ShownOutcome[] = [];
  for (const commit of commits) {
    const blob = blobs.get(`${commit}:${file}`);
    if (!blob) continue;
    const { verdict, reason, set_by, at } = parseOutcome(blob);
    const last = history.at(-1);
    if (last && last.verdict === verdict && last.reason === reason && last.set_by === set_by && last.at === at) continue;
    history.push({ verdict, reason, set_by, at });
  }
  return history;
}

/** The writes that bound to `handle` from a chore-exposed session or process, oldest first. */
async function exposureHits(root: string, tips: readonly string[], handle: string): Promise<ExposureHit[]> {
  const entries = await logEntries(root, tips, { grep: ['Grimoire-Attempt', handle] });
  return entries
    .filter((entry) => entry.attempt === handle && entry.actor.chore_exposure !== undefined)
    .reverse()
    .map((entry) => ({
      commit: entry.commit,
      at: entry.at,
      op: entry.op,
      basis: entry.actor.chore_exposure!,
      client: entry.actor.client ?? null,
      session: entry.actor.session ?? null,
    }));
}

async function contextsOf(view: TrackerView, handle: string): Promise<{ contexts: ShownContext[]; facts_complete: boolean; referenced: unknown[] }> {
  const capture = await traceCapture(view, handle);
  const contexts: ShownContext[] = [];
  for (const entry of capture.contexts) {
    const tombstone = view.sessionPurge(handle, entry.key);
    let text: string | null = null;
    if (!tombstone) {
      const bytes = await view.sessionRecord(handle, entry.key);
      text = bytes ? parseSessionRecord(bytes).text : null;
    }
    contexts.push({
      ...entry,
      text,
      purge: tombstone ? { by: tombstone.by, at: tombstone.at, reason: tombstone.reason, facts: tombstone.facts ?? 'purged' } : null,
    });
  }
  return { contexts, facts_complete: capture.facts_complete, referenced: capture.referenced };
}

/** Every commit the trace knows, observed (with the context that saw it) and referenced, each once. */
function commitsOf(contexts: readonly ShownContext[], referenced: readonly unknown[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const add = (fact: unknown, extra: Record<string, unknown>) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return;
    const commit = fact as Record<string, unknown>;
    const id = `${String(commit.hash)}\0${String(commit.via)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...commit, ...extra });
  };
  for (const context of contexts) for (const fact of context.commits) add(fact, { context_key: context.key });
  for (const fact of referenced) add(fact, {});
  return out;
}

/** What cites the trace: exactly what purge_trace names (one reading), each proposal with its status. */
async function knowledgeOf(view: TrackerView, handle: string, scanner: SecretScanner): Promise<AttemptShowResult['knowledge']> {
  const pages = (await citingPages(view, handle)).map((page) => ({ slug: page.slug, title: page.title, kind: page.kind }));
  const citing = await citingProposals(view, handle);
  const states = citing.length === 0 ? [] : proposalStates(citing, (await readSkills(view, scanner)).skills);
  const proposals = states.map(({ record, status }) => ({ id: record.id, skill: record.skill, action: record.action, at: record.at, status }));
  return { pages, proposals };
}

export const attemptShow = define({
  name: 'attempt_show',
  description:
    'One attempt as a person audits it: the outcome and its history, start and end facts, each bound context’s capture statuses with its excerpt as text, facts_complete, the wiki-exposed basis, commits with via, and the pages and proposals citing it. A purged trace shows its tombstone. For people: the dashboard’s attempt page.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({ attempt: s.string({ ...oneLine, description: 'the attempt handle (at-…)' }) }),
  async run(input, { tracker, scanner }): Promise<AttemptShowResult> {
    const handle = parseHandle(input.attempt);
    const view = await tracker.read();
    const record = view.attempt(handle);
    const knowledge = await knowledgeOf(view, handle, scanner);
    if (!record) {
      const tombstone = view.tracePurge(handle);
      if (!tombstone) throw new GrimoireError('NOT_FOUND', `there is no attempt ${handle}`, { field: 'attempt', ref: handle });
      return {
        attempt: handle,
        state: 'purged',
        purged: { by: tombstone.by, at: tombstone.at, reason: tombstone.reason },
        issue: null,
        start: null,
        end: null,
        outcome: null,
        outcome_history: [],
        last_activity_at: null,
        stale: false,
        set_aside: 0,
        capture: NO_CAPTURE,
        knowledge,
        quarantine: null,
      };
    }

    const root = tracker.location.root;
    const issue = view.issue(record.issue);
    let lastActivity: string | null = null;
    let stale = false;
    if (!record.end && issue) {
      const staleBefore = await staleCutoff(tracker.location.commonDir, tracker.now());
      const facts = derivations(view, staleBefore)
        .of(issue.id)
        .openAttempts.find((open) => open.record.id === handle);
      if (facts) {
        lastActivity = facts.lastActivityAt;
        stale = Date.parse(facts.lastActivityAt) < staleBefore;
      }
    }
    const { contexts, facts_complete, referenced } = await contextsOf(view, handle);
    const hits = await exposureHits(root, view.parents, handle);
    const atEnd = record.end ? record.end.wiki_exposed : null;
    const marks = (await activeQuarantine(view)).traces.get(handle) ?? [];
    const mark = marks.at(-1);
    const { start, end } = record;
    return {
      attempt: handle,
      state: end ? 'ended' : 'open',
      purged: null,
      issue: { id: record.issue, title: issue?.title ?? null, status: issue?.status ?? 'deleted' },
      start: {
        assignee: start.assignee,
        actor: { ...start.actor },
        opened: start.opened,
        at: start.at,
        start_commit: start.start_commit,
        wiki_exposed: start.wiki_exposed,
        delivery: start.delivery ?? null,
        skills_offered: start.skills_offered ? [...start.skills_offered] : null,
      },
      end: end
        ? {
            ended: end.ended,
            ended_by: { ...end.ended_by },
            at: end.at,
            debrief: end.debrief,
            worker_kind: end.worker_kind,
            wiki_exposed: end.wiki_exposed,
            field_changes: [...end.field_changes],
            commits: [...end.commits],
          }
        : null,
      outcome: record.outcome ? { verdict: record.outcome.verdict, reason: record.outcome.reason, set_by: record.outcome.set_by, at: record.outcome.at } : null,
      outcome_history: record.outcome ? await outcomeHistory(root, view.parents, record) : [],
      last_activity_at: lastActivity,
      stale,
      set_aside: record.setAside.length,
      capture: {
        contexts,
        facts_complete,
        wiki_exposed: { exposed: start.wiki_exposed || atEnd === true || hits.length > 0, at_start: start.wiki_exposed, at_end: atEnd, hits },
        commits: commitsOf(contexts, referenced),
      },
      knowledge,
      quarantine: mark ? { by: mark.by, at: mark.at, reason: mark.reason } : null,
    };
  },
});

