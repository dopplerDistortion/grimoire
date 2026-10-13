// Sync (spec §4, Sync; §3, Refs): fetch → fold → push of the tracker with the
// explicit refspec, so a teammate's plain `git fetch` brings it. Failures come
// back in the outcome, never as throws: the caller records them.
import { setTimeout as sleep } from 'node:timers/promises';
import { GrimoireError } from '../errors';
import type { GitRun } from '../git/run';
import { remoteTrackerRef, TRACKER_BRANCH } from './layout';
import {
  classifyFailure,
  failureMessage,
  lostRace,
  pushedRef,
  recordable,
  remoteLines,
  runNetworkGit,
  stripUserinfo,
  type NetworkGitOptions,
  type NetworkGitRun,
  type SyncFailureClass,
} from './remote';
import type { Person, WriteSpec } from './store';
import type { TrackerView } from './view';

/**
 * The excerpt mode at push time (spec §4 Before every push, §14 The setting):
 * whether the merged view's mode forbids excerpt text, and how a session
 * record loses it. Pushed text stays; the unpushed segment is rewritten.
 */
export interface TextPolicy {
  forbidsText(view: TrackerView): boolean;
  /** A session record's bytes without its text, or null when it carries none. */
  stripText(bytes: Buffer): Buffer | null;
}

/** Runs one network git step in a checkout: runNetworkGit, unless a test stands in for the remote. */
export type NetworkGit = (cwd: string, args: readonly string[], options: NetworkGitOptions) => Promise<NetworkGitRun>;

/** What one sync needs to know about its caller. */
export interface SyncSpec {
  /** Author and committer of a fold commit; null when the person has no git identity (a fold then gives NO_GIT_IDENTITY). */
  readonly author: Person | null;
  /** The git identity as resolved, for the details of NO_GIT_IDENTITY (default: none of it). */
  readonly identity?: { readonly name: string | null; readonly email: string | null };
  /** `Grimoire-Actor` of a fold commit. */
  readonly actor: WriteSpec['actor'];
  /** How long each network step may take. */
  readonly timeoutMs: number;
  /** When the whole sync must be done (epoch ms): each step gets at most what is left. */
  readonly deadline?: number;
  /** The excerpt mode's rule for what a push may carry (default: none, nothing is rewritten). */
  readonly text?: TextPolicy;
  /** Runs each network step (default: runNetworkGit). A test seam: a stand-in answers a push with lost races. */
  readonly network?: NetworkGit;
  /** Waits out the pause before a retry after a lost race (default: a timer). A test seam, like `network`. */
  readonly pause?: (ms: number) => Promise<void>;
  /**
   * Fetch only (`leave` without consent to push): the remote's tracker is
   * fetched as usual, but nothing is folded, rewritten or pushed. The outcome
   * is `in-sync` when the remote holds the local tip (or there is none), else
   * `pending` with no `reason`.
   */
  readonly fetchOnly?: boolean;
}

export interface SyncFailure {
  readonly class: SyncFailureClass;
  /** The remote's message, userinfo stripped. */
  readonly message: string;
  /** Every push round lost a race to other pushes: the remote is busy, not refusing, so no backoff follows. */
  readonly lostRace?: true;
}

export interface SyncOutcome {
  /**
   * `in-sync`: the remote holds the local tip or a descendant; `pushed`: this
   * sync pushed it; `pending`: the remote still lacks it (see `reason`).
   */
  readonly state: 'in-sync' | 'pushed' | 'pending';
  readonly reason?: 'no-remote' | 'no-default-branch' | 'failed';
  readonly failure?: SyncFailure;
  /** The remote synced with, or null when there is none. */
  readonly remote: string | null;
  /** Its URL, userinfo stripped. */
  readonly url: string | null;
  /** The local tracker tip after the sync. */
  readonly local: string | null;
  /** The remote's tracker tip after the sync, as last seen. */
  readonly remoteTip: string | null;
  /** True when this sync fetched the tracker. */
  readonly fetched: boolean;
  /** The fold commit this sync made, if any. */
  readonly fold: string | null;
}

/** What the sync engine needs from the tracker store. */
export interface SyncHost {
  /** The checkout's top level. */
  readonly root: string;
  /** Runs a local git in the checkout: GitStalledError (BUSY) when it gets stuck. */
  git(args: readonly string[]): Promise<GitRun>;
  /**
   * Moves `ref` from `old` (null: it must not exist) to `next` with a
   * compare-and-set; a lost one is no error. Cleans up after a git that gets
   * stuck on it, and then throws.
   */
  updateRef(ref: string, next: string, old: string | null): Promise<void>;
  /** Deletes `ref` while it still holds `old` (a compare-and-set); a lost one is no error. */
  deleteRef(ref: string, old: string): Promise<void>;
  /** The local tracker tip and every remote-tracking tracker tip, by remote name, resolved fresh. */
  trackerRefs(): Promise<TrackerRefs>;
  /** Whether the tracker's history is shallow in this clone. */
  isShallow(): Promise<boolean>;
  /** Commits the fold of the local and the remote-tracking tracker, when they diverged. */
  fold(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ commit: string | null }>;
  /**
   * The local tip to push, recorded as a push under way until `done` (a purge
   * meanwhile counts it as pushed: it is landing). With `policy`, when the
   * local tip's merged mode forbids text, the local commits `pushed` (the
   * remote's tip, null: none) lacks are rewritten first, so that no session
   * record they carry has text the remote doesn't hold already. The record
   * lapses after `ttlMs`. Null when there is no local tracker.
   */
  preparePush(pushed: string | null, policy: TextPolicy | undefined, ttlMs: number): Promise<{ readonly tip: string; done(): Promise<void> } | null>;
}

export interface TrackerRefs {
  readonly local: string | null;
  readonly remotes: ReadonlyMap<string, string>;
}

/**
 * A lost push race is retried, rounds this many in all and never past the
 * sync's deadline (spec §4: retries on non-fast-forward). Each lost race is
 * another clone's push landing, so two clones syncing at once settle within a
 * few rounds; the pause before each retry keeps them from running in step.
 * A rejection the remote's next listing shows no move after may be a refusal
 * rather than a race: see UNMOVED_REJECTIONS.
 */
const PUSH_ROUNDS = 10;
/** The pause before retry n after a lost race is a random share of n times this. */
const RACE_PAUSE_MS = 100;
/**
 * A rejection the remote's next listing shows no move after is retried, this
 * many rejections in a row at most, before it counts as the remote's refusal
 * (`rejected`, which backs off): a ref lock's holder that lets go without a
 * push of its own (a server-side pack-refs, say) gets its moment, and a
 * refusal fails within a few rounds rather than ten: a lock left stale, or a
 * push URL (`pushurl`, `pushInsteadOf`) that reaches other refs than the
 * fetch URL lists, where even `fetch first` comes with no move to fetch.
 */
const UNMOVED_REJECTIONS = 3;
/** The least pause before a retry once a rejection may be a held lock: its holder had it for git's whole lock timeout already. */
const LOCK_PAUSE_MS = 250;
/** How long a push's record outlives its step timeout: the kill at the timeout takes a moment to land. */
const PUSH_RECORD_SLACK_MS = 30_000;
/** Missing objects in a partial clone are backfilled in at most this many rounds (spec §4). */
const BACKFILL_ROUNDS = 2;

interface SyncConfig {
  /** `git config grimoire.remote`. */
  readonly remote: string | null;
  /** Every remote's URL, by name. */
  readonly urls: ReadonlyMap<string, string>;
  /** A partial clone: some remote is a promisor. */
  readonly partial: boolean;
  /** The user chose how git runs ssh (`core.sshCommand`); the environment variables are checked later. */
  readonly sshChosen: boolean;
}

/** A local git in the checkout. */
type LocalGit = SyncHost['git'];

async function readSyncConfig(git: LocalGit): Promise<SyncConfig> {
  const run = await git([
    'config',
    '-z',
    '--get-regexp',
    '^(grimoire\\.remote|remote\\..+\\.(url|promisor)|extensions\\.partialclone|core\\.sshcommand)$',
  ]);
  let remote: string | null = null;
  const urls = new Map<string, string>();
  let partial = false;
  let sshChosen = false;
  // Exit 1: none of them is set.
  if (run.code === 0) {
    for (const entry of run.stdout.toString('utf8').split('\0')) {
      const newline = entry.indexOf('\n');
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? 'true' : entry.slice(newline + 1);
      if (key === 'grimoire.remote') remote = value.trim() || null;
      else if (key === 'extensions.partialclone') partial ||= value.trim() !== '';
      else if (key === 'core.sshcommand') sshChosen ||= value.trim() !== '';
      else if (key.startsWith('remote.') && key.endsWith('.url')) urls.set(key.slice(7, -4), value);
      else if (key.startsWith('remote.') && key.endsWith('.promisor')) partial ||= /^(true|yes|on|1)$/i.test(value.trim());
    }
  }
  return { remote, urls, partial, sshChosen };
}

/**
 * The remote to sync with (spec §4, Remote choice): `grimoire.remote`, else
 * the remote that has the tracker (origin first), else `origin`. The tracker
 * store's read view picks the same one.
 */
function chooseRemote(config: SyncConfig, withTracker: readonly string[]): string | null {
  if (config.remote) return config.remote;
  const sorted = [...withTracker].sort();
  if (sorted.length > 0) return sorted.includes('origin') ? 'origin' : sorted[0]!;
  return config.urls.has('origin') ? 'origin' : null;
}

/** `git merge-base --is-ancestor`: false too when either commit is missing. */
async function isAncestor(git: LocalGit, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const run = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
  return run.code === 0;
}

/** Objects of `commits`' trees (and the commits themselves) missing from this partial clone. */
async function missingObjects(git: LocalGit, commits: readonly string[]): Promise<string[]> {
  if (commits.length === 0) return [];
  const run = await git(['rev-list', '--objects', '--missing=print', '--no-walk', ...commits]);
  // A commit itself is missing: fetch it, and everything under it, whole.
  if (run.code !== 0) return [...commits];
  return run.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('?'))
    .map((line) => line.slice(1).trim());
}

/** What `git ls-remote <remote> HEAD <tracker>` says: whether HEAD resolves (a default branch), and the tracker's tip. */
function parseListing(stdout: Buffer): { head: string | null; tracker: string | null } {
  let head: string | null = null;
  let tracker: string | null = null;
  for (const line of stdout.toString('utf8').split(/\r?\n/)) {
    const [oid, ref] = line.split('\t');
    if (!oid || !ref) continue;
    if (ref === 'HEAD') head = oid;
    if (ref === TRACKER_BRANCH) tracker = oid;
  }
  return { head, tracker };
}

/** Fetches, folds and pushes the tracker. Network and remote failures come back in the outcome. */
export async function syncTracker(host: SyncHost, spec: SyncSpec): Promise<SyncOutcome> {
  const { root } = host;
  const git = (args: readonly string[]) => host.git(args);
  const config = await readSyncConfig(git);
  let refs = await host.trackerRefs();
  const remote = chooseRemote(config, [...refs.remotes.keys()]);
  const url = remote === null ? null : recordable(stripUserinfo(config.urls.get(remote) ?? remote));
  let fetched = false;
  let fold: string | null = null;
  let local = refs.local;
  let remoteTip = remote === null ? null : (refs.remotes.get(remote) ?? null);
  const outcome = (rest: Pick<SyncOutcome, 'state' | 'reason' | 'failure'>): SyncOutcome => ({
    ...rest,
    remote,
    url,
    local,
    remoteTip,
    fetched,
    fold,
  });
  if (remote === null) return local ? outcome({ state: 'pending', reason: 'no-remote' }) : outcome({ state: 'in-sync' });

  const tracking = remoteTrackerRef(remote);
  /** A network step, bounded by the step timeout and by what is left of the sync's deadline. */
  const net = async (args: readonly string[], input?: string): Promise<NetworkGitRun & { limitMs: number }> => {
    const limitMs = Math.min(spec.timeoutMs, spec.deadline === undefined ? Infinity : spec.deadline - Date.now());
    if (limitMs <= 0) return { code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true, limitMs: 0 };
    const run = await (spec.network ?? runNetworkGit)(root, args, {
      timeoutMs: limitMs,
      sshChosen: config.sshChosen,
      ...(input !== undefined ? { input } : {}),
    });
    return { ...run, limitMs };
  };
  const failed = (step: string, run: NetworkGitRun & { limitMs: number }): SyncOutcome =>
    outcome({
      state: 'pending',
      reason: 'failed',
      failure: {
        class: classifyFailure(run),
        message:
          run.timedOut && run.limitMs < spec.timeoutMs
            ? `git ${step} timed out: the sync used up its time budget`
            : failureMessage(step, run, run.limitMs),
      },
    });
  /** The tips of the tracker's history here, with their merge bases: the objects every read and fold needs. */
  const tipCommits = async (): Promise<string[]> => {
    const current = await host.trackerRefs();
    const tips = [current.local, current.remotes.get(remote) ?? null].filter((tip): tip is string => tip !== null);
    if (tips.length < 2 || tips[0] === tips[1]) return [...new Set(tips)];
    const bases = await git(['merge-base', '--all', ...tips]);
    return [...tips, ...bases.stdout.toString('utf8').split(/\r?\n/).filter((line) => line !== '')];
  };

  /** The last push's rejection, which only a remote that moved since makes a lost race: the tip it saw, and the failure. */
  let rejection: { readonly tracker: string | null; readonly failure: SyncFailure } | null = null;
  /** Rejections in a row the remote's next listing showed no move after. */
  let unmoved = 0;
  /** Some rejection in this sync was a lost race: the remote's next listing showed it moved. */
  let raced = false;
  for (let round = 1; ; round++) {
    // 1. What the remote holds: its tracker tip, and whether it has a default branch.
    const listing = await net(['ls-remote', remote, 'HEAD', TRACKER_BRANCH]);
    if (listing.code !== 0 || listing.timedOut) return failed('ls-remote', listing);
    const { head, tracker } = parseListing(listing.stdout);
    // The last push was rejected: a remote that moved since raced it; one that didn't let go of a lock, or refuses it.
    if (rejection !== null) {
      unmoved = rejection.tracker === tracker ? unmoved + 1 : 0;
      raced ||= unmoved === 0;
      if (unmoved >= UNMOVED_REJECTIONS) return outcome({ state: 'pending', reason: 'failed', failure: rejection.failure });
    }
    rejection = null;

    // 2. Fetch it with the explicit refspec, deepening a shallow history.
    refs = await host.trackerRefs();
    const shallow = await host.isShallow();
    if (tracker !== null && (tracker !== (refs.remotes.get(remote) ?? null) || shallow)) {
      const fetch = await net([
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--no-filter',
        ...(shallow ? ['--unshallow'] : []),
        remote,
        `+${TRACKER_BRANCH}:${tracking}`,
      ]);
      if (fetch.code !== 0 || fetch.timedOut) return failed('fetch', fetch);
      fetched = true;
    }

    // 3. A partial clone: backfill the objects the tips need.
    if (config.partial) {
      for (let backfill = 0; backfill < BACKFILL_ROUNDS; backfill++) {
        const missing = await missingObjects(git, await tipCommits());
        if (missing.length === 0) break;
        const run = await net(
          [
            '-c',
            'fetch.negotiationAlgorithm=noop',
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-recurse-submodules',
            '--no-filter',
            '--stdin',
            remote,
          ],
          `${missing.join('\n')}\n`,
        );
        if (run.code !== 0 || run.timedOut) return failed('fetch', run);
        fetched = true;
      }
    }

    if (spec.fetchOnly) {
      refs = await host.trackerRefs();
      local = refs.local;
      remoteTip = tracker;
      const held = local === null || (tracker !== null && (await isAncestor(git, local, tracker)));
      return outcome({ state: held ? 'in-sync' : 'pending' });
    }

    // 4. Fold the fetched tracker into the local one.
    refs = await host.trackerRefs();
    local = refs.local;
    remoteTip = refs.remotes.get(remote) ?? null;
    if (tracker === null && remoteTip !== null) {
      // The remote holds no tracker: someone deleted it, and the remote-tracking ref is stale. Folded in, it would
      // bring the deleted tracker back. It goes (as `git fetch --prune` drops it) while it still holds what was read.
      await host.deleteRef(tracking, remoteTip);
      remoteTip = (await host.trackerRefs()).remotes.get(remote) ?? null;
    }
    /** The remote-tracking ref as this sync left it: the push moves it on only from there. */
    const tracked = remoteTip;
    if (local !== null && remoteTip !== null && local !== remoteTip) {
      if (spec.author) {
        const folded = await host.fold({ author: spec.author, actor: spec.actor });
        if (folded.commit) {
          fold = folded.commit;
          local = folded.commit;
        }
      } else if (!(await isAncestor(git, local, remoteTip)) && !(await isAncestor(git, remoteTip, local))) {
        throw new GrimoireError('NO_GIT_IDENTITY', `git user.email is not set in ${root}, so the fetched tracker can't be folded`, {
          name: spec.identity?.name ?? null,
          email: spec.identity?.email ?? null,
        });
      }
    }
    remoteTip = tracker;

    // 5. Push, unless the remote holds the local tip already.
    if (local === null) return outcome({ state: 'in-sync' });
    if (tracker !== null && (await isAncestor(git, local, tracker))) return outcome({ state: 'in-sync' });
    // Never the first branch of an empty remote: it would become the default branch.
    if (head === null) return outcome({ state: 'pending', reason: 'no-default-branch' });
    // The tip to push, read and recorded as under way where a purge rewrites: a purge from here on counts it as
    // pushed, and one before it is in it. The merged excerpt mode forbids text: the unpushed segment loses it
    // before it leaves (spec §4, §14).
    const claim = await host.preparePush(tracker, spec.text, spec.timeoutMs + PUSH_RECORD_SLACK_MS);
    if (claim === null) {
      local = null;
      return outcome({ state: 'in-sync' });
    }
    local = claim.tip;
    let push: NetworkGitRun & { limitMs: number };
    try {
      push = await net(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', remote, `${local}:${TRACKER_BRANCH}`]);
      if (push.code === 0 && !push.timedOut) {
        // git updates the remote-tracking ref only when a fetch refspec maps the branch. A
        // compare-and-set: a fetch elsewhere may have moved it past this push meanwhile. It is
        // only a record of what the remote holds, which the next fetch sets right, so a git
        // stuck on it takes nothing from the push, which landed. Only then does the push's
        // record go: a purge in between still sees the commit as pushed.
        await host.updateRef(tracking, local, tracked).catch(() => {});
        remoteTip = local;
        return outcome({ state: 'pushed' });
      }
    } finally {
      await claim.done();
    }
    if (push.timedOut) return failed('push', push);
    const pushed = pushedRef(push.stdout.toString('utf8'), TRACKER_BRANCH);
    if (pushed?.flag !== '!') return failed('push', push);
    const race = lostRace(pushed, push.stderr);
    const reason = /\(([^)]*)\)\s*$/.exec(pushed.summary)?.[1] ?? pushed.summary;
    const said = remoteLines(push.stderr);
    const rejected: SyncFailure = { class: 'rejected', message: recordable(said ? `${reason}: ${said}` : reason) };
    if (race && round < PUSH_ROUNDS) {
      const pauseMs = Math.max(race === 'contended' || unmoved > 0 ? LOCK_PAUSE_MS : 0, Math.random() * RACE_PAUSE_MS * round);
      if (spec.deadline === undefined || Date.now() + pauseMs < spec.deadline) {
        await (spec.pause ?? sleep)(pauseMs);
        rejection = { tracker, failure: rejected };
        continue;
      }
    }
    // No listing tells this one: a lost race when the remote said it moved, or a held lock while it was moving, unless it showed no move last time.
    const lost = race !== null && unmoved === 0 && (race === 'moved' || raced);
    return outcome({ state: 'pending', reason: 'failed', failure: lost ? { ...rejected, lostRace: true } : rejected });
  }
}
