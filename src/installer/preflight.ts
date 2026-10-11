// init's read-only preflight against git (spec §12 step 2): which remote the
// tracker goes to, what that remote holds (fetched with the explicit refspec),
// and which tracker root each tracker ref here descends from. Nothing here
// writes but the fetch's remote-tracking ref. A failed listing or fetch is
// reported as such and never counts as "the remote has none".
import { runGit } from '../git/run';
import { TRACKER_REF } from '../tracker';
import { TRACKER_BRANCH, remoteTrackerRef } from '../tracker/layout';
import { classifyFailure, failureMessage, runNetworkGit, stripUserinfo, type SyncFailureClass } from '../tracker/remote';

/** How long one network step of the preflight may take. */
const STEP_TIMEOUT_MS = 120_000;

export interface Remotes {
  /** Every configured remote, sorted. */
  readonly names: readonly string[];
  /** `git config grimoire.remote`, or null. */
  readonly chosen: string | null;
  /** Each remote's URL, userinfo stripped. */
  readonly urls: ReadonlyMap<string, string>;
  /** The user chose how git runs ssh (`core.sshCommand`). */
  readonly sshChosen: boolean;
}

/** The clone's remotes and grimoire's saved choice. */
export async function readRemotes(root: string): Promise<Remotes> {
  const run = await runGit(root, ['config', '-z', '--get-regexp', '^(grimoire\\.remote|remote\\..+\\.url|core\\.sshcommand)$']);
  let chosen: string | null = null;
  let sshChosen = false;
  const urls = new Map<string, string>();
  // Exit 1: none of them is set.
  if (run.code === 0) {
    for (const entry of run.stdout.toString('utf8').split('\0')) {
      const newline = entry.indexOf('\n');
      if (newline < 0) continue;
      const key = entry.slice(0, newline);
      const value = entry.slice(newline + 1);
      if (key === 'grimoire.remote') chosen = value.trim() || null;
      else if (key === 'core.sshcommand') sshChosen ||= value.trim() !== '';
      else if (key.startsWith('remote.') && key.endsWith('.url')) urls.set(key.slice('remote.'.length, -'.url'.length), stripUserinfo(value));
    }
  }
  return { names: [...urls.keys()].sort(), chosen, urls, sshChosen };
}

export interface RemoteFailure {
  readonly class: SyncFailureClass;
  readonly message: string;
}

/** What a remote holds: whether it has a default branch, and its tracker tip. */
export type RemoteListing =
  | { readonly reachable: true; readonly head: string | null; readonly tracker: string | null }
  | { readonly reachable: false; readonly failure: RemoteFailure };

function sshChosenNow(remotes: Remotes): boolean {
  return remotes.sshChosen || process.env.GIT_SSH_COMMAND !== undefined || process.env.GIT_SSH !== undefined;
}

/** `git ls-remote <remote> HEAD <tracker branch>`. */
export async function listRemote(root: string, remote: string, remotes: Remotes): Promise<RemoteListing> {
  const run = await runNetworkGit(root, ['ls-remote', remote, 'HEAD', TRACKER_BRANCH], { timeoutMs: STEP_TIMEOUT_MS, sshChosen: sshChosenNow(remotes) });
  if (run.code !== 0 || run.timedOut) {
    return { reachable: false, failure: { class: classifyFailure(run), message: failureMessage('ls-remote', run, STEP_TIMEOUT_MS) } };
  }
  let head: string | null = null;
  let tracker: string | null = null;
  for (const line of run.stdout.toString('utf8').split(/\r?\n/)) {
    const [oid, ref] = line.split('\t');
    if (!oid || !ref) continue;
    if (ref === 'HEAD') head = oid;
    if (ref === TRACKER_BRANCH) tracker = oid;
  }
  return { reachable: true, head, tracker };
}

/** Fetches the remote's tracker into its remote-tracking ref with the explicit refspec; null on success. */
export async function fetchTracker(root: string, remote: string, remotes: Remotes): Promise<RemoteFailure | null> {
  const run = await runNetworkGit(
    root,
    ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-filter', remote, `+${TRACKER_BRANCH}:${remoteTrackerRef(remote)}`],
    { timeoutMs: STEP_TIMEOUT_MS, sshChosen: sshChosenNow(remotes) },
  );
  if (run.code === 0 && !run.timedOut) return null;
  return { class: classifyFailure(run), message: failureMessage('fetch', run, STEP_TIMEOUT_MS) };
}

/**
 * Replaces the remote's tracker branch with `tip` (`init --new-tracker`), but
 * only while it still holds `expected`, the tip init showed the person; then
 * moves the remote-tracking ref along. Null on success.
 */
export async function replaceRemoteTracker(root: string, remote: string, remotes: Remotes, tip: string, expected: string): Promise<RemoteFailure | null> {
  const run = await runNetworkGit(
    root,
    ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', `--force-with-lease=${TRACKER_BRANCH}:${expected}`, remote, `${tip}:${TRACKER_BRANCH}`],
    { timeoutMs: STEP_TIMEOUT_MS, sshChosen: sshChosenNow(remotes) },
  );
  if (run.code !== 0 || run.timedOut) {
    const rejected = /\[rejected\]|\[remote rejected\]|stale info/.test(run.stdout.toString('utf8') + run.stderr);
    return { class: rejected ? 'rejected' : classifyFailure(run), message: failureMessage('push', run, STEP_TIMEOUT_MS) };
  }
  await runGit(root, ['update-ref', remoteTrackerRef(remote), tip]);
  return null;
}

/** A ref's commit, or null. */
export async function refTip(root: string, ref: string): Promise<string | null> {
  const run = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return run.code === 0 ? run.stdout.toString('utf8').trim() : null;
}

/** The local tracker tip, and `remote`'s remote-tracking tracker tip. */
export async function trackerTips(root: string, remote: string | null): Promise<{ local: string | null; remote: string | null }> {
  return {
    local: await refTip(root, TRACKER_REF),
    remote: remote === null ? null : await refTip(root, remoteTrackerRef(remote)),
  };
}

/** The tracker root of the history at `tip`: the root its first-parent chain ends in. */
export async function rootOf(root: string, tip: string): Promise<string> {
  const run = await runGit(root, ['rev-list', '--first-parent', '--max-parents=0', tip]);
  return run.stdout.toString('utf8').trim().split(/\r?\n/).pop()!;
}

/** Whether the history at `tip` holds the commit `trackerRoot` (any root, not only the first-parent one). */
export async function holdsRoot(root: string, tip: string, trackerRoot: string): Promise<boolean> {
  return (await runGit(root, ['merge-base', '--is-ancestor', trackerRoot, tip])).code === 0;
}

/** Saves the remote the tracker goes to (`git config grimoire.remote`). */
export async function saveRemote(root: string, remote: string): Promise<void> {
  const run = await runGit(root, ['config', 'grimoire.remote', remote]);
  if (run.code !== 0) throw new Error(`git config grimoire.remote failed: ${run.stderr.trim()}`);
}


/** Moves the local tracker ref back to `previous` (deleting it when there was none), if it still holds `current`. */
export async function restoreTrackerRef(root: string, previous: string | null, current: string): Promise<void> {
  await runGit(root, previous === null ? ['update-ref', '-d', TRACKER_REF, current] : ['update-ref', '-m', 'grimoire: init --new-tracker undone', TRACKER_REF, previous, current]);
}
