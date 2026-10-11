import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { VERSION } from '../version';
import { zeroOid } from '../git/objects';
import { locateRepo, type RepoLocation } from '../git/repo';
import { runGit } from '../git/run';
import { bareId, randomIdSuffix } from './ids';
import { lookupKey, keyEdits, type Idempotency } from './keys';
import { FORMAT_FILE, GITATTRIBUTES, GITATTRIBUTES_FILE, remoteTrackerRef, TRACKER_REF } from './layout';
import { FairnessLock, sleep, Turnstile } from './locks';
import { foldCommits } from './fold';
import { checkTrackerMarker, parseMarker, serializeMarker, V1_MARKER } from './marker';
import { BoundedMap, TrackerObjects, VirtualObjects } from './objects';
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
  /** Stops the store's git process. */
  close(): Promise<void>;
}

export const DEFAULT_BUDGET_MS = 10_000;
/** A ref lock older than this is stale: BUSY with `details.stale_lock` (spec §4). */
export const STALE_REF_LOCK_MS = 30_000;

interface Tips {
  local: string | null;
  remote: string | null;
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
  private remoteConfig: { stamp: string; value: string | null } | null = null;
  /** The latest comment time this store wrote: comment times never go back within a process. */
  private commentMs = 0;

  constructor(
    readonly location: RepoLocation,
    private readonly options: TrackerOptions,
  ) {
    this.objects = new TrackerObjects(location.root, path.join(location.commonDir, 'objects'), location.objectFormat);
    this.loader = new SnapshotLoader(this.objects);
    this.fairness = new FairnessLock(location.commonDir);
    this.clock = options.clock ?? (() => new Date());
    this.randomSuffix = options.randomIdSuffix ?? randomIdSuffix;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  close(): Promise<void> {
    return this.objects.close();
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

  async fold(spec: Omit<WriteSpec, 'op' | 'idempotency'>): Promise<{ commit: string | null }> {
    const write = await this.transact({ ...spec, op: 'fold' }, () => ({ result: null }), { foldOnly: true });
    return { commit: write.commit };
  }

  private async rounds<R>(
    spec: WriteSpec,
    body: (draft: TrackerDraft) => WriteOutcome<R> | Promise<WriteOutcome<R>>,
    deadline: number,
    options: { foldOnly?: boolean },
  ): Promise<WriteResult<R>> {
    for (;;) {
      const tips = await this.resolveTips();
      const snapshot = await this.snapshotOf(tips);
      const now = this.clock();
      if (spec.idempotency) {
        const replay = await lookupKey(snapshot.source, snapshot.rootTree, spec.op, spec.idempotency, now);
        if (replay) return { result: replay.result as R, commit: null, replayed: true };
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
      if (edits.size === 0 && !commitsFold) return { result: outcome.result, commit: null, replayed: false };

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
      const move = await this.moveRef(tips.local, commit, message.split('\n', 1)[0]!);
      if (move.moved) {
        this.commentMs = Math.max(this.commentMs, draft.roundCommentMs ?? 0);
        return { result: outcome.result, commit, replayed: false };
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
    const move = await this.moveRef(null, commit, message.split('\n', 1)[0]!);
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

  /** Both tracker tips, resolved fresh: never cached across calls (spec §4). */
  private async resolveTips(): Promise<Tips> {
    const run = await runGit(this.location.root, [
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      TRACKER_REF,
      'refs/remotes/*/grimoire/tracker',
    ]);
    if (run.code !== 0) throw new Error(`git for-each-ref failed: ${run.stderr.trim()}`);
    const refs = new Map<string, string>();
    for (const line of run.stdout.toString('utf8').split(/\r?\n/)) {
      const space = line.indexOf(' ');
      if (space > 0) refs.set(line.slice(space + 1), line.slice(0, space));
    }
    const local = refs.get(TRACKER_REF) ?? null;
    const remotes = [...refs.keys()]
      .map((ref) => /^refs\/remotes\/(.+)\/grimoire\/tracker$/.exec(ref)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();
    if (remotes.length === 0) return { local, remote: null };
    // `grimoire.remote`, else the remote that has the tracker (origin first).
    const chosen = (await this.configuredRemote()) ?? (remotes.includes('origin') ? 'origin' : remotes[0]!);
    return { local, remote: refs.get(remoteTrackerRef(chosen)) ?? null };
  }

  /** `git config grimoire.remote`, re-read only when the clone's config file changes. */
  private async configuredRemote(): Promise<string | null> {
    const info = await stat(path.join(this.location.commonDir, 'config')).catch(() => null);
    const stamp = info ? `${info.mtimeMs}:${info.size}` : 'none';
    if (this.remoteConfig?.stamp !== stamp) {
      const run = await runGit(this.location.root, ['config', '--get', 'grimoire.remote']);
      const value = run.code === 0 ? run.stdout.toString('utf8').trim() || null : null;
      this.remoteConfig = { stamp, value };
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
    if (!local && !remote) throw notSynced(this.location.root);
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

  /** `update-ref <new> <old>`: the compare-and-set that publishes a round. */
  private async moveRef(old: string | null, commit: string, subject: string): Promise<RefMove> {
    const run = await runGit(this.location.root, [
      'update-ref',
      '--create-reflog',
      '-m',
      subject,
      TRACKER_REF,
      commit,
      old ?? zeroOid(this.location.objectFormat),
    ]);
    if (run.code === 0) return { moved: true };
    const stderr = run.stderr;
    if (/but expected|reference already exists|unable to resolve reference/i.test(stderr)) return { moved: false };
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
