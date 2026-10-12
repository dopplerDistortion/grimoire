import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { VERSION } from '../version';
import { TREE_MODE, zeroOid, type TreeEntry } from '../git/objects';
import { locateRepo, type RepoLocation } from '../git/repo';
import { packedRefsStamp, RefUpdater, type RefUpdate } from '../git/refs';
import { GIT_STALL_MS, GitStalledError, runGit } from '../git/run';
import { bareId, randomIdSuffix } from './ids';
import { lookupKey, keyEdits, type Idempotency } from './keys';
import { attemptDir, ATTEMPTS_DIR, FORMAT_FILE, GITATTRIBUTES, GITATTRIBUTES_FILE, isAttemptEnd, outcomeFile, OUTCOMES_DIR, remoteTrackerRef, SESSIONS_DIR, SETTINGS_FILE, TRACKER_REF } from './layout';
import { FairnessLock, sleep, Turnstile } from './locks';
import { countLateDrops } from './capture-stats';
import { foldCommits, type FoldReport } from './fold';
import { checkTrackerMarker, parseMarker, serializeMarker, V1_MARKER } from './marker';
import { BoundedMap, TrackerObjects, VirtualObjects } from './objects';
import { serializeSettings, settingLine } from './settings';
import { syncTracker, type SyncOutcome, type SyncSpec, type TextPolicy, type TrackerRefs } from './sync';
import { Draft, SnapshotLoader, type Snapshot, type TrackerDraft, type TrackerView } from './view';

export interface Person {
  name: string;
  email: string;
}

/** Facts about one write that its commit records (spec §3, Commits). */
export interface WriteSpec {
  /** `Grimoire-Op`: create, update, comment, …; a multi-word op is hyphenated (outcome-set, skill-edit). */
  readonly op: string;
  /** Author and committer. */
  readonly author: Person;
  /** `Grimoire-Actor`, written as one-line JSON in this key order. Ids only, never paths. */
  readonly actor: Readonly<Record<string, string | undefined>>;
  /** Replays the stored result instead of writing again (looked up first in every round). */
  readonly idempotency?: Idempotency;
}

export interface WriteOutcome<R> {
  /** The operation's result; stored under the idempotency key, so JSON only. */
  readonly result: R;
  /** `Grimoire-Issue`. */
  readonly issue?: string;
  /** `Grimoire-Attempt`. */
  readonly attempt?: string;
}

export interface WriteResult<R> {
  readonly result: R;
  /** The commit the write made; null for a replay or a write with nothing to change. */
  readonly commit: string | null;
  /** True when an idempotency key replayed an earlier result. */
  readonly replayed: boolean;
  /** True when the commit sealed an attempt (wrote its `end.md`): an attempt-ending write. */
  readonly sealed: boolean;
  /** The commit's `Grimoire-Issue`, when it made one that names an issue. */
  readonly issue?: string;
  /** The commit's `Grimoire-Attempt` (the handle it binds), when it made one that names a handle. */
  readonly attempt?: string;
  /** A purge's: what dropping its content from the unpushed segment did, in the same compare-and-set as its commit. */
  readonly history?: UnpushedDrop;
}

export interface TrackerOptions {
  /** `Grimoire-Version` (default: this release). */
  readonly version?: string;
  readonly clock?: () => Date;
  /** Draws an id suffix of the given length (default: crypto-random Crockford). */
  readonly randomIdSuffix?: (length: number) => string;
  /** Draws an attempt handle (default: crypto-random); tests pin it. */
  readonly randomAttemptHandle?: () => string;
  /** How long one write may keep retrying before BUSY (default ~10 s). */
  readonly budgetMs?: number;
  /** How long a local git may say nothing before it is killed as stuck (default GIT_STALL_MS). */
  readonly gitStallMs?: number;
}

export interface TrackerStore {
  readonly location: RepoLocation;
  /**
   * The current view: refs resolved fresh on every call, the view memoized by
   * the tip pair. Throws NOT_SYNCED without a tracker and UPGRADE_REQUIRED
   * when its `format` marker is outside this release's range.
   */
  read(): Promise<TrackerView>;
  /**
   * The tip pair a read would show, resolved fresh, without reading the view:
   * the local tracker ref and the chosen remote's remote-tracking tracker ref
   * (null where a ref is missing). The dashboard's live events poll it.
   */
  tips(): Promise<TrackerTips>;
  /**
   * The tip pair, after the checks a read makes before it loads the view:
   * NOT_SYNCED without a tracker (no tracker ref, or none holding the root
   * `config.yml` names), UPGRADE_REQUIRED when a tip's `format` marker is
   * outside this release's range. For a caller that may skip the read.
   */
  check(): Promise<TrackerTips>;
  /** The store's clock: the instant reads judge staleness by. */
  now(): Date;
  /**
   * Runs a write as compare-and-set rounds. Each round looks up the
   * idempotency key, checks the marker, re-runs `body` on a fresh draft, and
   * commits the draft's edits as one commit with a compare-and-set ref move.
   * `body` may run several times and must only touch the draft. Any error
   * means the ref did not move (but a plain Error, when a git that stopped
   * answering after it was told to move the ref can't say whether it did).
   * BUSY after the budget, or at once for a ref lock older than ~30 s
   * (`details.stale_lock`). A git that says nothing for `gitStallMs`, or
   * until the budget runs out if that comes first, is killed and the round
   * tried again on a new one, or BUSY once the budget is spent (a git that
   * may have moved the ref gets longer, see `STALL_FLOOR_MS`).
   */
  transact<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
  ): Promise<WriteResult<R>>;
  /**
   * Creates the tracker ref as an orphan history holding the v1 `format`
   * marker (and the seed settings, set by the author), unless a local or
   * remote-tracking tracker exists already. Returns the root commit. With
   * `replace` it mints a new root even then, moving the local tracker ref to
   * it (`init --new-tracker`, the only way the tracker root changes).
   */
  initialize(spec: Omit<WriteSpec, 'op' | 'idempotency'>, options?: InitializeOptions): Promise<{ root: string; created: boolean }>;
  /**
   * Commits the fold on its own (`Grimoire-Op: fold`) when the local and the
   * remote-tracking tracker diverged: the merged view, with both tips as
   * parents. Returns null when there was nothing to fold.
   */
  fold(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ commit: string | null }>;
  /**
   * Fetch → fold → push with the remote (spec §4, Sync): fetches the
   * remote's `grimoire/tracker` (deepening a shallow history, backfilling a
   * partial clone), commits the fold when the two diverged, and pushes the
   * local tip unless the remote holds it, retrying a lost push race. Never
   * pushes to a remote without a default branch. Network and remote failures
   * come back in the outcome; only store errors (NO_GIT_IDENTITY for a fold,
   * UPGRADE_REQUIRED, BUSY) throw.
   */
  sync(spec: SyncSpec): Promise<SyncOutcome>;
  /** Stops the store's git process. */
  close(): Promise<void>;
}

/**
 * What a purge's write did to history (spec §3 Unpushed content). In the
 * same round, under the same locks, every local commit no remote-tracking
 * tracker holds was written again without the purged paths, oldest first,
 * with the same author, committer and message; the purge commit went on top,
 * and the ref moved once, by compare-and-set. Pushed history is never
 * rewritten, and grimoire never runs gc.
 */
export interface UnpushedDrop {
  /** How many unpushed commits were written again. */
  readonly rewritten: number;
  /** Whether the tracker reflog's entries for the rewritten commits were expired (true when nothing was rewritten). */
  readonly reflogExpired: boolean;
  /** Whether pushed history (what a remote-tracking tracker holds) has any of the paths: it keeps them. */
  readonly pushed: boolean;
}

export interface InitializeOptions {
  /** Store settings the root commit holds, each set by the author at the commit's time. */
  readonly settings?: ReadonlyMap<string, unknown>;
  /** Mint a new root even when a tracker exists, moving the local ref to it. */
  readonly replace?: boolean;
}

export const DEFAULT_BUDGET_MS = 10_000;
/** A ref lock older than this is stale: BUSY with `details.stale_lock` (spec §4). */
export const STALE_REF_LOCK_MS = 30_000;
/** How many commits `reaches` walks before it leaves the question to a git process. */
const ANCESTRY_WALK = 128;
/**
 * As a write's budget runs out, the gits it waits on get only what is left
 * of it to answer, so one that gets stuck late still gives BUSY on time:
 * killing a git that can't have moved the ref costs nothing but the write,
 * which is out of budget anyway. Two waits get at least this long however
 * little is left, since cutting them short costs more than time: a git told
 * to commit (killed, the write can't say whether the ref moved), and a
 * killed git's exit (its ref lock can be removed only once it is gone).
 */
const STALL_FLOOR_MS = 1_000;

interface Tips {
  local: string | null;
  remote: string | null;
}

/** The local tracker tip and the chosen remote's remote-tracking tip. */
export interface TrackerTips {
  readonly local: string | null;
  readonly remote: string | null;
}

/** What the clone's config says about remotes. */
interface RemoteConfig {
  /** `grimoire.remote`, or null. */
  readonly chosen: string | null;
  /** The configured remotes' names, plus `grimoire.remote`'s: whose remote-tracking tracker counts. */
  readonly names: readonly string[];
}

/** The `shallow` file as last read, and whether each commit's history reaches one of its commits. */
interface ShallowMemo {
  /** The file's mtime and size when it was read. */
  readonly stamp: string;
  readonly boundary: ReadonlySet<string>;
  readonly reaches: BoundedMap<string, boolean>;
}

type RefMove = { moved: true } | { moved: false; staleLock?: { path: string; age_ms: number } };

function busy(message: string, details: Record<string, unknown> = {}): GrimoireError {
  return new GrimoireError('BUSY', message, details);
}

function notSynced(root: string): GrimoireError {
  return new GrimoireError('NOT_SYNCED', `there is no grimoire tracker in ${root}`, {
    remedy: 'run `grimoire init` to set grimoire up in this clone',
  });
}

/** `config.yml` names root R, but no tracker ref in this clone holds it (spec §4, Missing tracker). */
function missingTracker(root: string, trackerRoot: string, other: boolean): GrimoireError {
  return new GrimoireError(
    'NOT_SYNCED',
    other
      ? `the tracker refs in ${root} hold another tracker than the one .grimoire/config.yml names (root ${trackerRoot})`
      : `the tracker .grimoire/config.yml names (root ${trackerRoot}) isn't in this clone yet`,
    {
      remedy: other
        ? 'run `grimoire sync` to fetch grimoire/tracker from the remote; if that doesn’t fix it, a human runs `grimoire init` to repair this clone'
        : 'run `grimoire sync` (or a plain `git fetch`) to fetch grimoire/tracker from the remote',
      tracker_root: trackerRoot,
    },
  );
}

/** Writes wait while the tracker's history is shallow (spec §4, Refusals). */
function shallowHistory(root: string): GrimoireError {
  return new GrimoireError('NOT_SYNCED', `the tracker history is shallow in ${root}, so writes wait until sync deepens it`, {
    remedy: 'run `grimoire sync` to fetch the full tracker history',
  });
}

/** The `.grimoire/config.yml` key that names the tracker root R (spec §11, The dotfolder). */
export const TRACKER_ROOT_KEY = 'tracker_root';

/** The tracker root R a checkout's `.grimoire/config.yml` names, or null. */
export function namedTrackerRoot(configText: string): string | null {
  const match = new RegExp(`^${TRACKER_ROOT_KEY}:[ \t]*["']?([0-9a-fA-F]{7,64})["']?[ \t]*(?:#.*)?$`, 'm').exec(configText);
  return match ? match[1]!.toLowerCase() : null;
}

function trailerValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new GrimoireError('INVALID', `the ${name} trailer value contains a line break`, {
      fields: { [name]: 'contains a line break' },
    });
  }
  return value;
}

export async function openTracker(dir: string, options: TrackerOptions = {}): Promise<TrackerStore> {
  return new GitTrackerStore(await locateRepo(dir, { stallMs: options.gitStallMs ?? GIT_STALL_MS }), options);
}

class GitTrackerStore implements TrackerStore {
  private readonly objects: TrackerObjects;
  private readonly loader: SnapshotLoader;
  private readonly snapshots = new BoundedMap<string, Snapshot>(16);
  /** What each fold snapshot's fold noticed: counted once a write commits that fold. */
  private readonly foldReports = new WeakMap<Snapshot, FoldReport>();
  private readonly bases = new BoundedMap<string, readonly string[]>(256);
  private readonly turnstile = new Turnstile();
  private readonly fairness: FairnessLock;
  private readonly clock: () => Date;
  private readonly randomSuffix: (length: number) => string;
  private readonly budgetMs: number;
  private readonly stallMs: number;
  /** The deadline of the write running now (writes in a store run one at a time), or null. */
  private writeDeadline: number | null = null;
  /** The last git that stopped answering in the write running now, before its rounds (in its prefetch), or null. */
  private writeStall: GitStalledError | null = null;
  /** Moves the tracker ref for writes, through one long-lived git. */
  private readonly updater: RefUpdater;
  private remoteConfig: { stamp: string; value: RemoteConfig } | null = null;
  private checkoutConfig: { stamp: string; root: string | null } | null = null;
  /** Whether a tip's history holds a root commit, by `<root> <tip>`. */
  private readonly holds = new BoundedMap<string, boolean>(1_024);
  private shallowMemo: ShallowMemo | null = null;
  /** The latest comment time this store wrote: comment times never go back within a process. */
  private commentMs = 0;

  constructor(
    readonly location: RepoLocation,
    private readonly options: TrackerOptions,
  ) {
    this.stallMs = options.gitStallMs ?? GIT_STALL_MS;
    const stall = () => this.stallNow();
    this.objects = new TrackerObjects(location.root, path.join(location.commonDir, 'objects'), location.objectFormat, stall);
    this.loader = new SnapshotLoader(this.objects);
    this.fairness = new FairnessLock(location.commonDir);
    this.updater = new RefUpdater(location, 'grimoire: write', this.updaterStalls());
    this.clock = options.clock ?? (() => new Date());
    this.randomSuffix = options.randomIdSuffix ?? randomIdSuffix;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  /** How long a local git may say nothing now: `gitStallMs`, or what is left of a write's budget when that is less. */
  private stallNow(): number {
    if (this.writeDeadline === null) return this.stallMs;
    return Math.min(this.stallMs, Math.max(0, this.writeDeadline - Date.now()));
  }

  /** The same, for a git that may have moved the ref or must exit first (see `STALL_FLOOR_MS`). */
  private settleNow(): number {
    return Math.max(Math.min(this.stallMs, STALL_FLOOR_MS), this.stallNow());
  }

  private updaterStalls() {
    return { stallMs: () => this.stallNow(), settleMs: () => this.settleNow() };
  }

  /** A one-shot git in the repository, killed (GitStalledError) when it says nothing for the stall time. */
  private git(args: readonly string[]) {
    return runGit(this.location.root, args, { stallMs: () => this.stallNow() });
  }

  async close(): Promise<void> {
    await Promise.all([this.objects.close(), this.updater.close()]);
  }

  now(): Date {
    return this.clock();
  }

  async tips(): Promise<TrackerTips> {
    return this.resolveTips();
  }

  async check(): Promise<TrackerTips> {
    const tips = await this.resolveTips();
    await this.checkTracker(tips);
    for (const tip of new Set([tips.local, tips.remote])) {
      if (!tip) continue;
      const { tree } = await this.objects.commit(tip);
      const marker = await this.objects.fileAt(tree, FORMAT_FILE);
      checkTrackerMarker(marker ? parseMarker(marker.toString('utf8')) : null);
    }
    return tips;
  }

  async read(): Promise<TrackerView> {
    const tips = await this.resolveTips();
    const snapshot = await this.snapshotOf(tips);
    checkTrackerMarker(snapshot.marker);
    return snapshot;
  }

  async transact<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
    options: { foldOnly?: boolean } = {},
  ): Promise<WriteResult<R>> {
    const deadline = Date.now() + this.budgetMs;
    this.objects.warm();
    const turn = await this.turnstile.run(deadline, async () => {
      this.writeDeadline = deadline;
      try {
        await this.prefetch();
        const lock = await this.fairness.acquire(deadline);
        if (!lock) throw busy('another grimoire write held the tracker for the whole write budget');
        try {
          return await this.rounds(spec, body, deadline, options);
        } finally {
          await lock.release();
        }
      } finally {
        this.writeDeadline = null;
        this.writeStall = null;
      }
    });
    if (!turn) throw busy('other writes in this process held the tracker for the whole write budget');
    return turn.value;
  }

  /**
   * Gets both long-lived gits running and the current view cached before a
   * write queues for the fairness lock, so the round inside the lock pays only
   * for what changed since. Writes hold that lock one after another, so a git
   * start or a cold snapshot inside it would delay every writer queued behind.
   * Any failure here is the round's to report.
   */
  private async prefetch(): Promise<void> {
    const warming = this.updater.warm();
    try {
      const tips = await this.resolveTips();
      await this.isShallow(tips);
      await this.snapshotOf(tips);
    } catch (error) {
      // The round resolves and loads again, and reports what went wrong; but once a stuck git has used up
      // the budget, no round starts, and the BUSY names that git.
      if (error instanceof GitStalledError) this.writeStall = error;
    }
    await warming;
  }

  async fold(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ commit: string | null }> {
    const write = await this.transact({ ...spec, op: 'fold' }, () => ({ result: null }), { foldOnly: true });
    return { commit: write.commit };
  }

  sync(spec: SyncSpec): Promise<SyncOutcome> {
    return syncTracker(
      {
        root: this.location.root,
        git: (args) => this.git(args),
        updateRef: async (ref, next, old) => {
          await this.updateRefOnce(ref, next, old ?? zeroOid(this.location.objectFormat), 'grimoire: sync');
        },
        trackerRefs: () => this.trackerRefs(),
        isShallow: async () => this.isShallow(await this.resolveTips()),
        fold: (foldSpec) => this.fold(foldSpec),
        stripUnpushed: (pushed, policy) => this.stripUnpushed(pushed, policy),
      },
      spec,
    );
  }

  /**
   * Rewrites the unpushed segment (spec §4 Before every push, §3 Unpushed
   * content): every local commit `pushed` lacks is written again, oldest
   * first, with the same author, committer and message, its session records
   * stripped of text wherever the remote's tip doesn't hold that very record,
   * and its parents rewritten. Runs like a write (one at a time in this
   * process, under the fairness lock) and moves the ref with a compare-and-set;
   * the rewritten commits' reflog entries are expired. Null when the local
   * tip's mode allows text or nothing carried any.
   */
  private async stripUnpushed(pushed: string | null, policy: TextPolicy): Promise<string | null> {
    const pushedTree = pushed ? (await this.objects.commit(pushed)).tree : null;
    return this.rewriteUnpushed(async (local) => {
      if (local === pushed) return null;
      if (!policy.forbidsText(await this.snapshotAt(local))) return null;
      return { excluded: pushed ? [pushed] : [], transform: (tree) => this.stripTree(tree, pushedTree, policy) };
    }).then((done) => (done && done.rewritten > 0 ? done.tip : null));
  }

  /**
   * A purge's unpushed segment, written again without the paths it drops
   * (`traces`: handles purged before, whose paths come from history), ready
   * for the purge commit to go on top: the new local tip, how many commits
   * changed, and what pushed history is checked against. Runs inside the
   * write's round, so the purge commit and the rewrite move the ref once.
   * Null for a write that purges nothing.
   */
  private async dropUnpushed(
    local: string | null,
    drops: { readonly paths: readonly string[]; readonly traces: readonly string[] },
  ): Promise<{ tip: string | null; rewritten: number; remotes: string[]; paths: string[] } | null> {
    if (drops.paths.length === 0 && drops.traces.length === 0) return null;
    const remotes = [...new Set((await this.trackerRefs()).remotes.values())];
    const found = await this.tracePathsInHistory(drops.traces, [...(local ? [local] : []), ...remotes]);
    const paths = [...new Set([...drops.paths, ...found])];
    if (local === null || paths.length === 0) return { tip: local, rewritten: 0, remotes, paths };
    const { tip, rewritten } = await this.rewriteSegment(local, remotes, (tree) => this.dropPaths(tree, paths));
    return { tip, rewritten, remotes, paths };
  }

  /** After the purge commit's ref move: the rewritten commits' reflog entries expired, and whether pushed history keeps the content. */
  private async droppedHistory(drop: { rewritten: number; remotes: string[]; paths: string[] }): Promise<UnpushedDrop> {
    const reflogExpired = drop.rewritten === 0 || (await this.expireReflog());
    return { rewritten: drop.rewritten, reflogExpired, pushed: await this.pushedHolds(drop.remotes, drop.paths) };
  }

  /**
   * The paths of traces purged before (the attempt gone from the tree, and
   * with it the issue that names its paths): every attempt directory and
   * outcome file of those handles that the history of `tips` ever held.
   */
  private async tracePathsInHistory(handles: readonly string[], tips: readonly string[]): Promise<string[]> {
    if (handles.length === 0 || tips.length === 0) return [];
    const specs = handles.flatMap((handle) => [`:(glob)${ATTEMPTS_DIR}/*/*/*/${handle}/**`, `:(glob)${OUTCOMES_DIR}/*/*/*/${handle}.md`]);
    const run = await this.git(['log', '--format=', '--name-only', '-m', ...tips, '--', ...specs]);
    if (run.code !== 0) throw new Error(`git log failed: ${run.stderr.toString().trim()}`);
    const paths = new Set<string>();
    for (const line of run.stdout.toString('utf8').split(/\r?\n/)) {
      const [top, , , issue, name] = line.split('/');
      if (issue === undefined || name === undefined) continue;
      if (top === ATTEMPTS_DIR) paths.add(attemptDir(issue, name));
      else if (top === OUTCOMES_DIR && name.endsWith('.md')) {
        paths.add(attemptDir(issue, name.slice(0, -3)));
        paths.add(outcomeFile(issue, name.slice(0, -3)));
      }
    }
    return [...paths];
  }

  /** Expires the tracker reflog's entries for commits no longer reachable (rewritten ones); grimoire never runs gc. Whether git did. */
  private async expireReflog(): Promise<boolean> {
    const run = await this.git(['reflog', 'expire', '--expire=never', '--expire-unreachable=now', TRACKER_REF]).catch(() => null);
    return run !== null && run.code === 0;
  }

  /** Whether the history of any of `tips` (pushed history) ever held one of `paths`. */
  private async pushedHolds(tips: readonly string[], paths: readonly string[]): Promise<boolean> {
    if (tips.length === 0 || paths.length === 0) return false;
    const run = await this.git(['rev-list', '-1', ...tips, '--', ...paths]);
    // Unsure (git failed): say pushed history may keep it, never that it doesn't.
    return run.code !== 0 || run.stdout.toString('utf8').trim() !== '';
  }

  /** `tree` without `paths` (the same tree when it holds none of them). */
  private async dropPaths(tree: string, paths: readonly string[]): Promise<string> {
    const held = await Promise.all(paths.map((path) => this.objects.entryAt(tree, path)));
    if (held.every((entry) => entry === null)) return tree;
    const edits = new Map<string, null>(paths.map((path) => [path, null]));
    return (await this.objects.editTree(tree, edits)) ?? (await this.objects.emptyTree());
  }

  /**
   * Rewrites the unpushed segment as `plan` says for the local tip: which
   * commits count as pushed (excluded with their history) and how each tree
   * changes. Runs like a write (one at a time in this process, under the
   * fairness lock) and moves the ref with a compare-and-set, then expires the
   * reflog entries of the commits it rewrote. Null when there is no local
   * tracker or `plan` says there is nothing to do.
   */
  private async rewriteUnpushed(
    plan: (local: string, refs: TrackerRefs) => Promise<{ excluded: readonly string[]; transform: (tree: string) => Promise<string> } | null>,
  ): Promise<{ tip: string; rewritten: number } | null> {
    const deadline = Date.now() + this.budgetMs;
    const turn = await this.turnstile.run(deadline, async () => {
      const lock = await this.fairness.acquire(deadline);
      if (!lock) throw busy('another grimoire write held the tracker for the whole write budget');
      try {
        for (;;) {
          const refs = await this.trackerRefs();
          const local = refs.local;
          if (local === null) return null;
          const planned = await plan(local, refs);
          if (!planned) return null;
          const { tip, rewritten } = await this.rewriteSegment(local, planned.excluded, planned.transform);
          if (tip === local) return { tip, rewritten: 0 };
          const move = await this.moveRef(local, tip);
          if (move.moved) {
            await this.expireReflog();
            return { tip, rewritten };
          }
          if (move.staleLock) throw busy(`a stale lock blocks the tracker ref: ${move.staleLock.path}`, { stale_lock: move.staleLock });
          if (Date.now() >= deadline) throw busy('the tracker kept moving while its unpushed commits were rewritten');
        }
      } finally {
        await lock.release();
      }
    });
    if (!turn) throw busy('other writes in this process held the tracker for the whole write budget');
    return turn.value;
  }

  /**
   * The segment `local` holds beyond the `excluded` commits, each tree changed
   * by `transform` and each commit written again over its rewritten parents:
   * the new tip (`local` when nothing changed) and how many commits changed.
   */
  private async rewriteSegment(
    local: string,
    excluded: readonly string[],
    transform: (tree: string) => Promise<string>,
  ): Promise<{ tip: string; rewritten: number }> {
    const listed = await this.git(['rev-list', '--reverse', '--topo-order', '--parents', local, ...excluded.map((commit) => `^${commit}`)]);
    if (listed.code !== 0) throw new Error(`git rev-list failed: ${listed.stderr.toString().trim()}`);
    const trees = new Map<string, string>();
    const mapped = new Map<string, string>();
    let rewritten = 0;
    for (const line of listed.stdout.toString('utf8').split(/\r?\n/)) {
      if (line === '') continue;
      const [commit, ...parents] = line.split(' ') as [string, ...string[]];
      const { tree } = await this.objects.commit(commit);
      let stripped = trees.get(tree);
      if (stripped === undefined) {
        stripped = await transform(tree);
        trees.set(tree, stripped);
      }
      const newParents = parents.map((parent) => mapped.get(parent) ?? parent);
      if (stripped === tree && newParents.every((parent, i) => parent === parents[i])) {
        mapped.set(commit, commit);
        continue;
      }
      const raw = (await this.objects.commitBytes(commit)).toString('utf8');
      const split = raw.indexOf('\n\n');
      // Same author, committer and message; a signature (and its continuation lines) no longer holds, so it goes.
      let signature = false;
      const header = (split < 0 ? raw : raw.slice(0, split)).split('\n').filter((l) => {
        if (l.startsWith(' ')) return !signature;
        signature = l.startsWith('gpgsig');
        return !signature && !l.startsWith('tree ') && !l.startsWith('parent ');
      });
      const rest = split < 0 ? '' : raw.slice(split);
      const bytes = [`tree ${stripped}`, ...newParents.map((parent) => `parent ${parent}`), ...header].join('\n') + rest;
      mapped.set(commit, await this.objects.write('commit', Buffer.from(bytes, 'utf8')));
      rewritten++;
    }
    return { tip: mapped.get(local) ?? local, rewritten };
  }

  /** `tree` with the text stripped from each session record that `pushedTree` doesn't hold at the same path. */
  private async stripTree(tree: string, pushedTree: string | null, policy: TextPolicy): Promise<string> {
    const edits = new Map<string, Buffer>();
    const entriesOf = async (oid: string | null) => new Map((oid ? await this.objects.tree(oid) : []).map((e): [string, TreeEntry] => [e.name, e]));
    const walk = async (oid: string, pushedOid: string | null, at: readonly string[]): Promise<void> => {
      if (oid === pushedOid) return;
      const [ours, theirs] = await Promise.all([entriesOf(oid), entriesOf(pushedOid)]);
      for (const [name, entry] of ours) {
        if (at.length === 0 && name !== ATTEMPTS_DIR) continue;
        const held = theirs.get(name);
        if (held && held.oid === entry.oid && held.mode === entry.mode) continue;
        const path = [...at, name];
        if (entry.mode === TREE_MODE) {
          if (path.length < 7) await walk(entry.oid, held?.mode === TREE_MODE ? held.oid : null, path);
        } else if (path.length === 7 && path[5] === SESSIONS_DIR && name.endsWith('.md')) {
          const without = policy.stripText(await this.objects.blob(entry.oid));
          if (without) edits.set(path.join('/'), without);
        }
      }
    };
    await walk(tree, pushedTree, []);
    if (edits.size === 0) return tree;
    return (await this.objects.editTree(tree, edits)) ?? tree;
  }

  private async rounds<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
    deadline: number,
    options: { foldOnly?: boolean },
  ): Promise<WriteResult<R>> {
    // The last git that stopped answering in this write, if one did.
    let stalled = this.writeStall;
    for (;;) {
      // Once a git got stuck and the budget is spent, a new round gets no time for any git: it could only
      // start new ones in place of the killed one (on a loaded machine, each start holds up the BUSY) and
      // kill them at once. BUSY now, naming the stuck git.
      if (stalled && Date.now() >= deadline) throw stalled;
      try {
        const written = await this.round(spec, body, options);
        if (written) return written;
        if (Date.now() >= deadline) throw busy('the tracker kept moving for the whole write budget');
      } catch (error) {
        // The stuck git was killed before the ref could move: try again on a new one while the budget lasts
        // (its gits get only what is left of it).
        if (!(error instanceof GitStalledError) || Date.now() >= deadline) throw error;
        stalled = error;
      }
      await sleep(5 + Math.random() * 20);
    }
  }

  /** One compare-and-set round: the write's result, or null when the tracker moved under it. */
  private async round<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
    options: { foldOnly?: boolean },
  ): Promise<WriteResult<R> | null> {
    const tips = await this.resolveTips();
    if (await this.isShallow(tips)) throw shallowHistory(this.location.root);
    const snapshot = await this.snapshotOf(tips);
    const now = this.clock();
    if (spec.idempotency) {
      const replay = await lookupKey(snapshot.source, snapshot.rootTree, spec.op, spec.idempotency, now);
      if (replay) return { result: replay.result as R, commit: null, replayed: true, sealed: false };
    }
    checkTrackerMarker(snapshot.marker);
    const draft = new Draft(snapshot, now, () => this.takenIds(snapshot, tips), this.randomSuffix, this.commentMs, this.options.randomAttemptHandle);
    const outcome = await body(draft);
    const edits = draft.edits();
    if (spec.idempotency) {
      const recorded = await keyEdits(snapshot.source, snapshot.rootTree, spec.op, spec.idempotency, outcome.result, now);
      for (const [file, content] of recorded) edits.set(file, content);
    }
    const commitsFold = options.foldOnly === true && snapshot.parents.length > 1;
    // A purge drops its content from the unpushed segment under its commit, in this same compare-and-set (spec §3).
    const drop = await this.dropUnpushed(tips.local, draft.historyDrops());
    if (edits.size === 0 && !commitsFold) {
      if (!drop) return { result: outcome.result, commit: null, replayed: false, sealed: false };
      // A purge done already whose content history still held: the rewrite alone moves the ref.
      if (drop.tip !== tips.local) {
        const moved = await this.moveRef(tips.local, drop.tip!);
        if (!moved.moved) {
          if (moved.staleLock) throw busy(`a stale lock blocks the tracker ref: ${moved.staleLock.path}`, { stale_lock: moved.staleLock });
          return null;
        }
      }
      return { result: outcome.result, commit: null, replayed: false, sealed: false, history: await this.droppedHistory(drop) };
    }

    // The fold's merged tree becomes real only now, in the write that commits it.
    if (snapshot.virtual) await snapshot.virtual.persist(snapshot.rootTree);
    const tree = (await this.objects.editTree(snapshot.rootTree, edits)) ?? (await this.objects.emptyTree());
    const message = this.message(spec, outcome.issue, outcome.attempt);
    const commit = await this.objects.writeCommit({
      tree,
      parents: drop ? snapshot.parents.map((parent) => (parent === tips.local ? drop.tip! : parent)) : snapshot.parents,
      author: { ...spec.author, when: now },
      committer: { ...spec.author, when: now },
      message,
    });
    const move = await this.moveRef(tips.local, commit);
    if (move.moved) {
      this.commentMs = Math.max(this.commentMs, draft.roundCommentMs ?? 0);
      // The fold this write committed dropped late session records: counted in this machine's doctor stats.
      const drops = snapshot.virtual ? this.foldReports.get(snapshot)?.lateDrops : undefined;
      if (drops && drops.length > 0) await countLateDrops(this.location.commonDir, drops, now).catch(() => {});
      const history = drop ? await this.droppedHistory(drop) : undefined;
      return {
        result: outcome.result,
        commit,
        replayed: false,
        sealed: [...edits.keys()].some(isAttemptEnd),
        ...(outcome.issue ? { issue: outcome.issue } : {}),
        ...(outcome.attempt ? { attempt: outcome.attempt } : {}),
        ...(history ? { history } : {}),
      };
    }
    if (move.staleLock) {
      throw busy(`a stale lock blocks the tracker ref: ${move.staleLock.path}`, { stale_lock: move.staleLock });
    }
    return null;
  }

  async initialize(spec: Omit<WriteSpec, 'op' | 'idempotency'>, options: InitializeOptions = {}): Promise<{ root: string; created: boolean }> {
    const existing = async () => {
      const tips = await this.resolveTips();
      const tip = tips.local ?? tips.remote;
      return tip ? { root: await this.rootOf(tip), created: false } : null;
    };
    const found = options.replace ? null : await existing();
    if (found) return found;
    const now = this.clock();
    const files = new Map<string, Buffer>([
      [FORMAT_FILE, Buffer.from(serializeMarker(V1_MARKER), 'utf8')],
      [GITATTRIBUTES_FILE, Buffer.from(GITATTRIBUTES, 'utf8')],
    ]);
    if (options.settings && options.settings.size > 0) {
      const at = now.toISOString();
      const lines = new Map([...options.settings].map(([key, value]) => [key, settingLine({ value, at, by: spec.author.email })]));
      files.set(SETTINGS_FILE, serializeSettings(lines));
    }
    const tree = await this.objects.editTree(null, files);
    const message = this.message({ ...spec, op: 'init' });
    const commit = await this.objects.writeCommit({
      tree: tree!,
      parents: [],
      author: { ...spec.author, when: now },
      committer: { ...spec.author, when: now },
      message,
    });
    const move = await this.createRef(commit, message.split('\n', 1)[0]!, options.replace === true);
    if (move.moved) return { root: commit, created: true };
    const raced = await existing();
    if (raced) return raced;
    throw busy('could not create the tracker ref');
  }

  /** Subject, blank line, then the trailers (spec §3, Commits). */
  private message(spec: Pick<WriteSpec, 'op' | 'actor'>, issue?: string, attempt?: string): string {
    const trailers = [
      `Grimoire-Actor: ${trailerValue('Grimoire-Actor', JSON.stringify(spec.actor))}`,
      `Grimoire-Op: ${trailerValue('Grimoire-Op', spec.op)}`,
      ...(issue ? [`Grimoire-Issue: ${trailerValue('Grimoire-Issue', issue)}`] : []),
      ...(attempt ? [`Grimoire-Attempt: ${trailerValue('Grimoire-Attempt', attempt)}`] : []),
      `Grimoire-Version: ${trailerValue('Grimoire-Version', this.options.version ?? VERSION)}`,
    ];
    return `grimoire: ${spec.op}${issue ? ` ${issue}` : ''}\n\n${trailers.join('\n')}\n`;
  }

  /**
   * The local tracker tip and every configured remote's remote-tracking
   * tracker tip, by remote name, resolved fresh: never cached across calls
   * (spec §4). They are read through the long-lived object reader, not a new
   * git process: every write resolves them inside the fairness lock, where a
   * process start would be paid once per queued writer.
   */
  private async trackerRefs(): Promise<TrackerRefs> {
    // Taken before git reads any ref, so a packed-refs rewrite it might miss shows here.
    const packedRefs = await packedRefsStamp(this.location.commonDir);
    const { names } = await this.remotes();
    const [local = null, ...tips] = await this.objects.resolveRefs([TRACKER_REF, ...names.map(remoteTrackerRef)], packedRefs);
    const remotes = new Map<string, string>();
    names.forEach((name, i) => {
      const tip = tips[i];
      if (tip) remotes.set(name, tip);
    });
    return { local, remotes };
  }

  /** Both tracker tips, resolved fresh: never cached across calls (spec §4). */
  private async resolveTips(): Promise<Tips> {
    const { local, remotes } = await this.trackerRefs();
    const names = [...remotes.keys()].sort();
    if (names.length === 0) return { local, remote: null };
    // `grimoire.remote`, else the remote that has the tracker (origin first).
    const chosen = (await this.remotes()).chosen ?? (names.includes('origin') ? 'origin' : names[0]!);
    return { local, remote: remotes.get(chosen) ?? null };
  }

  /** The tracker root R the checkout's `.grimoire/config.yml` names, re-read only when the file changes. */
  private async namedRoot(): Promise<string | null> {
    const file = path.join(this.location.root, '.grimoire', 'config.yml');
    const info = await stat(file).catch(() => null);
    const stamp = info ? `${info.mtimeMs}:${info.size}` : 'none';
    if (this.checkoutConfig?.stamp !== stamp) {
      const text = info ? await readFile(file, 'utf8').catch(() => '') : '';
      this.checkoutConfig = { stamp, root: namedTrackerRoot(text) };
    }
    return this.checkoutConfig.root;
  }

  /**
   * NOT_SYNCED unless a tracker is here: with no tracker ref at all, or, when
   * `config.yml` names root R, with no tip whose history holds R (spec §4,
   * Missing tracker). Reads never show an empty tracker in its place.
   */
  private async checkTracker(tips: Tips): Promise<void> {
    const { local, remote } = tips;
    const root = await this.namedRoot();
    if (!local && !remote) throw root ? missingTracker(this.location.root, root, false) : notSynced(this.location.root);
    if (!root) return;
    const shallow = await this.shallowTips(tips);
    for (const tip of [local, remote]) {
      if (!tip) continue;
      // R may lie past a shallow boundary: reads go on, writes refuse as shallow, and sync deepens the history.
      if (shallow.has(tip) || (await this.holdsRoot(tip, root))) return;
    }
    throw missingTracker(this.location.root, root, true);
  }

  /**
   * Whether `tip`'s history holds the commit `root`; memoized, and inherited
   * from a commit already known to hold it, walking back from `tip` (git
   * decides past the walk). Only asked of a tip whose whole history is here,
   * so a no is as final as a yes.
   */
  private async holdsRoot(tip: string, root: string): Promise<boolean> {
    const key = `${root} ${tip}`;
    let holds = this.holds.get(key);
    if (holds === undefined) {
      holds =
        (await this.reaches(tip, (commit) => commit.startsWith(root) || this.holds.get(`${root} ${commit}`) === true)) ||
        (await this.git(['merge-base', '--is-ancestor', root, tip])).code === 0;
      this.holds.set(key, holds);
    }
    return holds;
  }

  /**
   * Whether the tracker's history is shallow here: one of its commits is a
   * shallow boundary, so it reads as a root (spec §4: writes refuse, sync
   * deepens it). Costs a stat unless the clone is shallow.
   */
  private async isShallow(tips: Tips): Promise<boolean> {
    return (await this.shallowTips(tips)).size > 0;
  }

  /** The tips whose history reaches a shallow boundary. */
  private async shallowTips({ local, remote }: Tips): Promise<ReadonlySet<string>> {
    const file = path.join(this.location.commonDir, 'shallow');
    const info = await stat(file).catch(() => null);
    const tips = [...new Set([local, remote].filter((tip): tip is string => tip !== null))];
    const shallow = new Set<string>();
    if (!info || tips.length === 0) return shallow;
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (this.shallowMemo?.stamp !== stamp) {
      const boundary = new Set((await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter((line) => line !== ''));
      this.shallowMemo = { stamp, boundary, reaches: new BoundedMap(1_024) };
    }
    for (const tip of tips) if (await this.reachesBoundary(tip, this.shallowMemo)) shallow.add(tip);
    return shallow;
  }

  /**
   * Whether `tip`'s history reaches a shallow boundary; memoized. Walked back
   * from `tip` to a boundary commit or to commits already answered, so a tip
   * that writes moved on by a commit or a few costs cached reads, not a git
   * process inside the fairness lock; git decides past the walk.
   */
  private async reachesBoundary(tip: string, memo: ShallowMemo): Promise<boolean> {
    let reaches = memo.reaches.get(tip);
    if (reaches === undefined) {
      reaches = await this.walk(
        tip,
        (commit) => memo.boundary.has(commit) || memo.reaches.get(commit) === true,
        (commit) => memo.reaches.get(commit) === false,
      );
      if (reaches === undefined) {
        const run = await this.git(['rev-list', '--max-parents=0', tip]);
        const roots = run.stdout.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
        reaches = roots.some((root) => memo.boundary.has(root));
      }
      memo.reaches.set(tip, reaches);
    }
    return reaches;
  }

  /** The clone's remotes and `grimoire.remote`, re-read only when its config file changes. */
  private async remotes(): Promise<RemoteConfig> {
    const info = await stat(path.join(this.location.commonDir, 'config')).catch(() => null);
    const stamp = info ? `${info.mtimeMs}:${info.size}` : 'none';
    if (this.remoteConfig?.stamp !== stamp) {
      const run = await this.git(['config', '-z', '--get-regexp', '^(remote\\..+|grimoire\\.remote)$']);
      let chosen: string | null = null;
      const names = new Set<string>();
      // `key\nvalue\0` per entry (`key\0` for a key with no value); exit 1: no such keys.
      for (const entry of run.code === 0 ? run.stdout.toString('utf8').split('\0') : []) {
        const newline = entry.indexOf('\n');
        const key = newline < 0 ? entry : entry.slice(0, newline);
        if (key === 'grimoire.remote') chosen = newline < 0 ? null : entry.slice(newline + 1).trim() || null;
        const remote = /^remote\.(.+)\.[^.]+$/.exec(key)?.[1];
        if (remote) names.add(remote);
      }
      if (chosen) names.add(chosen);
      this.remoteConfig = { stamp, value: { chosen, names: [...names] } };
    }
    return this.remoteConfig.value;
  }

  /**
   * The snapshot a read shows: the local tip, or the remote-tracking tip when
   * it is the only one or strictly ahead, or, when the two diverged, their
   * fold, computed in memory with `merge-base` and object reads only. Memoized
   * by the tip pair.
   */
  private async snapshotOf({ local, remote }: Tips): Promise<Snapshot> {
    await this.checkTracker({ local, remote });
    if (!local || !remote || local === remote) return this.snapshotAt(local ?? remote!);
    // One merge-base answers all three cases: remote ahead, local ahead, or diverged (and the fold's bases).
    const bases = await this.mergeBases([local, remote]);
    if (bases.length === 1 && bases[0] === local) return this.snapshotAt(remote);
    if (bases.length === 1 && bases[0] === remote) return this.snapshotAt(local);
    const key = `${local}+${remote}`;
    let snapshot = this.snapshots.get(key);
    if (!snapshot) {
      // A remote this release can't run against gives UPGRADE_REQUIRED, with no fold.
      const { tree } = await this.objects.commit(remote);
      const marker = await this.objects.fileAt(tree, FORMAT_FILE);
      checkTrackerMarker(marker ? parseMarker(marker.toString('utf8')) : null);
      const virtual = new VirtualObjects(this.objects);
      const report: FoldReport = { lateDrops: [] };
      const merged = await foldCommits(virtual, (commits) => this.mergeBases(commits), local, remote, report);
      snapshot = await this.loader.folded(local, remote, merged, virtual);
      this.foldReports.set(snapshot, report);
      this.snapshots.set(key, snapshot);
    }
    return snapshot;
  }

  private async snapshotAt(tip: string): Promise<Snapshot> {
    let snapshot = this.snapshots.get(tip);
    if (!snapshot) {
      snapshot = await this.loader.load(tip);
      this.snapshots.set(tip, snapshot);
    }
    return snapshot;
  }

  /** `git merge-base --all`: the bases of the first commit and (a merge of) the rest. */
  private async mergeBases(commits: readonly string[]): Promise<readonly string[]> {
    const key = commits.join(' ');
    let bases = this.bases.get(key);
    if (!bases && commits.length === 2 && (await this.descends(commits[0]!, commits[1]!))) {
      bases = [commits[1]!];
      this.bases.set(key, bases);
    }
    if (!bases) {
      const run = await this.git(['merge-base', '--all', ...commits]);
      // Exit 1 with no output: unrelated histories, so the fold has no base (unless a shallow boundary hid it).
      if (run.code !== 0 && run.code !== 1) {
        // The commits or their history are missing here (a partial or shallow clone).
        throw new GrimoireError('NOT_SYNCED', `the tracker history is incomplete in this clone: ${run.stderr.trim()}`, {
          remedy: 'run `grimoire sync` to fetch the missing tracker history',
        });
      }
      bases = run.stdout.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
      if (bases.length === 0 && (await this.shallowHistory(commits))) {
        // A shallow boundary hides the base: folding over nothing would duplicate and resurrect.
        throw new GrimoireError('NOT_SYNCED', 'the tracker history is shallow in this clone, so the fold has no merge base', {
          remedy: 'run `grimoire sync` to deepen the tracker history',
        });
      }
      this.bases.set(key, bases);
    }
    return bases;
  }

  /**
   * Whether `tip` descends from `ancestor`: walked back from `tip` to
   * `ancestor` or to a commit already known to descend from it (`reaches`).
   */
  private descends(tip: string, ancestor: string): Promise<boolean> {
    return this.reaches(
      tip,
      (commit) => commit === ancestor || this.bases.get(`${commit} ${ancestor}`)?.join(' ') === ancestor,
    );
  }

  /**
   * Whether walking back from `tip` meets a commit `found` accepts. False
   * too when the walk gives up: a git process decides then (see `walk`).
   */
  private async reaches(tip: string, found: (commit: string) => boolean): Promise<boolean> {
    return (await this.walk(tip, found)) === true;
  }

  /**
   * Walks back from `tip`: true when it meets a commit `found` accepts, false
   * when every line of its history ended (at a root, or at a commit `settled`
   * says needs no walk past it) without meeting one, and undefined when the
   * walk gave up (after ANCESTRY_WALK commits) or couldn't read a commit: a
   * git process decides then. Writes extend the tracker a commit or a few at
   * a time, so a new tip usually takes a few cached reads here instead of a
   * git process inside the fairness lock.
   */
  private async walk(
    tip: string,
    found: (commit: string) => boolean,
    settled: (commit: string) => boolean = () => false,
  ): Promise<boolean | undefined> {
    const seen = new Set<string>();
    try {
      for (let frontier = [tip]; frontier.length > 0; ) {
        if (frontier.some(found)) return true;
        if (seen.size >= ANCESTRY_WALK) return undefined;
        for (const commit of frontier) seen.add(commit);
        const open = frontier.filter((commit) => !settled(commit));
        const headers = await Promise.all(open.map((commit) => this.objects.commit(commit)));
        frontier = [...new Set(headers.flatMap((header) => header.parents))].filter((commit) => !seen.has(commit));
      }
      return false;
    } catch (error) {
      // A stuck reader ends the round: no other git gets to decide in its place.
      if (error instanceof GitStalledError) throw error;
      // A commit missing here (a shallow or partial clone): git reports it.
      return undefined;
    }
  }

  /** Whether the history of `commits` stops at a shallow boundary rather than at its own roots. */
  private async shallowHistory(commits: readonly string[]): Promise<boolean> {
    const listed = await readFile(path.join(this.location.commonDir, 'shallow'), 'utf8').catch(() => '');
    const shallow = new Set(listed.split(/\r?\n/).filter((line) => line !== ''));
    if (shallow.size === 0) return false;
    // A shallow commit shows as a root: its parents are cut off.
    const run = await this.git(['rev-list', '--max-parents=0', ...commits]);
    if (run.code !== 0) return true;
    return run.stdout.toString('utf8').split(/\r?\n/).some((root) => shallow.has(root));
  }

  /** Ids taken on either tip (live, deleted or forwarded), for minting. */
  private async takenIds(snapshot: Snapshot, tips: Tips): Promise<ReadonlySet<string>> {
    const taken = new Set([...snapshot.ids, ...snapshot.retiredIds].map(bareId));
    for (const tip of [tips.local, tips.remote]) {
      if (tip && tip !== snapshot.tip) for (const id of await this.loader.takenIds(tip)) taken.add(id);
    }
    return taken;
  }

  private async rootOf(tip: string): Promise<string> {
    const run = await this.git(['rev-list', '--first-parent', '--max-parents=0', tip]);
    return run.stdout.toString('utf8').trim().split(/\r?\n/).pop()!;
  }

  /**
   * `update <ref> <new> <old>`: the compare-and-set that publishes a round,
   * through the long-lived updater (no process start inside the fairness lock).
   */
  private async moveRef(old: string | null, commit: string): Promise<RefMove> {
    return this.refMove(await this.updater.update(TRACKER_REF, commit, old ?? zeroOid(this.location.objectFormat)));
  }

  /**
   * Creates the tracker ref with an updater of its own, so its reflog entry
   * carries `subject`; `replace` moves an existing one (its old tip stays in
   * the reflog).
   */
  private async createRef(commit: string, subject: string, replace = false): Promise<RefMove> {
    return this.refMove(await this.updateRefOnce(TRACKER_REF, commit, replace ? null : zeroOid(this.location.objectFormat), subject));
  }

  /**
   * Moves `ref` from `old` (the zero oid: create it; null: whatever it holds)
   * with a git of its own whose reflog entry says `reflogMessage`. Like every
   * update, it settles whether the ref moved even when that git gets stuck,
   * and cleans up after it.
   */
  private async updateRefOnce(ref: string, next: string, old: string | null, reflogMessage: string): Promise<RefUpdate> {
    const updater = new RefUpdater(this.location, reflogMessage, this.updaterStalls());
    try {
      return await updater.update(ref, next, old);
    } finally {
      await updater.close();
    }
  }

  private refMove(update: RefUpdate): RefMove | Promise<RefMove> {
    if (update.moved) return { moved: true };
    // No reason from git (its process died, or packed-refs kept changing): the ref did not move, so retry the round.
    if (update.stderr.trim() === '') return { moved: false };
    return this.failedMove(update.stderr);
  }

  /** Why a ref update failed: lost the compare-and-set, or a ref lock (stale past ~30 s) blocked it. */
  private async failedMove(stderr: string): Promise<RefMove> {
    if (/but expected|reference already exists|unable to resolve reference/i.test(stderr)) return { moved: false };
    // A ref directory this process may not write (a sandboxed shell) is no lock to wait out.
    if (/permission denied|operation not permitted|read-only file system/i.test(stderr)) {
      const reason = stderr.trim().split('\n').pop()?.trim() ?? '';
      throw new GrimoireError('NOT_WRITABLE', `this process can't write grimoire's live store: git could not update ${TRACKER_REF} (${reason})`, {});
    }
    const lockPath =
      /Unable to create '([^']+\.lock)'/.exec(stderr)?.[1] ??
      (/cannot lock references/i.test(stderr)
        ? path.join(this.location.commonDir, 'reftable', 'tables.list.lock')
        : null);
    if (!lockPath) throw new Error(`git update-ref failed: ${stderr.trim()}`);
    const info = await stat(lockPath).catch(() => null);
    const age = info ? Date.now() - info.mtimeMs : 0;
    if (age > STALE_REF_LOCK_MS) {
      return { moved: false, staleLock: { path: path.normalize(lockPath), age_ms: Math.round(age) } };
    }
    return { moved: false };
  }
}
