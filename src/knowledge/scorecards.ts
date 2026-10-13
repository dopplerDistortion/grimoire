// Watch-only scorecards (spec §18; §14 Facts): per skill version, derived on
// read from the sealed traces and never committed. They change no state; they
// are for humans to watch, and feed the Skill Proposer's digest.
//
// A trace counts for a version when its checkout offered that version or one
// of its bound contexts read it. Only agent workers count; a person's attempt
// is never scored. Delivery-off attempts (the switch off at the opening) and
// wiki-exposed ones are shown apart from the rest. A trace whose facts are
// incomplete (some bound context not `scanned`) and that shows no read of an
// offered version reads as "read unknown", never "not read".
import type { OfferedSkill } from '../tracker';
import type { LedgerEntry } from './ledger';

/** What scorecards need of one sealed trace. */
export interface TraceFacts {
  /** `agent` or `human` (`end.md`'s worker kind). */
  readonly workerKind: string;
  /** The delivery switch at the opening; null when `start.md` doesn't say. */
  readonly delivery: 'on' | 'off' | null;
  /** `end.md`'s OR of every binding write's wiki exposure. */
  readonly wikiExposed: boolean;
  /** What the opening checkout offered; null when nothing is known of it. */
  readonly offered: readonly OfferedSkill[] | null;
  /** Every read its bound contexts' session records hold. */
  readonly reads: readonly { readonly name: string; readonly version: string | null }[];
  /** Every bound context's facts `scanned`. */
  readonly factsComplete: boolean;
  /** The current outcome. */
  readonly outcome: { readonly verdict: string; readonly reason: string } | null;
  /** The trace's id (its attempt handle) and when it ended: what recurrence counts. */
  readonly attempt: string;
  readonly endedAt: string;
}

/** One group of traces of a version. */
export interface ScorecardCounts {
  /** Traces whose checkout offered the version. */
  offered: number;
  /** Traces that read it. */
  read: number;
  /** Traces offered it with incomplete facts and no read of it found. */
  read_unknown: number;
  /** The current outcomes of the traces that read it. */
  pass: number;
  fail: number;
  none: number;
  /** Readers whose close a later reopen flipped to `fail`. */
  reopens: number;
}

/** An attention flag (spec §18): it changes no state. */
export type AttentionFlag = 'read_fails' | 'pattern_recurs';

export interface Scorecard extends ScorecardCounts {
  version: string;
  /** The version current before this one; null for the first. */
  previous: string | null;
  /** How many traces the outcome counts cover: the agent readers outside the separate groups. */
  n: number;
  /** n below 20. */
  small_sample: boolean;
  /** New fails on the targeted pattern since acceptance; null when no pattern is known for the version. */
  recurrence: number | null;
  wiki_exposed: ScorecardCounts;
  delivery_off: ScorecardCounts;
  attention: AttentionFlag[];
}

/** Below this n, a scorecard is labelled a small sample (spec §18). */
export const SMALL_SAMPLE = 20;
/** Read this many times or more, with more fails than passes, raises the attention flag. */
const ATTENTION_READS = 3;
/** New fails on the targeted pattern since acceptance that raise the attention flag. */
const ATTENTION_RECURRENCES = 2;

/** The traces a version's targeted pattern pages cite, for recurrence. */
export interface TargetedPattern {
  /** The attempt handles the pattern pages' `sources` name, set-aside conflict sides included. */
  readonly sources: ReadonlySet<string>;
}

export interface ScorecardOptions {
  /** The pattern a version's proposal targeted, when one is known: recurrence is counted against it. */
  readonly patternOf?: (version: string) => TargetedPattern | null;
}

const empty = (): ScorecardCounts => ({ offered: 0, read: 0, read_unknown: 0, pass: 0, fail: 0, none: 0, reopens: 0 });

/**
 * The scorecards of one skill: one per version its ledger `records` make
 * current, newest first, each with the version before it.
 */
export function deriveScorecards(
  skill: string,
  records: readonly LedgerEntry[],
  traces: readonly TraceFacts[],
  options: ScorecardOptions = {},
): Scorecard[] {
  // Each version once, at the record that first made it current: its acceptance.
  const made = new Map<string, LedgerEntry>();
  for (const record of records) if (record.to !== null && !made.has(record.to)) made.set(record.to, record);
  const agents = traces.filter((trace) => trace.workerKind === 'agent');
  return [...made.values()].reverse().map((record) => {
    const version = record.to!;
    const groups = { main: empty(), wiki_exposed: empty(), delivery_off: empty() };
    for (const trace of agents) {
      const offered = trace.offered?.some((item) => item.name === skill && item.version === version) ?? false;
      const read = trace.reads.some((item) => item.name === skill && item.version === version);
      if (!offered && !read) continue;
      const group = trace.delivery === 'off' ? groups.delivery_off : trace.wikiExposed ? groups.wiki_exposed : groups.main;
      if (offered) group.offered++;
      if (read) {
        group.read++;
        const verdict = trace.outcome?.verdict;
        if (verdict === 'pass' || verdict === 'fail' || verdict === 'none') group[verdict]++;
        if (verdict === 'fail' && trace.outcome?.reason === 'reopened') group.reopens++;
      } else if (offered && !trace.factsComplete) group.read_unknown++;
    }
    const pattern = options.patternOf?.(version) ?? null;
    const accepted = Date.parse(record.at);
    const recurrence =
      pattern === null
        ? null
        : agents.filter((trace) => trace.outcome?.verdict === 'fail' && pattern.sources.has(trace.attempt) && Date.parse(trace.endedAt) > accepted).length;
    const { main } = groups;
    const attention: AttentionFlag[] = [];
    if (main.read >= ATTENTION_READS && main.fail > main.pass) attention.push('read_fails');
    if (recurrence !== null && recurrence >= ATTENTION_RECURRENCES) attention.push('pattern_recurs');
    return {
      version,
      previous: record.from,
      ...main,
      n: main.read,
      small_sample: main.read < SMALL_SAMPLE,
      recurrence,
      wiki_exposed: groups.wiki_exposed,
      delivery_off: groups.delivery_off,
      attention,
    };
  });
}
