// Purge (spec §3 Delete and purge, §14 Purging one session record, §7): a
// person's deliberate removal of sensitive trace material, as far as git
// allows. Purging a trace removes the attempt's directory and outcome in one
// commit and leaves `purges/<attempt>.md` {by, at, reason}; purging one open
// attempt's session record leaves `purges/<attempt>/<session-key>.md`, keeping
// the record's facts unless the person chose to purge them too. A tombstone
// dominates every fold and every write path. The unpushed segment is rewritten
// without the content and its reflog entries expire; pushed history is never
// rewritten, and every purge says so. Both ops are human-only.
import { GrimoireError, invalid } from '../errors';
import { parseSessionRecord, serializeSessionRecord } from '../capture/session-record';
import { type PurgedFacts, type PurgeTombstone, type TrackerView, type UnpushedDrop } from '../tracker';
import { parseHandle } from './attempts';
import { define, oneLine, writer } from './op';
import { citingProposals } from './proposals';
import { s } from './schema';

/** What a purge did to history: the unpushed segment rewritten, pushed history kept. */
export interface PurgeHistory {
  /** How many unpushed tracker commits were written again without the content (their reflog entries expired). */
  unpushed_rewritten: number;
  /** Whether pushed history holds the content: it keeps it, since grimoire never rewrites pushed history. */
  pushed: boolean;
  /** What happened to history, in words. */
  note: string;
}

/** A wiki page that cites a purged trace: the page stays as written, and a person may edit it. */
export interface CitingPage {
  slug: string;
  /** The human wiki edit the purge offers. */
  edit: string;
}

export interface PurgeTraceResult {
  attempt: string;
  /** The attempt's issue; null for a trace purged earlier, whose issue the tombstone doesn't say. */
  issue: string | null;
  purged: true;
  /** False when the trace was purged already: only what was left of it went. */
  changed: boolean;
  by: string;
  at: string;
  reason: string;
  /** What cites the trace: wiki pages (their sources show it purged) and skill proposals. */
  cited_by: { pages: CitingPage[]; proposals: string[] };
  history: PurgeHistory;
}

export interface PurgeSessionResult {
  attempt: string;
  issue: string;
  key: string;
  purged: true;
  /** `kept`: the excerpt alone went, the facts stay on the tombstone; `purged`: the facts went with it. */
  facts: PurgedFacts;
  changed: boolean;
  by: string;
  at: string;
  reason: string;
  history: PurgeHistory;
}

/** The words every purge says about history (spec §3: pushed history is never rewritten). */
function historyNote({ pushed, rewritten, reflogExpired }: UnpushedDrop): string {
  const reflog = reflogExpired
    ? 'and their reflog entries expired.'
    : 'but their reflog entries could not be expired, so the old commits may stay reachable through the tracker reflog until it expires them.';
  const unpushed =
    rewritten > 0 ? `${rewritten} unpushed tracker commit${rewritten === 1 ? ' was' : 's were'} rewritten without it, ${reflog}` : 'No unpushed tracker commit held it.';
  const kept = pushed
    ? 'Pushed history still holds it: grimoire never rewrites pushed history or runs gc, so the remote and every clone that fetched it keep it.'
    : 'It was never pushed; grimoire never rewrites pushed history or runs gc.';
  return `${unpushed} ${kept}`;
}

/** What the purge's write did to history (the store drops the content from the unpushed segment in the same compare-and-set). */
function historyOf(drop: UnpushedDrop | undefined): PurgeHistory {
  const done = drop ?? { rewritten: 0, reflogExpired: true, pushed: false };
  return { unpushed_rewritten: done.rewritten, pushed: done.pushed, note: historyNote(done) };
}

/** The wiki pages whose sources cite the trace `handle`. */
async function citingPages(view: TrackerView, handle: string): Promise<CitingPage[]> {
  const pages = await view.wiki.pages();
  return pages.filter((page) => page.sources.includes(handle)).map((page) => ({ slug: page.slug, edit: `grimoire wiki edit ${page.slug}` }));
}

const attemptInput = s.string({ ...oneLine, description: 'the attempt handle (at-…)' });
const reasonInput = s.string({ nonBlank: true, description: 'why it is purged (required)' });

const tombstoneFields = (tombstone: PurgeTombstone) => ({ by: tombstone.by, at: tombstone.at, reason: tombstone.reason });

export const purgeTrace = define({
  name: 'purge_trace',
  description:
    'Purge an ended attempt’s trace, with a reason: its directory and outcome go in one commit, a tombstone {by, at, reason} stays, and no fold or write brings it back. Unpushed commits are rewritten without it; pushed history keeps it. Lists the wiki pages and proposals that cite it. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ attempt: attemptInput, reason: reasonInput }),
  async run(input, { ctx, tracker, actor }): Promise<PurgeTraceResult> {
    const author = writer(ctx);
    const handle = parseHandle(input.attempt);
    const reason = input.reason.trim();
    const write = await tracker.transact<Omit<PurgeTraceResult, 'cited_by' | 'history'>>({ op: 'purge', author, actor }, (draft) => {
      const record = draft.attempt(handle);
      const stored = draft.tracePurge(handle);
      if (!record && !stored) throw new GrimoireError('NOT_FOUND', `there is no trace ${handle}`, { field: 'attempt', ref: handle });
      if (record && !record.end) {
        throw new GrimoireError('ATTEMPT_OPEN', `${handle} is still open: a trace exists once its attempt ends; purge one of its session records instead, or end it first`, {
          attempt: handle,
        });
      }
      draft.purgeTrace(handle, { by: author.email, reason });
      const tombstone = draft.tracePurge(handle)!;
      const result = { attempt: handle, issue: record?.issue ?? null, purged: true as const, changed: !stored, ...tombstoneFields(tombstone) };
      return record ? { result, issue: record.issue } : { result };
    });
    const history = historyOf(write.history);
    const view = await tracker.read();
    return { ...write.result, cited_by: { pages: await citingPages(view, handle), proposals: await citingProposals(view, handle) }, history };
  },
});

export const purgeSession = define({
  name: 'purge_session',
  description:
    'Purge one session record of an open attempt, with a reason: the excerpt alone (its facts stay), or with with_facts the excerpt and its facts. A tombstone keyed by attempt and session key stays, later cuts skip that context, and its status reads purged. Unpushed commits are rewritten without it; pushed history keeps it. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    attempt: attemptInput,
    key: s.string({ ...oneLine, description: 'the session record’s key (hex)' }),
    reason: reasonInput,
    with_facts: s.optional(s.boolean('true: purge its facts too (default: the excerpt alone; the facts stay)')),
  }),
  async run(input, { ctx, tracker, actor }): Promise<PurgeSessionResult> {
    const author = writer(ctx);
    const handle = parseHandle(input.attempt);
    const key = input.key.trim().toLowerCase();
    if (!/^[0-9a-f]{16,64}$/.test(key)) throw invalid({ key: `"${input.key}" is not a session key (hex)` });
    const reason = input.reason.trim();
    const facts: PurgedFacts = input.with_facts === true ? 'purged' : 'kept';
    const write = await tracker.transact<Omit<PurgeSessionResult, 'history'>>({ op: 'purge', author, actor }, async (draft) => {
      const record = draft.attempt(handle);
      if (!record) {
        const why = draft.tracePurge(handle) ? `the trace ${handle} was purged` : `there is no attempt ${handle}`;
        throw new GrimoireError('NOT_FOUND', why, { field: 'attempt', ref: handle });
      }
      if (record.end) throw invalid({ attempt: `${handle} has ended; its session records are part of its trace, so purge the trace instead` });
      const stored = draft.sessionPurge(handle, key);
      const bytes = await draft.sessionRecord(handle, key);
      if (!bytes && !stored) throw new GrimoireError('NOT_FOUND', `${handle} has no session record ${key}`, { field: 'key', ref: key });
      // The excerpt alone: the facts stay, on the tombstone, as the record stood without its text.
      const kept = facts === 'kept' && bytes ? serializeSessionRecord({ ...parseSessionRecord(bytes), text: null, excerpt: 'purged', excerpt_notes: [], steps_kept: 0, characters: 0 }) : null;
      draft.purgeSession(handle, key, { by: author.email, reason, facts, kept });
      const tombstone = draft.sessionPurge(handle, key)!;
      // Purged with the excerpt alone before, and now with its facts: the stronger purge writes it again.
      const stronger = stored?.facts === 'kept' && facts === 'purged';
      return {
        result: {
          attempt: handle,
          issue: record.issue,
          key,
          purged: true as const,
          facts: tombstone.facts ?? 'purged',
          changed: !stored || stronger,
          ...tombstoneFields(tombstone),
        },
        issue: record.issue,
      };
    });
    return { ...write.result, history: historyOf(write.history) };
  },
});

/** One purge as the dashboard's Settings lists it. */
export interface PurgedRecord {
  kind: 'trace' | 'session' | 'proposal';
  /** The attempt handle (a trace or one of its session records) or the proposal id. */
  id: string;
  /** A session record's key. */
  key?: string;
  /** A session record's: whether its facts were kept. */
  facts?: PurgedFacts;
  by: string;
  at: string;
  reason: string;
}

export interface PurgeListResult {
  /** Newest first. */
  purged: PurgedRecord[];
  /** The history caveat. */
  note: string;
}

const KEPT_NOTE =
  'Pushed git history keeps purged content: grimoire never rewrites pushed history, so the remote and every clone that fetched it keep it until someone rewrites that history.';

export const purgeList = define({
  name: 'purge_list',
  description: 'List the purged traces, session records and proposals: who purged each, when and why. Pushed history keeps their content. For people: the dashboard’s Settings.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({}),
  async run(_input, { tracker }): Promise<PurgeListResult> {
    const index = (await tracker.read()).purgeIndex();
    const purged: PurgedRecord[] = [];
    for (const [id, tombstone] of index.traces) purged.push({ kind: 'trace', id, ...tombstoneFields(tombstone) });
    for (const [id, keys] of index.sessions) {
      for (const [key, tombstone] of keys) purged.push({ kind: 'session', id, key, facts: tombstone.facts ?? 'purged', ...tombstoneFields(tombstone) });
    }
    for (const [id, tombstone] of index.proposals) purged.push({ kind: 'proposal', id, ...tombstoneFields(tombstone) });
    const order = (r: PurgedRecord) => `${r.kind}\0${r.id}\0${r.key ?? ''}`;
    purged.sort((x, y) => (x.at === y.at ? (order(x) < order(y) ? -1 : 1) : x.at < y.at ? 1 : -1));
    return { purged, note: KEPT_NOTE };
  },
});
