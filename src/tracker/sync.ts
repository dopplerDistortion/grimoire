// Sync (spec §4, Sync; §3, Refs): fetch → fold → push of the tracker with the
// explicit refspec, so a teammate's plain `git fetch` brings it. Failures come
// back in the outcome, never as throws: the caller records them.
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
}

export interface SyncFailure {
  readonly class: SyncFailureClass;
  /** The remote's message, userinfo stripped. */
  readonly message: string;
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
  /** The local tracker tip and every remote-tracking tracker tip, by remote name, resolved fresh. */
  trackerRefs(): Promise<TrackerRefs>;
  /** Whether the tracker's history is shallow in this clone. */
  isShallow(): Promise<boolean>;
  /** Commits the fold of the local and the remote-tracking tracker, when they diverged. */
  fold(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ commit: string | null }>;
  /**
   * When the local tip's merged mode forbids text, rewrites the local commits
   * `pushed` (the remote's tip, null: none) lacks so that no session record
   * they carry has text the remote doesn't hold already. Returns the new local
   * tip, or null when nothing changed.
   */
  stripUnpushed(pushed: string | null, policy: TextPolicy): Promise<string | null>;
}

export interface TrackerRefs {
  readonly local: string | null;
  readonly remotes: ReadonlyMap<string, string>;
}

/** A lost push race is retried this many times in all (spec §4: retries on non-fast-forward). */
const PUSH_ROUNDS = 3;
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
    const run = await runNetworkGit(root, args, {
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

  for (let round = 1; ; round++) {
    // 1. What the remote holds: its tracker tip, and whether it has a default branch.
    const listing = await net(['ls-remote', remote, 'HEAD', TRACKER_BRANCH]);
    if (listing.code !== 0 || listing.timedOut) return failed('ls-remote', listing);
    const { head, tracker } = parseListing(listing.stdout);

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

    // 4. Fold the fetched tracker into the local one.
    refs = await host.trackerRefs();
    local = refs.local;
    remoteTip = refs.remotes.get(remote) ?? null;
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
    // The merged excerpt mode forbids text: the unpushed segment loses it before it leaves (spec §4, §14).
    if (spec.text) local = (await host.stripUnpushed(tracker, spec.text)) ?? local;
    // Never the first branch of an empty remote: it would become the default branch.
    if (head === null) return outcome({ state: 'pending', reason: 'no-default-branch' });
    const push = await net(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', remote, `${local}:${TRACKER_BRANCH}`]);
    if (push.code === 0 && !push.timedOut) {
      // git updates the remote-tracking ref only when a fetch refspec maps the branch. A
      // compare-and-set: a fetch elsewhere may have moved it past this push meanwhile. It is
      // only a record of what the remote holds, which the next fetch sets right, so a git
      // stuck on it takes nothing from the push, which landed.
      await host.updateRef(tracking, local, tracked).catch(() => {});
      remoteTip = local;
      return outcome({ state: 'pushed' });
    }
    if (push.timedOut) return failed('push', push);
    const pushed = pushedRef(push.stdout.toString('utf8'), TRACKER_BRANCH);
    if (pushed && lostRace(pushed, push.stderr) && round < PUSH_ROUNDS) continue;
    if (pushed?.flag === '!') {
      const reason = /\(([^)]*)\)\s*$/.exec(pushed.summary)?.[1] ?? pushed.summary;
      const said = remoteLines(push.stderr);
      return outcome({
        state: 'pending',
        reason: 'failed',
        failure: { class: 'rejected', message: recordable(said ? `${reason}: ${said}` : reason) },
      });
    }
    return failed('push', push);
  }
}
