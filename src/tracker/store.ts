import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { VERSION } from '../version';
import { zeroOid } from '../git/objects';
import { locateRepo, type RepoLocation } from '../git/repo';
import { packedRefsStamp, RefUpdater } from '../git/refs';
import { runGit } from '../git/run';
import { bareId, randomIdSuffix } from './ids';
import { lookupKey, keyEdits, type Idempotency } from './keys';
import { FORMAT_FILE, GITATTRIBUTES, GITATTRIBUTES_FILE, isAttemptEnd, remoteTrackerRef, TRACKER_REF } from './layout';
import { FairnessLock, sleep, Turnstile } from './locks';
import { foldCommits } from './fold';
import { checkTrackerMarker, parseMarker, serializeMarker, V1_MARKER } from './marker';
import { BoundedMap, TrackerObjects, VirtualObjects } from './objects';
import { syncTracker, type SyncOutcome, type SyncSpec, type TrackerRefs } from './sync';
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
}

export interface TrackerOptions {
  /** `Grimoire-Version` (default: this release). */
  readonly version?: string;
  readonly clock?: () => Date;
  /** Draws an id suffix of the given length (default: crypto-random Crockford). */
  readonly randomIdSuffix?: (length: number) => string;
  /** How long one write may keep retrying before BUSY (default ~10 s). */
  readonly budgetMs?: number;
}

export interface TrackerStore {
  readonly location: RepoLocation;
  /**
   * The current view: refs resolved fresh on every call, the view memoized by
   * the tip pair. Throws NOT_SYNCED without a tracker and UPGRADE_REQUIRED
   * when its `format` marker is outside this release's range.
   */
  read(): Promise<TrackerView>;
  /** The store's clock: the instant reads judge staleness by. */
  now(): Date;
  /**
   * Runs a write as compare-and-set rounds. Each round looks up the
   * idempotency key, checks the marker, re-runs `body` on a fresh draft, and
   * commits the draft's edits as one commit with a compare-and-set ref move.
   * `body` may run several times and must only touch the draft. Any error
   * means the ref did not move. BUSY after the budget, or at once for a ref
   * lock older than ~30 s (`details.stale_lock`).
   */
  transact<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
  ): Promise<WriteResult<R>>;
  /**
   * Creates the tracker ref as an orphan history holding the v1 `format`
   * marker, unless a local or remote-tracking tracker exists already. Returns
   * the root commit.
   */
  initialize(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ root: string; created: boolean }>;
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

export const DEFAULT_BUDGET_MS = 10_000;
/** A ref lock older than this is stale: BUSY with `details.stale_lock` (spec §4). */
export const STALE_REF_LOCK_MS = 30_000;
/** How many commits `reaches` walks before it leaves the question to a git process. */
const ANCESTRY_WALK = 128;

interface Tips {
  local: string | null;
  remote: string | null;
}

/** What the clone's config says about remotes. */
interface RemoteConfig {
  /** `grimoire.remote`, or null. */
  readonly chosen: string | null;
  /** The configured remotes' names, plus `grimoire.remote`'s: whose remote-tracking tracker counts. */
  readonly names: readonly string[];
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
  return new GitTrackerStore(await locateRepo(dir), options);
}

class GitTrackerStore implements TrackerStore {
  private readonly objects: TrackerObjects;
  private readonly loader: SnapshotLoader;
  private readonly snapshots = new BoundedMap<string, Snapshot>(16);
  private readonly bases = new BoundedMap<string, readonly string[]>(256);
  private readonly turnstile = new Turnstile();
  private readonly fairness: FairnessLock;
  private readonly clock: () => Date;
  private readonly randomSuffix: (length: number) => string;
  private readonly budgetMs: number;
  /** Moves the tracker ref for writes, through one long-lived git. */
  private readonly updater: RefUpdater;
  private remoteConfig: { stamp: string; value: RemoteConfig } | null = null;
  private checkoutConfig: { stamp: string; root: string | null } | null = null;
  /** Whether a tip's history holds a root commit, by `<root> <tip>`. */
  private readonly holds = new BoundedMap<string, boolean>(1_024);
  private shallowMemo: { key: string; tips: ReadonlySet<string> } | null = null;
  /** The latest comment time this store wrote: comment times never go back within a process. */
  private commentMs = 0;

  constructor(
    readonly location: RepoLocation,
    private readonly options: TrackerOptions,
  ) {
    this.objects = new TrackerObjects(location.root, path.join(location.commonDir, 'objects'), location.objectFormat);
    this.loader = new SnapshotLoader(this.objects);
    this.fairness = new FairnessLock(location.commonDir);
    this.updater = new RefUpdater(location.root, 'grimoire: write', () => packedRefsStamp(location.commonDir));
    this.clock = options.clock ?? (() => new Date());
    this.randomSuffix = options.randomIdSuffix ?? randomIdSuffix;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  async close(): Promise<void> {
    await Promise.all([this.objects.close(), this.updater.close()]);
  }

  now(): Date {
    return this.clock();
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
      await this.prefetch();
      const lock = await this.fairness.acquire(deadline);
      if (!lock) throw busy('another grimoire write held the tracker for the whole write budget');
      try {
        return await this.rounds(spec, body, deadline, options);
      } finally {
        await lock.release();
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
      await this.snapshotOf(await this.resolveTips());
    } catch {
      // The round resolves and loads again, and reports what went wrong.
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
        trackerRefs: () => this.trackerRefs(),
        isShallow: async () => this.isShallow(await this.resolveTips()),
        fold: (foldSpec) => this.fold(foldSpec),
      },
      spec,
    );
  }

  private async rounds<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
    deadline: number,
    options: { foldOnly?: boolean },
  ): Promise<WriteResult<R>> {
    for (;;) {
      const tips = await this.resolveTips();
      if (await this.isShallow(tips)) throw shallowHistory(this.location.root);
      const snapshot = await this.snapshotOf(tips);
      const now = this.clock();
      if (spec.idempotency) {
        const replay = await lookupKey(snapshot.source, snapshot.rootTree, spec.op, spec.idempotency, now);
        if (replay) return { result: replay.result as R, commit: null, replayed: true, sealed: false };
      }
      checkTrackerMarker(snapshot.marker);
      const draft = new Draft(snapshot, now, () => this.takenIds(snapshot, tips), this.randomSuffix, this.commentMs);
      const outcome = await body(draft);
      const edits = draft.edits();
      if (spec.idempotency) {
        const recorded = await keyEdits(snapshot.source, snapshot.rootTree, spec.op, spec.idempotency, outcome.result, now);
        for (const [file, content] of recorded) edits.set(file, content);
      }
      const commitsFold = options.foldOnly === true && snapshot.parents.length > 1;
      if (edits.size === 0 && !commitsFold) return { result: outcome.result, commit: null, replayed: false, sealed: false };

      // The fold's merged tree becomes real only now, in the write that commits it.
      if (snapshot.virtual) await snapshot.virtual.persist(snapshot.rootTree);
      const tree = (await this.objects.editTree(snapshot.rootTree, edits)) ?? (await this.objects.emptyTree());
      const message = this.message(spec, outcome.issue, outcome.attempt);
      const commit = await this.objects.writeCommit({
        tree,
        parents: snapshot.parents,
        author: { ...spec.author, when: now },
        committer: { ...spec.author, when: now },
        message,
      });
      const move = await this.moveRef(tips.local, commit);
      if (move.moved) {
        this.commentMs = Math.max(this.commentMs, draft.roundCommentMs ?? 0);
        return { result: outcome.result, commit, replayed: false, sealed: [...edits.keys()].some(isAttemptEnd) };
      }
      if (move.staleLock) {
        throw busy(`a stale lock blocks the tracker ref: ${move.staleLock.path}`, { stale_lock: move.staleLock });
      }
      if (Date.now() >= deadline) throw busy('the tracker kept moving for the whole write budget');
      await sleep(5 + Math.random() * 20);
    }
  }

  async initialize(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ root: string; created: boolean }> {
    const existing = async () => {
      const tips = await this.resolveTips();
      const tip = tips.local ?? tips.remote;
      return tip ? { root: await this.rootOf(tip), created: false } : null;
    };
    const found = await existing();
    if (found) return found;
    const now = this.clock();
    const tree = await this.objects.editTree(
      null,
      new Map([
        [FORMAT_FILE, Buffer.from(serializeMarker(V1_MARKER), 'utf8')],
        [GITATTRIBUTES_FILE, Buffer.from(GITATTRIBUTES, 'utf8')],
      ]),
    );
    const message = this.message({ ...spec, op: 'init' });
    const commit = await this.objects.writeCommit({
      tree: tree!,
      parents: [],
      author: { ...spec.author, when: now },
      committer: { ...spec.author, when: now },
      message,
    });
    const move = await this.createRef(commit, message.split('\n', 1)[0]!);
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
        (await runGit(this.location.root, ['merge-base', '--is-ancestor', root, tip])).code === 0;
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

  /** The tips whose history reaches a shallow boundary, memoized by the `shallow` file and the tips. */
  private async shallowTips({ local, remote }: Tips): Promise<ReadonlySet<string>> {
    const file = path.join(this.location.commonDir, 'shallow');
    const info = await stat(file).catch(() => null);
    const tips = [...new Set([local, remote].filter((tip): tip is string => tip !== null))];
    if (!info || tips.length === 0) return new Set();
    const key = `${info.mtimeMs}:${info.size}:${tips.join(' ')}`;
    if (this.shallowMemo?.key !== key) {
      const boundary = new Set((await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).filter((line) => line !== ''));
      const shallow = new Set<string>();
      for (const tip of tips) {
        const run = await runGit(this.location.root, ['rev-list', '--max-parents=0', tip]);
        const roots = run.stdout.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
        if (roots.some((root) => boundary.has(root))) shallow.add(tip);
      }
      this.shallowMemo = { key, tips: shallow };
    }
    return this.shallowMemo.tips;
  }

  /** The clone's remotes and `grimoire.remote`, re-read only when its config file changes. */
  private async remotes(): Promise<RemoteConfig> {
    const info = await stat(path.join(this.location.commonDir, 'config')).catch(() => null);
    const stamp = info ? `${info.mtimeMs}:${info.size}` : 'none';
    if (this.remoteConfig?.stamp !== stamp) {
      const run = await runGit(this.location.root, ['config', '-z', '--get-regexp', '^(remote\\..+|grimoire\\.remote)$']);
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
      const merged = await foldCommits(virtual, (commits) => this.mergeBases(commits), local, remote);
      snapshot = await this.loader.folded(local, remote, merged, virtual);
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
      const run = await runGit(this.location.root, ['merge-base', '--all', ...commits]);
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
   * when the walk gives up (after ANCESTRY_WALK commits) or can't read a
   * commit: a git process decides then. Writes extend the tracker a commit or
   * a few at a time, so a new tip usually takes a few cached reads here
   * instead of a git process inside the fairness lock.
   */
  private async reaches(tip: string, found: (commit: string) => boolean): Promise<boolean> {
    const seen = new Set<string>();
    try {
      for (let frontier = [tip]; frontier.length > 0 && seen.size < ANCESTRY_WALK; ) {
        if (frontier.some(found)) return true;
        for (const commit of frontier) seen.add(commit);
        const headers = await Promise.all(frontier.map((commit) => this.objects.commit(commit)));
        frontier = [...new Set(headers.flatMap((header) => header.parents))].filter((commit) => !seen.has(commit));
      }
    } catch {
      // A commit missing here (a shallow or partial clone): git reports it.
    }
    return false;
  }

  /** Whether the history of `commits` stops at a shallow boundary rather than at its own roots. */
  private async shallowHistory(commits: readonly string[]): Promise<boolean> {
    const listed = await readFile(path.join(this.location.commonDir, 'shallow'), 'utf8').catch(() => '');
    const shallow = new Set(listed.split(/\r?\n/).filter((line) => line !== ''));
    if (shallow.size === 0) return false;
    // A shallow commit shows as a root: its parents are cut off.
    const run = await runGit(this.location.root, ['rev-list', '--max-parents=0', ...commits]);
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
    const run = await runGit(this.location.root, ['rev-list', '--first-parent', '--max-parents=0', tip]);
    return run.stdout.toString('utf8').trim().split(/\r?\n/).pop()!;
  }

  /**
   * `update <ref> <new> <old>`: the compare-and-set that publishes a round,
   * through the long-lived updater (no process start inside the fairness lock).
   */
  private async moveRef(old: string | null, commit: string): Promise<RefMove> {
    const update = await this.updater.update(TRACKER_REF, commit, old ?? zeroOid(this.location.objectFormat));
    if (update.moved) return { moved: true };
    // No reason from git (its process died, or packed-refs kept changing): the ref did not move, so retry the round.
    if (update.stderr.trim() === '') return { moved: false };
    return this.failedMove(update.stderr);
  }

  /** Creates the tracker ref with a process of its own, so its reflog entry carries `subject`. */
  private async createRef(commit: string, subject: string): Promise<RefMove> {
    const run = await runGit(this.location.root, [
      'update-ref',
      '--create-reflog',
      '-m',
      subject,
      TRACKER_REF,
      commit,
      zeroOid(this.location.objectFormat),
    ]);
    return run.code === 0 ? { moved: true } : this.failedMove(run.stderr);
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
