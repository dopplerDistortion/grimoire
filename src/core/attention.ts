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
// The knowledge items (the pending proposal, forks, set-aside pairs, wiki
// conflicts, runner trouble) come with the Knowledge screens.
import { bareId, collisionSides, type TrackerView } from '../tracker';
import { listedOpenAttempt, type ListedOpenAttempt } from './attempts';
import { derivations, fieldConflict } from './derive';
import { inView } from './list';
import { define } from './op';
import { s } from './schema';
import { staleCutoff } from './stale';
import { skillStrays, type ShownStrayEdit } from './stray-edits';
import { syncFix, syncStatus, type SyncStatusResult } from './sync';

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
  | { kind: 'stray_edit'; stray: ShownStrayEdit };

export interface AttentionResult {
  /** What needs a person, most pressing first; empty when nothing does. */
  items: AttentionItem[];
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

export const attention = define({
  name: 'attention',
  description:
    'What needs a person: sync failures to fix, id collisions, field conflicts, two open attempts, stale claims and stray edits, each with what its action needs; plus the Ready, Claimed, Stale, Blocked and Conflicts counts. For people: the dashboard’s home.',
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
    // A stray-edit store or skill book that can't be read hides those items, never the rest of the queue.
    const strays = (await skillStrays.run({}, env).catch(() => ({ stray_edits: [] }))).stray_edits.map((stray): AttentionItem => ({ kind: 'stray_edit', stray }));
    return { items: [...syncItems(status), ...collisionItems(view), ...conflicts, ...doubles, ...stale, ...strays], counts };
  },
});
