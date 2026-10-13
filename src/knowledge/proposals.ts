// Proposal statuses (spec §18 Pending lifecycle), derived on read from the
// proposal records and the skill ledger of the merged view; nothing about a
// proposal's status is ever committed.
//
// - An accept of the proposal decides it `accepted`, unless the skill's
//   derivation says otherwise: `contested` while a reject of the same
//   proposal stands against it unsettled, `superseded` when its accept lost a
//   fork to another change (and still after a later change followed the fork,
//   unless one made its version current again), and `undone` once a restore
//   moved the skill off the version it made current.
// - Otherwise a reject decides it `rejected`; a dismiss `dismissed`, until a
//   reconsider follows it; a `lapse` record (an accept whose checks failed at
//   accept time) `lapsed`.
// - Otherwise it is `stale` once any change of its skill landed that its
//   ledger heads at drafting (`after`) don't already hold: the target moved
//   off its base. Staleness is monotone; a later change back doesn't undo it.
// - Otherwise it is `pending`, and holds the pending slot.
import type { ProposalRecord, TrackerView } from '../tracker';
import type { ProposalSignals } from './chores/due';
import { deriveSkills, type SkillState } from './derive';
import { parseLedgerRecord, type LedgerEntry } from './ledger';
import type { TargetedPattern } from './scorecards';

export type ProposalStatus = 'pending' | 'stale' | 'lapsed' | 'accepted' | 'rejected' | 'dismissed' | 'undone' | 'contested' | 'superseded';

export interface ProposalState {
  readonly record: ProposalRecord;
  readonly status: ProposalStatus;
  /** When the change that made it stale, or its lapse, was recorded; null unless stale or lapsed. */
  readonly staleSince: string | null;
  /** The decision that decided it, or null. */
  readonly decision: LedgerEntry | null;
}

/** The changes of a skill that move it: what makes a proposal on it stale. */
const MOVES: ReadonlySet<string> = new Set(['accept', 'edit', 'record', 'acknowledge', 'restore', 'delete', 'eject']);

/** Every record of `records` that `heads` hold: the heads and everything they follow. */
function held(records: readonly LedgerEntry[], heads: readonly string[]): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.after ?? []));
  }
  return seen;
}

/** The status of every proposal, oldest first. `skills` is the skill book's states, by name. */
export function proposalStates(proposals: readonly ProposalRecord[], skills: ReadonlyMap<string, SkillState>): ProposalState[] {
  return proposals.map((record) => {
    const skill = skills.get(record.skill);
    const records = skill?.records ?? [];
    // Records come each after the ones it follows: the last decision of a kind is the latest.
    const decisions = records.filter((entry) => entry.proposal === record.id);
    const decided = (status: ProposalStatus, decision: LedgerEntry, staleSince: string | null = null): ProposalState => ({ record, status, staleSince, decision });
    const accept = decisions.find((entry) => entry.kind === 'accept');
    if (accept) {
      if (skill?.contested.some((contest) => contest.proposal === record.id)) return decided('contested', accept);
      if (skill && [...skill.superseded, ...skill.lost].some((loser) => loser.id === accept.id)) return decided('superseded', accept);
      // A human who acknowledged another version over a contested accept sided with its reject.
      const reject = decisions.find((entry) => entry.kind === 'reject');
      const sided =
        reject &&
        records.some((entry) => {
          if (entry.kind !== 'acknowledge' || entry.to === accept.to) return false;
          const before = held(records, entry.after);
          return decisions.every((decision) => decision.kind !== 'accept' && decision.kind !== 'reject' ? true : before.has(decision.id));
        });
      if (sided) return decided('rejected', reject);
      const undone = records.some(
        (entry) => entry.kind === 'restore' && accept.to !== null && entry.from === accept.to && held(records, entry.after).has(accept.id),
      );
      return decided(undone ? 'undone' : 'accepted', accept);
    }
    const reject = decisions.find((entry) => entry.kind === 'reject');
    if (reject) return decided('rejected', reject);
    const lastDismissal = decisions.filter((entry) => entry.kind === 'dismiss' || entry.kind === 'reconsider').at(-1);
    if (lastDismissal?.kind === 'dismiss') return decided('dismissed', lastDismissal);
    const lapse = decisions.find((entry) => entry.kind === 'lapse');
    if (lapse) return decided('lapsed', lapse, lapse.at);
    const known = held(records, record.after);
    const moves = records.filter((entry) => MOVES.has(entry.kind) && !known.has(entry.id));
    if (moves.length > 0) {
      const since = moves.map((entry) => entry.at).sort()[0]!;
      return { record, status: 'stale', staleSince: since, decision: null };
    }
    return { record, status: 'pending', staleSince: null, decision: null };
  });
}

/**
 * The proposal states of `view`, from its ledger alone (no content check:
 * statuses don't depend on whether a version may be served).
 */
export async function viewProposalStates(view: Pick<TrackerView, 'ledgerFiles' | 'proposals'>): Promise<ProposalState[]> {
  const entries = [...(await view.ledgerFiles())].map(([id, bytes]) => parseLedgerRecord(id, bytes)).filter((entry): entry is LedgerEntry => entry !== null);
  return proposalStates(await view.proposals.records(), deriveSkills(entries));
}

/** What due-ness needs to know of the proposals (spec §16): the pending slot, and proposals gone stale since a time. */
export async function proposalSignals(view: Pick<TrackerView, 'ledgerFiles' | 'proposals'>): Promise<ProposalSignals> {
  const states = await viewProposalStates(view);
  const pending = states.filter((state) => state.status === 'pending');
  return {
    pending: pending[0]?.record.id ?? null,
    pendingCount: pending.length,
    staleOrLapsedSince: (at) => states.some((state) => state.staleSince !== null && (at === null || state.staleSince > at)),
  };
}

/**
 * The pattern each accepted version targeted (spec §18 scorecards: recurrence
 * of the targeted pattern): for a version an accept of a proposal made
 * current, the traces its cited pattern pages name now, set-aside sides
 * included. Versions no proposal made are absent.
 */
export async function targetedPatterns(
  view: Pick<TrackerView, 'proposals' | 'wiki'>,
  records: readonly LedgerEntry[],
): Promise<Map<string, TargetedPattern>> {
  const proposals = new Map((await view.proposals.records()).map((record) => [record.id, record]));
  const patterns = new Map<string, TargetedPattern>();
  for (const record of records) {
    if (record.kind !== 'accept' || record.to === null || record.proposal === undefined || patterns.has(record.to)) continue;
    const proposal = proposals.get(record.proposal);
    if (!proposal) continue;
    const sources = new Set<string>();
    for (const slug of proposal.pages) {
      for (const source of (await view.wiki.page(slug))?.sources ?? []) sources.add(source);
      for (const side of await view.wiki.conflicts(slug)) for (const source of side.sources) sources.add(source);
    }
    patterns.set(record.to, { sources });
  }
  return patterns;
}
