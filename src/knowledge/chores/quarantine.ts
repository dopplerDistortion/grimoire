// What quarantine keeps out (spec §17 Never rolled back, and quarantine; §18):
// a human's mark on a pattern page or a trace keeps it out of chores and out of
// a skill proposal's evidence, until a clear lifts it. Whether a target is
// quarantined is derived from the ledger's marks and clears, never stored.
//
// Quarantining a trace also flags (shown, never filtered) the other pages the
// compiles that consumed it wrote, derived from the chore-run records.
import type { QuarantineRecord, QuarantineView, TrackerView } from '../../tracker';

export interface ActiveQuarantine {
  /** Quarantined pages, by slug, each with the marks in force, oldest first. */
  readonly pages: ReadonlyMap<string, readonly QuarantineRecord[]>;
  /** Quarantined traces, by attempt handle, each with the marks in force, oldest first. */
  readonly traces: ReadonlyMap<string, readonly QuarantineRecord[]>;
}

/** The marks in force: those no clear lifts, oldest first. */
function activeMarks(records: readonly QuarantineRecord[]): QuarantineRecord[] {
  const cleared = new Set(records.flatMap((record) => (record.kind === 'quarantine-clear' ? record.clears : [])));
  return records.filter((record) => record.kind === 'quarantine-mark' && !cleared.has(record.id));
}

/** Every quarantined page and trace of `view`. */
export async function activeQuarantine(view: { quarantine: QuarantineView }): Promise<ActiveQuarantine> {
  const pages = new Map<string, QuarantineRecord[]>();
  const traces = new Map<string, QuarantineRecord[]>();
  const push = (map: Map<string, QuarantineRecord[]>, key: string, mark: QuarantineRecord) => {
    let marks = map.get(key);
    if (!marks) map.set(key, (marks = []));
    marks.push(mark);
  };
  for (const mark of activeMarks(await view.quarantine.records())) {
    if (mark.target.page !== undefined) push(pages, mark.target.page, mark);
    else if (mark.target.trace !== undefined) push(traces, mark.target.trace, mark);
  }
  return { pages, traces };
}

/**
 * The pages a quarantined trace flags (spec §17): every page a compile that
 * consumed the trace wrote, other than a page itself quarantined, by slug,
 * each with the quarantined traces that flag it (sorted).
 */
export async function flaggedPages(view: Pick<TrackerView, 'quarantine' | 'choreRuns'>): Promise<Map<string, string[]>> {
  const { pages, traces } = await activeQuarantine(view);
  const flags = new Map<string, Set<string>>();
  if (traces.size === 0) return new Map();
  for (const run of await view.choreRuns.records()) {
    if (run.kind !== 'wiki-maintainer' || run.result !== 'compiled') continue;
    const consumed = run.consumption.map((pair) => pair.trace).filter((trace) => traces.has(trace));
    if (consumed.length === 0) continue;
    for (const slug of Object.keys(run.pages)) {
      if (pages.has(slug)) continue;
      let set = flags.get(slug);
      if (!set) flags.set(slug, (set = new Set()));
      for (const trace of consumed) set.add(trace);
    }
  }
  return new Map([...flags].map(([slug, set]) => [slug, [...set].sort()]));
}
