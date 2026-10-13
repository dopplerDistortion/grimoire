// What a restore does to a skill's changes (spec §18 Restore; ADR 0005): the
// change it restores away from is `undone` (negative evidence), and the later
// versions it removes along the way are `dropped` (not negative evidence, and
// proposable again). Derived from the ledger alone, on read, like every
// status: for a restore a person is about to confirm, and for every restore
// the ledger records.
import type { LedgerEntry } from './ledger';

/** The changes that make a version current (or remove the skill): what a restore can undo or drop. */
const CHANGES: ReadonlySet<string> = new Set(['accept', 'edit', 'record', 'acknowledge', 'restore', 'delete', 'eject']);
const WRITES: ReadonlySet<string> = new Set(['accept', 'edit', 'record', 'acknowledge', 'restore']);

export interface RestoreSpan {
  /** The change restored away from: the one current when the restore was made. */
  readonly undone: LedgerEntry | null;
  /**
   * The changes after the last one that made the restored version current,
   * before the undone one: their versions go too. Newest last, one per version.
   */
  readonly dropped: readonly LedgerEntry[];
}

export type RestoreFate = 'undone' | 'dropped';

/** Every record of `records` that `id` follows, directly or not. */
function ancestry(records: readonly LedgerEntry[]): (id: string) => ReadonlySet<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const memo = new Map<string, ReadonlySet<string>>();
  const of = (id: string): ReadonlySet<string> => {
    const known = memo.get(id);
    if (known) return known;
    const seen = new Set<string>();
    for (const parent of byId.get(id)?.after ?? []) {
      if (!byId.has(parent)) continue;
      seen.add(parent);
      for (const above of of(parent)) seen.add(above);
    }
    memo.set(id, seen);
    return seen;
  };
  return of;
}

/**
 * What restoring `target` would undo and drop, with `from` the change
 * current now (null: none). `records` are the skill's, each after the ones it
 * follows (as SkillState.records holds them).
 */
export function restoreSpan(records: readonly LedgerEntry[], from: LedgerEntry | null, target: string): RestoreSpan {
  if (from === null) return { undone: null, dropped: [] };
  const ancestors = ancestry(records);
  const before = ancestors(from.id);
  const writes = records.filter((record) => before.has(record.id) && WRITES.has(record.kind));
  // The last change before `from` that made the restored version current.
  const anchor = writes.filter((record) => record.to === target).sort((a, b) => ancestors(a.id).size - ancestors(b.id).size).at(-1);
  if (!anchor) return { undone: from, dropped: [] };
  const byVersion = new Map<string, LedgerEntry>();
  for (const record of writes) {
    if (record.to === null || record.to === target || record.to === from.to || !ancestors(record.id).has(anchor.id)) continue;
    byVersion.delete(record.to);
    byVersion.set(record.to, record);
  }
  return { undone: from, dropped: [...byVersion.values()] };
}

/**
 * What the recorded restores did to each change of a skill: the change each
 * restored away from reads `undone`, those it removed along the way `dropped`
 * (a change undone by one restore and dropped by another reads `undone`).
 */
export function restoreFates(records: readonly LedgerEntry[]): Map<string, RestoreFate> {
  const fates = new Map<string, RestoreFate>();
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const restore of records.filter((record) => record.kind === 'restore' && record.to !== null)) {
    const from = madeCurrent(restore, byId);
    const span = restoreSpan(records, from, restore.to!);
    if (span.undone) fates.set(span.undone.id, 'undone');
    for (const dropped of span.dropped) if (!fates.has(dropped.id)) fates.set(dropped.id, 'dropped');
  }
  return fates;
}

/**
 * The change a restore restored away from: among the nearest changes it
 * follows, the one that left what it records as `from` (a version, or the
 * skill removed).
 */
function madeCurrent(restore: LedgerEntry, byId: ReadonlyMap<string, LedgerEntry>): LedgerEntry | null {
  const nearest: LedgerEntry[] = [];
  const seen = new Set<string>();
  const stack = [...restore.after];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const record = byId.get(id);
    if (!record || seen.has(id)) continue;
    seen.add(id);
    if (CHANGES.has(record.kind)) nearest.push(record);
    else stack.push(...record.after);
  }
  const removed = (record: LedgerEntry) => record.kind === 'delete' || record.kind === 'eject';
  return nearest.find((record) => (restore.from === null ? removed(record) : !removed(record) && record.to === restore.from)) ?? null;
}
