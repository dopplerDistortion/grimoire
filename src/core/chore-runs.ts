// `chore_runs` (spec §20 Knowledge, Chore runs; §16 Chore-run records, Failures
// and replays): every chore run this clone can see, newest first. Ended runs
// come from their committed chore-run records (every clone sees them); runs
// that are open, expired or abandoned stay on the machine that ran them, so
// only it lists them. Each row says kind, origin · isolation, the outcome with
// its reason codes, the pages or proposal it touched, and when.
//
// "Invalid result text kept on this machine" is viewable only where it is
// held: a refused result's text lives in this machine's records (never
// committed), and after a secret-scan failure only its reason codes and rule
// ids were kept, so there is never text to show.
import { INVALID_RESULTS, listRuns, live, type InvalidResult } from '../knowledge/chores';
import { MachineLocalStore } from '../machine-local';
import type { ChoreRunRecord, TrackerView } from '../tracker';
import { define, oneLine } from './op';
import { s } from './schema';

/** A refused result this machine keeps for a run. */
export interface KeptResult {
  /** Which refusal of the run it was: 1, then 2 at most (one fix-up). */
  n: number;
  at: string;
  reasons: string[];
  /** The secret-scan rules it matched: then no text was kept. */
  rules: string[];
  /** The result text is held here (never after a secret-scan failure). */
  text_kept: boolean;
  /** With `run`: the text and the problems found, when held. */
  text?: string | null;
  problems?: Record<string, string>;
}

export type ChoreRunOutcome = 'compiled' | 'proposed' | 'no_action' | 'failed' | 'open' | 'expired' | 'abandoned';

/** One chore run as the dashboard lists it. */
export interface ChoreRunRow {
  id: string;
  kind: string;
  origin: string;
  isolation: string;
  outcome: ChoreRunOutcome | string;
  /** Failed runs: the reason codes. */
  reasons: string[];
  /** Compiled runs: the pages written, by slug. */
  pages: string[];
  /** Proposed runs: the proposal. */
  proposal: string | null;
  /** Compiled runs: how many pairs it consumed; proposer runs: how many compiles. */
  consumed: number;
  started_at: string;
  /** When it ended (or, for an open run, its last chore call). */
  at: string;
  /** The person it ran for. */
  by: string | null;
  /** The client and model the run reported for itself: never verified. */
  unverified: { client: string | null; model: string | null };
  /** `tracker` (a committed record) or `this machine` (open, expired or abandoned: never committed). */
  where: 'tracker' | 'this machine';
  /** Refused results this machine keeps for it. */
  kept: KeptResult[];
}

export interface ChoreRunsResult {
  runs: ChoreRunRow[];
  /** How many runs there are in all (the list may be cut at `limit`). */
  total: number;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function trackerRow(record: ChoreRunRecord): Omit<ChoreRunRow, 'kept'> {
  return {
    id: record.id,
    kind: record.kind,
    origin: record.origin,
    isolation: record.isolation,
    outcome: record.result,
    reasons: [...record.reasons],
    pages: Object.keys(record.pages).sort(),
    proposal: record.proposal,
    consumed: record.kind === 'wiki-maintainer' ? record.consumption.length : record.consumed.length,
    started_at: record.started_at,
    at: record.at,
    by: str(record.actor.person),
    unverified: { ...record.unverified },
    where: 'tracker',
  };
}

/** Every refused result this machine keeps, by run. */
async function keptResults(store: MachineLocalStore, withText: (run: string) => boolean): Promise<Map<string, KeptResult[]>> {
  const kept = new Map<string, KeptResult[]>();
  const entries = await store.records.list<InvalidResult>(INVALID_RESULTS).catch(() => []);
  for (const { key, value } of entries) {
    const slash = key.lastIndexOf('/');
    const run = slash > 0 ? key.slice(0, slash) : (value.run ?? key);
    const n = Number(key.slice(slash + 1)) || 1;
    const text = typeof value.text === 'string' ? value.text : null;
    const row: KeptResult = { n, at: value.at, reasons: [...(value.reasons ?? [])], rules: [...(value.rules ?? [])], text_kept: text !== null };
    if (withText(run)) {
      row.text = text;
      if (value.problems) row.problems = { ...value.problems };
    }
    kept.set(run, [...(kept.get(run) ?? []), row].sort((x, y) => x.n - y.n));
  }
  return kept;
}

/**
 * The chore runs of `view` plus this machine's runs that never reached the
 * tracker, newest first. `run` names one run whose kept result text is
 * included.
 */
export async function choreRunRows(view: TrackerView, store: MachineLocalStore, now: Date, run?: string): Promise<ChoreRunRow[]> {
  const records = await view.choreRuns.records();
  const committed = new Set(records.map((record) => record.id));
  const kept = await keptResults(store, (id) => id === run);
  const rows: Omit<ChoreRunRow, 'kept'>[] = records.map(trackerRow);
  for (const open of await listRuns(store).catch(() => [])) {
    // An ended run whose record isn't here yet (it is on its way, or its commit was lost) shows once it lands.
    if (committed.has(open.id) || open.state === 'ended') continue;
    rows.push({
      id: open.id,
      kind: open.kind,
      origin: open.origin,
      isolation: open.isolation,
      outcome: open.state === 'abandoned' ? 'abandoned' : live(open, now) ? 'open' : 'expired',
      reasons: [],
      pages: [],
      proposal: null,
      consumed: 0,
      started_at: open.started_at,
      at: open.ended_at ?? open.last_call_at,
      by: open.person,
      unverified: { client: null, model: null },
      where: 'this machine',
    });
  }
  rows.sort((x, y) => (x.at > y.at ? -1 : x.at < y.at ? 1 : x.id > y.id ? -1 : x.id < y.id ? 1 : 0));
  return rows.map((row) => ({ ...row, kept: kept.get(row.id) ?? [] }));
}

export const choreRuns = define({
  name: 'chore_runs',
  description:
    'List the knowledge chore runs, newest first: kind, origin and isolation, the outcome with its reason codes, the pages or proposal touched, and when; open, expired and abandoned runs only on the machine that ran them. With `run`, a refused result’s text kept on this machine (never after a secret-scan failure). Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({
    limit: s.optional(s.integer({ min: 1, max: 500, description: 'list at most this many (default 100)' })),
    run: s.optional(s.string({ ...oneLine, description: 'a run id: include the result text this machine keeps for it' })),
  }),
  async run(input, { tracker }): Promise<ChoreRunsResult> {
    const view = await tracker.read();
    const store = new MachineLocalStore(tracker.location.commonDir);
    const rows = await choreRunRows(view, store, tracker.now(), input.run);
    const wanted = input.run === undefined ? rows : rows.filter((row) => row.id === input.run);
    return { runs: wanted.slice(0, input.limit ?? 100), total: wanted.length };
  },
});
