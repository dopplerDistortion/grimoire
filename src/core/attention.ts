// `attention` (spec §20 Attention, dashboard read ops): only what a human
// must unblock, each item carrying what its inline action needs, plus the
// quick views' counts for the tiles below the queue. Issue and sync items:
//
// - a sync failure a person must fix (the remote refused the push, or the
//   credentials failed), with the remote's message and the fix → Sync
//   settings, Sync now. A network failure is left out: it settles on its own;
// - a cross-clone id collision no forwarding record settles yet → the
//   `grimoire resolve` command (CLI-only in v1);
// - a field conflict → Resolve;
// - two open attempts (claims made on two clones) → release either as abandoned;
// - a stale claim: an open attempt whose last activity is older than this
//   machine's `dashboard.stale_after` → Release as abandoned, Open;
// - a stray edit waiting on this machine → Record, Discard.
//
// And the knowledge items (spec §20 Attention, §16-§18):
//
// - the pending proposal, with its age and red-flag and cited-trace counts → Review;
// - a skill fork (or a contested decision) to pick → Acknowledge;
// - a conflicted wiki page;
// - a set-aside pair, and a page a quarantined trace flags → Open trace, Quarantine.
//
// Runner trouble (backoff, a refused preflight) is this machine's, read by
// `start` beside the ops: the dashboard adds that item itself.
//
// It fails closed: a section that can't be read (the stray edits, the
// knowledge items) is named in `unreadable`, so the queue never reads
// "Nothing needs you" while it may hide something; the rest still shows.
import { proposalStates, readSkills, type LedgerEntry } from '../knowledge';
import { activeQuarantine, flaggedPages } from '../knowledge/chores';
import type { SecretScanner } from '../scanner';
import { bareId, collisionSides, type TrackerStore, type TrackerView } from '../tracker';
import { listedOpenAttempt, type ListedOpenAttempt } from './attempts';
import { dueChoresIn, storeOf } from './chores';
import type { CallContext } from './context';
import { derivations, fieldConflict } from './derive';
import type { PendingProposalSummary } from './knowledge-overview';
import { inView } from './list';
import { define } from './op';
import { flagsOf } from './proposals';
import { s } from './schema';
import { acknowledgeable } from './skill-changes';
import { staleCutoff } from './stale';
import { skillStrays, type ShownStrayEdit } from './stray-edits';
import { syncFix, syncStatus, type SyncStatusResult } from './sync';
import { GrimoireError } from '../errors';

/** One sync failure as Attention shows it. */
export interface SyncFailureItem {
  kind: 'sync_failure';
  class: 'auth' | 'rejected';
  /** The remote's own words. */
  message: string;
  remote: string | null;
  url: string | null;
  /** The client and surface whose process hit it, and when. */
  client: string;
  surface: string;
  at: string;
  /** What a person does about it, in words. */
  fix: string;
  /** Since when the local tip waits to reach the remote. */
  pending_since: string | null;
}

export type AttentionItem =
  | SyncFailureItem
  | {
      kind: 'id_collision';
      /** The bare id two clones minted for different issues. */
      id: string;
      /** Its records, each reachable as `<id>~<hash4>`. */
      sides: { id: string; title: string; status: string }[];
      /** The CLI command that settles it (resolving a collision is CLI-only in v1). */
      command: string;
    }
  | { kind: 'field_conflict'; issue: string; title: string; fields: string[] }
  | { kind: 'open_attempts'; issue: string; title: string; attempts: ListedOpenAttempt[] }
  | { kind: 'stale_claim'; issue: string; title: string; attempt: ListedOpenAttempt }
  | { kind: 'stray_edit'; stray: ShownStrayEdit }
  | KnowledgeItem;

/** One version a fork's (or a contested decision's) acknowledgement may pick. */
export interface ForkChoice {
  version: string;
  /** The version that stands now (the ledger's rules picked it). */
  standing: boolean;
  /** The latest record that made it current: what it was, by whom, when. */
  kind: string | null;
  by: string | null;
  at: string | null;
}

/** The knowledge items of Attention (spec §20). */
export type KnowledgeItem =
  | { kind: 'pending_proposal'; proposal: PendingProposalSummary }
  | {
      kind: 'skill_fork';
      skill: string;
      /** The version that stands now. */
      current: string | null;
      /** Two clones changed it apart (fork), and/or an accept met a reject of one proposal (contested). */
      fork: boolean;
      contested: string[];
      choices: ForkChoice[];
    }
  | { kind: 'wiki_conflict'; slug: string; title: string; sides: number }
  | { kind: 'set_aside'; pair: string; trace: string; issue: string; outcome: string; strikes: number }
  | { kind: 'flagged_page'; slug: string; title: string; flagged_by: string[] };

/** A section of the queue that couldn't be read: its items may be missing. */
export interface UnreadableSection {
  section: 'stray_edits' | 'knowledge';
  /** The error's code (INTERNAL for one grimoire didn't expect) and message. */
  code: string;
  message: string;
}

export interface AttentionResult {
  /** What needs a person, most pressing first; empty when nothing does (and `unreadable` is empty). */
  items: AttentionItem[];
  /** The sections that couldn't be read: while one is listed, the queue may hide what needs a person. */
  unreadable: UnreadableSection[];
  /** The quick views' sizes, for the tiles linking to them. */
  counts: { ready: number; claimed: number; stale: number; blocked: number; conflicts: number };
}

const COUNTED = ['ready', 'claimed', 'stale', 'blocked', 'conflicts'] as const;

function syncItems(status: SyncStatusResult): SyncFailureItem[] {
  const failure = status.failure;
  if (!failure || failure.class === 'network') return [];
  return [
    {
      kind: 'sync_failure',
      class: failure.class,
      message: failure.message,
      remote: status.remote,
      url: status.url,
      client: failure.client,
      surface: failure.surface,
      at: failure.at,
      fix: status.fix ?? syncFix(failure, status.remote),
      pending_since: status.pending_since,
    },
  ];
}

/** The collisions no forwarding record settles, by bare id. */
function collisionItems(view: TrackerView): AttentionItem[] {
  const ids = view.issues().map((issue) => issue.id);
  const bare = [...new Set(ids.filter((id) => id.includes('~')).map(bareId))].sort();
  const items: AttentionItem[] = [];
  for (const id of bare) {
    if (view.forwardOf(id) !== undefined) continue;
    const sides = collisionSides(id, ids);
    if (sides.length < 2) continue;
    items.push({
      kind: 'id_collision',
      id,
      sides: sides.map((side) => {
        const issue = view.issue(side)!;
        return { id: side, title: issue.title, status: issue.status };
      }),
      command: `grimoire resolve ${id} --keep <${id}~hash4>`,
    });
  }
  return items;
}

function choiceOf(records: readonly LedgerEntry[], version: string, standing: string | null): ForkChoice {
  const made = [...records].reverse().find((record) => record.to === version);
  return { version, standing: version === standing, kind: made?.kind ?? null, by: made?.by ?? null, at: made?.at ?? null };
}

/** The knowledge items, in the order they are shown: the pending proposal first, the rest after the issue items. */
async function knowledgeItems(view: TrackerView, tracker: TrackerStore, ctx: CallContext, scanner: SecretScanner): Promise<{ first: KnowledgeItem[]; rest: KnowledgeItem[] }> {
  const now = tracker.now();
  const book = await readSkills(view, scanner);
  const quarantine = await activeQuarantine(view);
  const first: KnowledgeItem[] = [];
  const pending = proposalStates(await view.proposals.records(), book.skills)
    .filter((state) => state.status === 'pending')
    .sort((x, y) => (x.record.at < y.record.at ? -1 : x.record.at > y.record.at ? 1 : 0));
  for (const { record } of pending) {
    const { flags } = await flagsOf(view, record, quarantine);
    first.push({
      kind: 'pending_proposal',
      proposal: {
        id: record.id,
        skill: record.skill,
        action: record.action,
        at: record.at,
        age_hours: Math.max(0, Math.floor((now.getTime() - Date.parse(record.at)) / 3_600_000)),
        red_flags: flags.length,
        traces: record.traces.length,
        pages: record.pages.length,
      },
    });
  }

  const rest: KnowledgeItem[] = [];
  for (const state of [...book.skills.values()].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (state.status === 'deleted' || state.status === 'ejected') continue;
    const choices = [...acknowledgeable(state)].sort();
    if (choices.length === 0) continue;
    rest.push({
      kind: 'skill_fork',
      skill: state.name,
      current: state.version,
      fork: state.superseded.length > 0,
      contested: state.contested.map((contest) => contest.proposal),
      choices: choices.map((version) => choiceOf(state.records, version, state.version)),
    });
  }
  const pages = await view.wiki.pages();
  for (const page of pages) {
    const sides = (await view.wiki.conflicts(page.slug)).length;
    if (sides > 0 && !quarantine.pages.has(page.slug)) rest.push({ kind: 'wiki_conflict', slug: page.slug, title: page.title, sides });
  }
  const due = await dueChoresIn(view, storeOf(tracker, ctx), now);
  for (const pair of due['wiki-maintainer'].setAside) {
    rest.push({ kind: 'set_aside', pair: pair.id, trace: pair.trace, issue: pair.issue, outcome: pair.outcome, strikes: pair.strikes });
  }
  const titles = new Map(pages.map((page) => [page.slug, page.title]));
  for (const [slug, traces] of await flaggedPages(view)) {
    rest.push({ kind: 'flagged_page', slug, title: titles.get(slug) ?? slug, flagged_by: traces });
  }
  return { first, rest };
}

export const attention = define({
  name: 'attention',
  description:
    'What needs a person: sync failures to fix, the pending skill proposal, id collisions, field conflicts, two open attempts, stale claims, stray edits, skill forks, conflicted wiki pages, set-aside pairs and flagged pages, each with what its action needs; plus the Ready, Claimed, Stale, Blocked and Conflicts counts. For people: the dashboard’s home.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({}),
  async run(_input, env): Promise<AttentionResult> {
    const { ctx, tracker } = env;
    const view = await tracker.read();
    const staleBefore = await staleCutoff(tracker.location.commonDir, tracker.now());
    const derived = derivations(view, staleBefore);
    const person = ctx.person.email;

    const counts = { ready: 0, claimed: 0, stale: 0, blocked: 0, conflicts: 0 };
    const conflicts: AttentionItem[] = [];
    const doubles: AttentionItem[] = [];
    const stale: AttentionItem[] = [];
    for (const issue of view.issues()) {
      const d = derived.of(issue.id);
      for (const name of COUNTED) if (inView(name, issue, d)) counts[name]++;
      const fields = fieldConflict(view, issue.id);
      if (fields) conflicts.push({ kind: 'field_conflict', issue: issue.id, title: issue.title, fields: fields.fields });
      const open = d.openAttempts.map((facts) => listedOpenAttempt(facts, person, staleBefore));
      if (open.length > 1) doubles.push({ kind: 'open_attempts', issue: issue.id, title: issue.title, attempts: open });
      for (const attempt of open) if (attempt.stale) stale.push({ kind: 'stale_claim', issue: issue.id, title: issue.title, attempt });
    }

    const status = await syncStatus.run({}, env);
    // A section that can't be read never hides the rest of the queue, and is named, never shown as empty.
    const unreadable: UnreadableSection[] = [];
    const unread = (section: UnreadableSection['section']) => (error: unknown) => {
      unreadable.push({
        section,
        code: error instanceof GrimoireError ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    };
    const knowledge = (await knowledgeItems(view, tracker, ctx, env.scanner).catch(unread('knowledge'))) ?? { first: [], rest: [] };
    const strays = ((await skillStrays.run({}, env).catch(unread('stray_edits')))?.stray_edits ?? []).map((stray): AttentionItem => ({ kind: 'stray_edit', stray }));
    return {
      items: [...syncItems(status), ...knowledge.first, ...collisionItems(view), ...conflicts, ...doubles, ...stale, ...strays, ...knowledge.rest],
      unreadable,
      counts,
    };
  },
});
