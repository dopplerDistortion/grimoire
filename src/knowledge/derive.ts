// Which skill version is current, and which is served (spec §18 Forks across
// clones; §15 Reconcile). Derived from the skill ledger alone, in the merged
// tracker view, so branches play no part. These rules belong to the store
// format: every release on every clone derives the same answer from the same
// records, and never by the clock.
//
// A record's `after` lists the skill's records it followed, so the records
// form a graph. Its heads (changes nothing later followed) are what is current;
// two or more heads that disagree are a fork, resolved like this:
//
// - a delete (or an eject) beats a restore, which beats a change that writes a
//   version (accept, edit, a recorded stray edit, acknowledge);
// - between two of the same rank, the lower version hash serves until a human
//   acknowledges one; the losers are superseded, and stay so after a later
//   change follows the fork (an acknowledge picking the other side, or an
//   edit, restore or delete over both) until a change makes their version
//   current again;
// - an accept against a reject of the same proposal is contested, and is
//   served as accepted, unless a `suspicious` reject is involved: then the
//   accepted version is served nowhere until a human settles it, and the
//   version that was current before it keeps serving. Any human skill change
//   that follows all of a decision's accepts and rejects settles it: an
//   acknowledge, or instead a `skill edit`, a restore, a delete, …
//
// What is served also skips versions that fail the content checks (`servable`):
// wherever the rules would serve a skipped version, the record that made it
// current is set aside and the rules run again over the rest, so the previous
// current version, if any, keeps serving.
import type { LedgerEntry } from './ledger';

/** The ranks of the changes that decide a skill's state; every other kind leaves it as it is. */
const RANK: ReadonlyMap<string, number> = new Map([
  ['delete', 3],
  ['eject', 3],
  ['restore', 2],
  ['accept', 1],
  ['edit', 1],
  ['record', 1],
  ['acknowledge', 1],
]);
const REMOVES: ReadonlySet<string> = new Set(['delete', 'eject']);
/** The skill changes a human makes with the skill in front of them: one that follows a contested decision settles it. */
export const SETTLES: ReadonlySet<string> = new Set(['acknowledge', 'edit', 'record', 'restore', 'delete', 'eject']);

export type SkillStatus = 'active' | 'deleted' | 'ejected' | 'none';

/** An accept and a reject of one proposal that no later human change has settled. */
export interface ContestedDecision {
  readonly proposal: string;
  readonly accepts: readonly LedgerEntry[];
  readonly rejects: readonly LedgerEntry[];
  /** A `suspicious` reject is involved: the accepted versions are served nowhere until a human settles it. */
  readonly withheld: boolean;
}

export interface SkillState {
  readonly name: string;
  /** The change the ledger's rules make current, or null when the ledger has none for this skill. */
  readonly current: LedgerEntry | null;
  /** `active` (current names a version), `deleted`, `ejected`, or `none`. */
  readonly status: SkillStatus;
  /** The current version, when active. */
  readonly version: string | null;
  /** What agents get: the current version unless it is withheld or fails the content checks; null for nothing. */
  readonly served: { readonly version: string; readonly record: LedgerEntry } | null;
  /** Deleted or ejected, and no human has lifted the name's block since. */
  readonly blocked: boolean;
  /** Heads that lost a fork to `current`: superseded until a human acknowledges one. */
  readonly superseded: readonly LedgerEntry[];
  /**
   * Changes that lost a fork a later change has since followed (the side an
   * acknowledge didn't pick, or the side that wasn't serving when an edit,
   * restore or delete followed both), whose version no later change made
   * current again: superseded for good.
   */
  readonly lost: readonly LedgerEntry[];
  readonly contested: readonly ContestedDecision[];
  /** Versions withheld by a `suspicious` contested decision. */
  readonly withheld: ReadonlySet<string>;
  /** This skill's records, every record after the ones it follows. */
  readonly records: readonly LedgerEntry[];
  /** The ids of every record nothing else followed: what a new record of this skill comes after. */
  readonly heads: readonly string[];
}

/** Every skill named in `entries`, by name. `servable` is the content check of one skill's version. */
export function deriveSkills(
  entries: readonly LedgerEntry[],
  servable: (skill: string, version: string) => boolean = () => true,
): Map<string, SkillState> {
  const bySkill = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    let list = bySkill.get(entry.skill);
    if (!list) bySkill.set(entry.skill, (list = []));
    list.push(entry);
  }
  const states = new Map<string, SkillState>();
  for (const name of [...bySkill.keys()].sort()) {
    states.set(name, deriveSkill(name, bySkill.get(name)!, (version) => servable(name, version)));
  }
  return states;
}

function deriveSkill(name: string, records: readonly LedgerEntry[], servable: (version: string) => boolean): SkillState {
  const byId = new Map(records.map((record) => [record.id, record]));
  const memo = new Map<string, ReadonlySet<string>>();
  /** Every record of this skill that `id` follows, directly or not. */
  const ancestors = (id: string): ReadonlySet<string> => {
    const known = memo.get(id);
    if (known) return known;
    const seen = new Set<string>();
    const stack = [...(byId.get(id)?.after ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next) || !byId.has(next)) continue;
      seen.add(next);
      const done = memo.get(next);
      if (done) for (const id of done) seen.add(id);
      else stack.push(...byId.get(next)!.after);
    }
    memo.set(id, seen);
    return seen;
  };
  const headsOf = (ids: ReadonlySet<string>): LedgerEntry[] =>
    [...ids].filter((id) => ![...ids].some((other) => other !== id && ancestors(other).has(id))).map((id) => byId.get(id)!);

  const changes = new Set(records.filter((record) => RANK.has(record.kind)).map((record) => record.id));
  const ranked = headsOf(changes).sort(precedence);
  const current = ranked[0] ?? null;
  const superseded = current ? ranked.slice(1).filter((head) => outcome(head) !== outcome(current)) : [];
  const status: SkillStatus = !current
    ? 'none'
    : current.kind === 'delete'
      ? 'deleted'
      : current.kind === 'eject'
        ? 'ejected'
        : current.to === null
          ? 'none'
          : 'active';

  const lost = lostSides(records, changes, ancestors, headsOf);
  const contested = contestedDecisions(records, ancestors);
  const withheld = new Set(contested.filter((c) => c.withheld).flatMap((c) => c.accepts.map((a) => a.to).filter((v): v is string => v !== null)));

  // Set aside each record that would serve a withheld or failing version, and decide again over the rest.
  let served: SkillState['served'] = null;
  const pool = new Set(changes);
  for (;;) {
    const top = headsOf(pool).sort(precedence)[0];
    if (!top || REMOVES.has(top.kind) || top.to === null) break;
    if (!withheld.has(top.to) && servable(top.to)) {
      served = { version: top.to, record: top };
      break;
    }
    pool.delete(top.id);
  }

  const blocked =
    current !== null &&
    REMOVES.has(current.kind) &&
    !records.some((record) => record.kind === 'unblock' && ancestors(record.id).has(current.id));

  const all = new Set(byId.keys());
  return {
    name,
    current,
    status,
    version: status === 'active' ? current!.to : null,
    served,
    blocked,
    superseded,
    lost,
    contested,
    withheld,
    records: [...records].sort((a, b) => ancestors(a.id).size - ancestors(b.id).size || byCode(a.id, b.id)),
    heads: headsOf(all).map((record) => record.id).sort(byCode),
  };
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What a change leaves: the skill removed, or one version. */
function outcome(record: LedgerEntry): string {
  return REMOVES.has(record.kind) ? 'removed' : `version:${record.to ?? ''}`;
}

/** Fork precedence: the higher rank, then (removals aside) the lower version hash, then the lower record id. */
function precedence(a: LedgerEntry, b: LedgerEntry): number {
  const rank = RANK.get(b.kind)! - RANK.get(a.kind)!;
  if (rank !== 0) return rank;
  if (!REMOVES.has(a.kind)) {
    if (a.to !== b.to) {
      if (a.to === null) return 1;
      if (b.to === null) return -1;
      return byCode(a.to, b.to);
    }
  }
  return byCode(a.id, b.id);
}

/**
 * The changes that lost a fork some later change followed: for each change
 * following two or more heads that disagree, every head whose outcome isn't
 * the one that stood (the version an acknowledge picked; otherwise the one
 * the fork rules served), unless a change following that one made its version
 * current again.
 */
function lostSides(
  records: readonly LedgerEntry[],
  changes: ReadonlySet<string>,
  ancestors: (id: string) => ReadonlySet<string>,
  headsOf: (ids: ReadonlySet<string>) => LedgerEntry[],
): LedgerEntry[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const memo = new Map<string, ReadonlySet<string>>();
  /** The nearest changes `id` follows, through records that change nothing: the heads it saw are among them. */
  const nearest = (id: string): ReadonlySet<string> => {
    const known = memo.get(id);
    if (known) return known;
    const found = new Set<string>();
    for (const parent of byId.get(id)?.after ?? []) {
      if (!byId.has(parent)) continue;
      if (changes.has(parent)) found.add(parent);
      else for (const change of nearest(parent)) found.add(change);
    }
    memo.set(id, found);
    return found;
  };
  const lost = new Map<string, LedgerEntry>();
  const ranked = records.filter((record) => changes.has(record.id));
  for (const resolver of ranked) {
    const heads = headsOf(nearest(resolver.id)).sort(precedence);
    if (heads.length < 2) continue;
    const stood = resolver.kind === 'acknowledge' ? outcome(resolver) : outcome(heads[0]!);
    for (const head of heads) {
      if (outcome(head) === stood || lost.has(head.id)) continue;
      const again = ranked.some((later) => !REMOVES.has(later.kind) && later.to === head.to && ancestors(later.id).has(resolver.id));
      if (!again) lost.set(head.id, head);
    }
  }
  return [...lost.values()].sort((a, b) => byCode(a.id, b.id));
}

/** Accepts and rejects of one proposal that no human change following them all has settled. */
function contestedDecisions(records: readonly LedgerEntry[], ancestors: (id: string) => ReadonlySet<string>): ContestedDecision[] {
  const byProposal = new Map<string, { accepts: LedgerEntry[]; rejects: LedgerEntry[] }>();
  for (const record of records) {
    if ((record.kind !== 'accept' && record.kind !== 'reject') || !record.proposal) continue;
    let decisions = byProposal.get(record.proposal);
    if (!decisions) byProposal.set(record.proposal, (decisions = { accepts: [], rejects: [] }));
    (record.kind === 'accept' ? decisions.accepts : decisions.rejects).push(record);
  }
  const settling = records.filter((record) => SETTLES.has(record.kind));
  const contested: ContestedDecision[] = [];
  for (const [proposal, { accepts, rejects }] of [...byProposal].sort(([a], [b]) => byCode(a, b))) {
    if (accepts.length === 0 || rejects.length === 0) continue;
    const decided = [...accepts, ...rejects];
    const settled = settling.some((change) => decided.every((decision) => ancestors(change.id).has(decision.id)));
    if (settled) continue;
    contested.push({ proposal, accepts, rejects, withheld: rejects.some((reject) => reject.reason === 'suspicious') });
  }
  return contested;
}
