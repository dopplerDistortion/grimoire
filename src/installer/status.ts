// `status` (spec §12): what a person or an agent should know about this
// checkout now, read-only: it writes nothing anywhere (no tracker ref, no
// machine-local record, not even git's index). Its facts mirror Attention and
// the Knowledge overview. Each fact is one entry of STATUS_FACTS, so later
// slices add theirs (the pending proposal, what is due, the runner, stray
// edits) the same way.
import { KIND_NAMES, knowledgeFacts } from '../core/chores';
import { derivations } from '../core/derive';
import { showStrayEdits } from '../core/stray-edits';
import { listStrayEdits, sharedScanner } from '../generated';
import { readSkills } from '../knowledge';
import { readSyncStatus, autoSyncOn, type SyncStatusResult } from '../core/sync';
import { storeExcerptMode } from '../core/settings';
import { DEFAULT_STALE_AFTER_MS, staleCutoff } from '../core/stale';
import { GrimoireError } from '../errors';
import { findGitDirs, MachineLocalStore, type GitDirs, type Json } from '../machine-local';
import { openTracker, type TrackerStore, type TrackerView } from '../tracker';
import { refreshedPointerFiles, refreshNotice } from '../upkeep';
import { VERSION } from '../version';
import { nodeMajor, pathSourceOf, readClientRuntimes } from './client-runtime';
import { codexHookState } from './codex-trust';
import { readInstallConfig, type CheckoutInstall } from './config';
import { messageOf } from './health';
import { readManifest } from './manifest';
import { readJoinRecord } from './records';

/** What every fact is handed. The merged view is read once, on first use. */
export interface StatusInput {
  readonly root: string;
  readonly dirs: GitDirs;
  readonly store: MachineLocalStore;
  readonly version: string;
  readonly config: CheckoutInstall | null;
  readonly env: NodeJS.ProcessEnv;
  readonly now: Date;
  /** The merged view; throws when it can't be read (NOT_SYNCED, an unparsable record). */
  readonly view: () => Promise<TrackerView>;
}

/** One fact of `status`: its value under `key` in the JSON object, and the lines a person reads. */
export interface StatusFact {
  readonly key: string;
  read(input: StatusInput): Promise<{ readonly value: Json; readonly lines: readonly string[] }>;
}

export interface StatusOptions {
  readonly root: string;
  readonly version?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly facts?: readonly StatusFact[];
}

export interface StatusReport {
  readonly version: string;
  readonly root: string;
  readonly pin: string | null;
  /** Each fact's value, by its key. */
  readonly [fact: string]: Json;
}

/** A fact the view was needed for and couldn't be read. */
function unreadable(error: unknown): Json {
  return { error: error instanceof GrimoireError ? { code: error.code, message: error.message } : { code: 'INTERNAL', message: messageOf(error) } };
}

const syncFact: StatusFact = {
  key: 'sync',
  async read({ dirs, view }) {
    let auto: boolean | null = null;
    try {
      auto = autoSyncOn(await view());
    } catch {
      auto = null;
    }
    const status: SyncStatusResult = await readSyncStatus(dirs.commonDir, auto);
    const lines = [`Sync: ${status.summary}`];
    if (status.failure) lines.push(`  ${status.failure.class} (${status.failure.at}, ${status.failure.client} ${status.failure.surface}): ${status.failure.message}`);
    return { value: { ...status }, lines };
  },
};

const refreshedFact: StatusFact = {
  key: 'refreshed_pointer_files',
  async read({ store, root }) {
    const refreshed = await refreshedPointerFiles(store, root).catch(() => null);
    if (!refreshed) return { value: null, lines: [] };
    return {
      value: { paths: refreshed.paths, at: new Date(refreshed.at).toISOString(), notice: refreshNotice(refreshed.paths.length, null) },
      lines: [`${refreshNotice(refreshed.paths.length, null)}: ${refreshed.paths.join(', ')}`],
    };
  },
};

const nodeFact: StatusFact = {
  key: 'node',
  async read({ store }) {
    const live = await store.processes.live().catch(() => []);
    const clients = (await readClientRuntimes(store).catch(() => [])).map((runtime) => ({
      client: runtime.client,
      node: runtime.node,
      path_source: runtime.path_source,
      pin: runtime.pin,
      at: new Date(runtime.at).toISOString(),
      live: live.some((record) => record.client === runtime.client),
      supported: nodeMajor(runtime.node) >= 22,
    }));
    const value = { this_process: { node: process.version, path_source: pathSourceOf() }, clients };
    const lines = clients.map(
      (client) => `Node: ${client.client} ran grimoire on ${client.node} from ${client.path_source}${client.supported ? '' : ' (grimoire needs Node 22 or newer)'}`,
    );
    return { value, lines };
  },
};

const staleFact: StatusFact = {
  key: 'stale_claims',
  async read({ dirs, store, view, now }) {
    const setting = await store.records.read('machine-settings', 'dashboard.stale_after').catch(() => undefined);
    const staleAfter = typeof setting === 'string' || typeof setting === 'number' ? setting : `${DEFAULT_STALE_AFTER_MS / 3_600_000}h`;
    let tracker: TrackerView;
    try {
      tracker = await view();
    } catch (error) {
      const value: Json = { stale_after: staleAfter, error: (unreadable(error) as { error: Json }).error };
      return { value, lines: [] };
    }
    const cutoff = await staleCutoff(dirs.commonDir, now);
    const derived = derivations(tracker, cutoff);
    const claims = tracker.issues().flatMap((issue) =>
      derived
        .of(issue.id)
        .openAttempts.filter((attempt) => Date.parse(attempt.lastActivityAt) < cutoff)
        .map((attempt) => ({ issue: issue.id, title: issue.title, attempt: attempt.record.id, assignee: attempt.assignee, since: attempt.since, last_activity_at: attempt.lastActivityAt })),
    );
    const lines = claims.map((claim) => `Stale claim: ${claim.issue} “${claim.title}” held by ${claim.assignee} (${claim.attempt}), no activity since ${claim.last_activity_at}`);
    return { value: { stale_after: staleAfter, claims }, lines };
  },
};

const excerptFact: StatusFact = {
  key: 'excerpt_mode',
  async read({ store, config, view }) {
    const join = config?.version ? await readJoinRecord(store, config.version).catch(() => undefined) : undefined;
    const joined = join?.excerpt_mode && join.excerpt_mode !== 'unknown' ? join.excerpt_mode : null;
    let mode: string | null = null;
    let error: Json = null;
    try {
      mode = storeExcerptMode(await view());
    } catch (cause) {
      error = (unreadable(cause) as { error: Json }).error;
    }
    const changed = mode !== null && joined !== null && mode !== joined;
    return {
      value: { store: mode, joined, changed, ...(error !== null ? { error } : {}) },
      lines: changed ? [`The excerpt mode changed since this machine joined: it was ${joined}, it is ${mode} now (see the disclosure: grimoire init)`] : [],
    };
  },
};

const codexFact: StatusFact = {
  key: 'codex_hook',
  async read({ root, dirs, env, store, config }) {
    const { entries } = await readManifest(root);
    if (!config?.version || !entries.some((entry) => entry.client === 'codex')) return { value: null, lines: [] };
    const join = await readJoinRecord(store, config.version).catch(() => undefined);
    const state = await codexHookState(root, dirs, env, join?.codex_hook_hash ?? null);
    return { value: { ...state }, lines: [`Codex hook: ${state.summary}`] };
  },
};

/**
 * Stray edits (spec §15): "stray edit to <skill> in <worktree>: Record or
 * Discard", each with the agent attempts open on this machine when it
 * appeared. Their text stays out of status (`skill strays` shows it).
 */
const strayFact: StatusFact = {
  key: 'stray_edits',
  async read({ store, root, view }) {
    const edits = await listStrayEdits(store);
    if (edits.length === 0) return { value: [], lines: [] };
    let tracker: TrackerView | null = null;
    let currentOf = (_skill: string): string | null => null;
    try {
      tracker = await view();
      const book = await readSkills(tracker, sharedScanner());
      currentOf = (skill) => book.skills.get(skill)?.version ?? null;
    } catch {
      // Without the tracker: no open attempts or current versions, but the edits still show.
    }
    const shown = await showStrayEdits(edits, tracker, currentOf, root);
    return {
      value: shown.map(({ text: _text, ...edit }) => ({ ...edit })),
      lines: shown.map((edit) => `${edit.notice} (${edit.id}${edit.open_attempts.length > 0 ? `; agent attempts open then: ${edit.open_attempts.join(', ')}` : ''})`),
    };
  },
};

/**
 * The knowledge facts (spec §12, mirroring the Knowledge overview): what is
 * due or why not, the loop's paused state, the pending proposals and their
 * age, set-aside pairs, and the active skills with their attention flags.
 * Never a proposal's text or claims, nor any wiki text.
 */
const knowledgeFact: StatusFact = {
  key: 'knowledge',
  async read({ store, view, now }) {
    const facts = await knowledgeFacts(await view(), store, now, sharedScanner());
    const lines: string[] = [];
    const { 'wiki-maintainer': wiki, 'skill-proposer': proposer } = facts.chores;
    if (facts.next !== null) lines.push(`Chores: the ${KIND_NAMES[facts.next]} is due (${facts.chores[facts.next].why})`);
    else if (facts.loop === 'paused') lines.push('Chores: none due: the knowledge loop is paused');
    else lines.push(`Chores: none due (Wiki Maintainer: ${wiki.why}; Skill Proposer: ${proposer.why})`);
    for (const proposal of facts.pending_proposals) {
      const flags = proposal.flags.length > 0 ? `; flags: ${proposal.flags.join(', ')}` : '';
      lines.push(`Skill proposal ${proposal.id} (${proposal.action} ${proposal.skill}) awaits human review, ${proposal.age_hours} h old${flags}`);
    }
    for (const pair of facts.set_aside) lines.push(`Set aside after ${pair.strikes} failed compiles: ${pair.pair}`);
    for (const skill of facts.skills) if (skill.attention.length > 0) lines.push(`Skill ${skill.name}: ${skill.attention.join(', ')}`);
    return { value: { ...facts } as unknown as Json, lines };
  },
};

/** Every fact this release reports, in order. */
export const STATUS_FACTS: readonly StatusFact[] = [syncFact, refreshedFact, knowledgeFact, strayFact, nodeFact, staleFact, excerptFact, codexFact];

/** Reads every fact of `root`. Writes nothing. */
export async function readStatus(options: StatusOptions): Promise<{ report: StatusReport; lines: string[] }> {
  const dirs = await findGitDirs(options.root);
  if (!dirs) throw new GrimoireError('NO_REPO', `no git repository at ${options.root}`, { root: options.root });
  const config = await readInstallConfig(options.root);
  let tracker: Promise<TrackerStore> | null = null;
  let view: Promise<TrackerView> | null = null;
  const input: StatusInput = {
    root: options.root,
    dirs,
    store: new MachineLocalStore(dirs.commonDir, dirs.worktree),
    version: options.version ?? VERSION,
    config,
    env: options.env ?? process.env,
    now: options.now ?? new Date(),
    view: () => (view ??= (tracker ??= openTracker(options.root)).then((store) => store.read())),
  };
  const values: Record<string, Json> = {};
  const lines: string[] = [`grimoire ${input.version} in ${options.root}${config?.version ? ` (pins ${config.version})` : ''}`];
  try {
    for (const fact of options.facts ?? STATUS_FACTS) {
      try {
        const { value, lines: more } = await fact.read(input);
        values[fact.key] = value;
        lines.push(...more);
      } catch (error) {
        values[fact.key] = unreadable(error);
        lines.push(`${fact.key}: couldn’t be read (${messageOf(error)})`);
      }
    }
  } finally {
    if (tracker) await (await (tracker as Promise<TrackerStore>).catch(() => null))?.close();
  }
  return { report: { version: input.version, root: options.root, pin: config?.version ?? null, ...values }, lines };
}
