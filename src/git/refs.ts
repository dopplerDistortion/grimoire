import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanGitEnv, GIT_STALL_MS, GitStalledError, killTree, NO_HOOKS, runGit, stallOf, type StallLimit } from './run';

/**
 * Whether the ref moved. When it didn't, `stderr` is git's reason (a lost
 * compare-and-set, a ref lock, …), or empty when git gave none: its process
 * died, or packed-refs kept changing under the update. Either way the ref
 * did not move, so the caller may retry.
 */
export type RefUpdate = { readonly moved: true } | { readonly moved: false; readonly stderr: string };

interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  /** The `packedRefsStamp` taken just before git started. */
  readonly packedRefs: string;
  readonly stderr: Buffer[];
  stdout: string;
  /** The transaction in flight: told each stdout line, and told when git exits. */
  onLine: ((line: string) => void) | null;
  onExit: (() => void) | null;
  exited: boolean;
  /** Resolves once git has exited and let go of its pipes. */
  readonly closed: Promise<void>;
  /** When the updater killed it (it is told nothing more then), or null. */
  killedAt: number | null;
  /** The identity of the ref lock git said it holds (`prepare: ok`), while it holds it. */
  held: { readonly path: string; readonly identity: string } | null;
}

/** How one transaction on a session ended. */
type Attempt =
  | { readonly kind: 'moved' }
  /** git refused the update and exited, saying why. */
  | { readonly kind: 'refused'; readonly stderr: string }
  /**
   * The ref did not move, for no reason of git's: packed-refs changed under
   * git (so its check of the old value can't be trusted, and it aborted), or
   * its process died before it was told to commit.
   */
  | { readonly kind: 'lost' }
  /** The process died after it was told to commit: the ref may have moved. */
  | { readonly kind: 'unknown' }
  /** git answered nothing for `stallMs` before it was told to commit, and was killed: the ref did not move. */
  | { readonly kind: 'stalled'; readonly stallMs: number };

/** How many transactions an update may lose (see `Attempt`) before it gives up. */
const ATTEMPTS = 3;

/**
 * How long a killed git may take to exit before the lock it may have left is
 * given up on (later updates meet it as any other ref lock: BUSY, then
 * `stale_lock` once it is ~30 s old). A kill on Windows starts `taskkill`,
 * which on a loaded machine can take a second or more. Waiting costs no BUSY
 * its time: the update that killed the git doesn't wait for it. A git killed
 * once told to commit gets as long before whether the ref moved is given up
 * on: only its exit lets that be found out.
 */
const EXIT_AFTER_KILL_MS = 5_000;

export interface RefUpdaterOptions {
  /** The repository's `packedRefsStamp`; by default, taken of the common dir's packed-refs. */
  readonly packedRefs?: () => Promise<string>;
  /** How long git may take over a step before it is killed as stuck; default GIT_STALL_MS. */
  readonly stallMs?: StallLimit;
  /**
   * The same, for the waits that cost more than time when cut short: git's
   * answer once told to commit (killed, whether the ref moved must be found
   * out), the git that finds that out, and a killed or ending git's exit
   * (its ref lock can be removed only once it is gone); default `stallMs`.
   */
  readonly settleMs?: StallLimit;
}

/**
 * One long-lived `git update-ref --stdin` per repository: each compare-and-set
 * is its own transaction (`start`, `update <ref> <new> <old>`, `prepare`, then
 * `commit` or `abort`), so moving a ref costs a pipe round trip, not a
 * process. git exits on a failed transaction; the next update starts a new
 * process. Updates run one at a time, in call order. Every update gets the
 * same reflog message.
 *
 * git checks the old value against the loose ref, read fresh, or else against
 * its cached packed-refs, which it trusts while the file's stat looks
 * unchanged to it: on Windows, while the size and the whole second of the
 * mtime stay the same. A process that outlived a packed-refs rewrite could
 * take a stale value for the current one and let a lost update through. So a
 * new packed-refs stamp gets a new process, and once `prepare` has locked the
 * ref (nothing can move it then), the stamp is taken again: when it changed
 * since git started, the transaction is aborted and retried on a new process.
 *
 * git has the stall time to answer each step (the check under its lock is
 * grimoire's own, timed apart). One that doesn't is killed (with its tree on
 * Windows) and the next update starts a new one. Stuck before it was told to
 * commit, the ref did not move: the update fails with GitStalledError (BUSY).
 * Stuck after (given the settle time, which may be longer), the ref may have
 * moved: a new git is asked whether it did, and only when that can't be told
 * either does the update fail with a plain Error, which promises nothing
 * (ADR 0012). A killed git leaves its ref lock behind (a kill skips git's
 * own clean-up), which would refuse every later update; once that git has
 * exited (it gets EXIT_AFTER_KILL_MS), the lock it left is removed. The update
 * that killed it doesn't wait for that, so its BUSY comes on time; the next
 * update waits for it (a stall time at most, or BUSY), and never starts a
 * transaction before it is done: the lock is told apart by its content, which
 * a retried update's identical commit would share.
 */
export class RefUpdater {
  private session: Session | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** Sessions whose git is exiting. */
  private readonly ending = new Set<Promise<void>>();
  /** Removing the ref locks killed or dead gits left, once they have exited; null when there is nothing to remove. */
  private cleanup: Promise<void> | null = null;
  private closed = false;
  private readonly packedRefs: () => Promise<string>;
  private readonly stall: StallLimit;
  private readonly settle: StallLimit;
  private reftable: Promise<boolean> | null = null;

  constructor(
    private readonly location: { readonly root: string; readonly commonDir: string },
    private readonly reflogMessage: string,
    options: RefUpdaterOptions = {},
  ) {
    this.packedRefs = options.packedRefs ?? (() => packedRefsStamp(location.commonDir));
    this.stall = options.stallMs ?? GIT_STALL_MS;
    this.settle = options.settleMs ?? this.stall;
  }

  /**
   * Moves `ref` from `old` (the zero oid: create it; null: whatever it
   * holds) to `next`, atomically.
   * After `close`, the update still runs, on a git that exits right after it.
   * GitStalledError: git got stuck before it could move the ref, or a git
   * killed before it hasn't exited for a stall time (its lock may be left).
   */
  update(ref: string, next: string, old: string | null): Promise<RefUpdate> {
    const run = this.tail.then(() => this.transact(ref, next, old)).finally(() => {
      if (this.closed && this.session) this.end(this.session);
      if (this.closed) this.session = null;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  /** Starts git ahead of the next update, unless the right one is running already. */
  warm(): Promise<void> {
    const run = this.tail.then(async () => {
      const packedRefs = await this.packedRefs();
      if (!this.closed) this.ensureSession(packedRefs);
    });
    const settled = run.catch(() => {});
    this.tail = settled;
    return settled;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.cleanup;
    if (this.session) this.end(this.session);
    this.session = null;
    await Promise.all(this.ending);
  }

  /**
   * Lets a session's git exit (aborting any open transaction); Node stays
   * alive until it has. One still running a stall time later is killed.
   */
  private end(session: Session): void {
    if (session.exited) return;
    setActive(session, true);
    const stuck = setTimeout(() => killTree(session.child), stallOf(this.settle));
    const exited: Promise<void> = session.closed.finally(() => {
      clearTimeout(stuck);
      this.ending.delete(exited);
    });
    this.ending.add(exited);
    session.child.stdin.end();
  }

  private async transact(ref: string, next: string, old: string | null): Promise<RefUpdate> {
    for (let attempt = 1; ; attempt++) {
      await this.cleaned();
      const session = this.ensureSession(await this.packedRefs());
      let result: Attempt;
      try {
        result = await this.attempt(session, ref, next, old);
        if (result.kind === 'unknown') result = (await this.landed(ref, next)) ? { kind: 'moved' } : { kind: 'lost' };
      } catch (error) {
        this.cleanUp(session, ref, next);
        throw error;
      }
      if (result.kind === 'moved') return { moved: true };
      if (result.kind === 'refused') return { moved: false, stderr: result.stderr };
      this.cleanUp(session, ref, next);
      if (result.kind === 'stalled') throw new GitStalledError('update-ref --stdin', result.stallMs);
      // Lost: start over on a new git (this one's packed-refs can't be trusted, or it is gone).
      if (this.session === session) this.session = null;
      this.end(session);
      if (attempt >= ATTEMPTS) return { moved: false, stderr: '' };
    }
  }

  /** Removes the ref lock `session`'s git may have left (see `releaseLock`), after any removal already under way. */
  private cleanUp(session: Session, ref: string, next: string): void {
    const cleanup: Promise<void> = (this.cleanup ?? Promise.resolve())
      .then(() => this.releaseLock(session, ref, next))
      .catch(() => {})
      .finally(() => {
        if (this.cleanup === cleanup) this.cleanup = null;
      });
    this.cleanup = cleanup;
  }

  /** Waits until no lock a killed git left is still to be removed: GitStalledError when that takes a stall time. */
  private async cleaned(): Promise<void> {
    if (!this.cleanup) return;
    const stallMs = stallOf(this.stall);
    if (!(await settlesWithin(this.cleanup, stallMs))) throw new GitStalledError('update-ref --stdin', stallMs);
  }

  /** Whether `ref` holds `next`, asked of a new git: `next` is new, so only this update can have put it there. */
  private async landed(ref: string, next: string): Promise<boolean> {
    const run = await runGit(this.location.root, ['for-each-ref', '--contains', next, '--format=%(refname)', ref], {
      stallMs: this.settle,
    }).catch((error: unknown) => {
      // Not BUSY, which would promise that the ref did not move.
      throw new Error(`could not tell whether ${ref} moved to ${next}: ${(error as Error).message}`);
    });
    if (run.code !== 0) throw new Error(`could not tell whether ${ref} moved to ${next}: ${run.stderr.trim()}`);
    return run.stdout.toString('utf8').trim() === ref;
  }

  /** The lock git takes to update `ref`: the ref's own, or with reftable, the stack's. */
  private async lockPath(ref: string): Promise<string> {
    this.reftable ??= stat(path.join(this.location.commonDir, 'reftable')).then(
      (info) => info.isDirectory(),
      () => false,
    );
    return (await this.reftable)
      ? path.join(this.location.commonDir, 'reftable', 'tables.list.lock')
      : path.join(this.location.commonDir, `${ref}.lock`);
  }

  /**
   * Removes the ref lock a session's git left when it died or was killed
   * mid-transaction, once that git has exited: the lock it said it held, if
   * the same file is still there, or a ref lock that holds `next`, which only
   * this update writes (git writes the new value into the lock as it
   * prepares, and renames the lock into place to commit). No other process
   * can take a lock file while it exists, so either is still that git's. A
   * git that settled its own transaction, or that outlived being killed,
   * keeps whatever it holds. So does one killed in the instant between
   * taking the lock and writing `next` into it: that lock can't be told from
   * another process's, so later updates meet it as any other ref lock (BUSY,
   * with `stale_lock` once it is ~30 s old).
   */
  private async releaseLock(session: Session, ref: string, next: string): Promise<void> {
    if (!session.exited) {
      if (session.killedAt === null) return;
      const grace = Math.max(stallOf(this.settle), EXIT_AFTER_KILL_MS);
      if (!(await exitWithin(session, session.killedAt + grace - Date.now()))) return;
    }
    const lock = await this.lockPath(ref);
    const ours =
      (session.held?.path === lock && (await identity(lock)) === session.held.identity) ||
      (await readFile(lock, 'utf8').catch(() => '')).trim() === next;
    session.held = null;
    // Retried: on Windows a scanner may still have the file open for a moment.
    if (ours) await rm(lock, { force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {});
  }

  /**
   * Under git's lock: notes the lock's identity, and tells whether packed-refs
   * is unchanged since git started; false when that takes the stall time.
   */
  private async check(session: Session, ref: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), stallOf(this.stall))));
    const checked = (async () => {
      const lock = await this.lockPath(ref);
      const [packedRefs, held] = await Promise.all([this.packedRefs().catch(() => 'unreadable'), identity(lock)]);
      if (held !== null) session.held = { path: lock, identity: held };
      return packedRefs === session.packedRefs;
    })();
    try {
      return await Promise.race([checked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One transaction: commits only if packed-refs is unchanged since git started, checked under the ref's lock. */
  private attempt(session: Session, ref: string, next: string, old: string | null): Promise<Attempt> {
    return new Promise((resolve, reject) => {
      let told: 'prepare' | 'checking' | 'commit' | 'abort' = 'prepare';
      let watchdog: NodeJS.Timeout | undefined;
      const settle = () => {
        clearTimeout(watchdog);
        session.onLine = null;
        session.onExit = null;
        setActive(session, false);
      };
      const finish = (result: Attempt) => {
        settle();
        resolve(result);
      };
      const fail = (error: Error) => {
        settle();
        reject(error);
      };
      const kill = () => {
        session.killedAt = Date.now();
        if (this.session === session) this.session = null;
        killTree(session.child);
      };
      // git has the stall time to answer each step (once told to commit, the settle time), or it is killed.
      const watch = () => {
        clearTimeout(watchdog);
        const stallMs = stallOf(told === 'commit' ? this.settle : this.stall);
        watchdog = setTimeout(() => {
          kill();
          if (told !== 'commit') return finish({ kind: 'stalled', stallMs });
          // Its exit says `unknown`, and whether the ref moved is found out then, unless it never exits
          // (given as long as a killed git's lock is: the kill itself can take seconds on a loaded machine).
          watchdog = setTimeout(
            () => fail(new Error(`git update-ref --stdin stopped answering once told to commit, and outlived being killed: whether ${ref} moved is unknown`)),
            Math.max(stallMs, EXIT_AFTER_KILL_MS),
          );
        }, stallMs);
      };
      const unexpected = (line: string) => {
        kill();
        if (told === 'commit') return; // its exit says `unknown`: whether the ref moved is found out
        fail(new Error(`git update-ref --stdin answered ${JSON.stringify(line)}`));
      };
      session.stderr.length = 0;
      session.onLine = (line) => {
        if (line === 'start: ok' && told === 'prepare') return watch();
        if (line === 'prepare: ok' && told === 'prepare') {
          // git holds the ref's lock now (no one else can move it), and waits: the check is grimoire's to time, not git's.
          told = 'checking';
          clearTimeout(watchdog);
          void this.check(session, ref).then((unchanged) => {
            if (session.exited || session.killedAt !== null) return;
            told = unchanged ? 'commit' : 'abort';
            watch();
            session.child.stdin.write(`${told}\n`);
          });
          return;
        }
        if (line === 'commit: ok' && told === 'commit') {
          session.held = null;
          return finish({ kind: 'moved' });
        }
        if (line === 'abort: ok' && told === 'abort') {
          session.held = null;
          return finish({ kind: 'lost' });
        }
        unexpected(line);
      };
      session.onExit = () => {
        const stderr = Buffer.concat(session.stderr).toString('utf8');
        if (told === 'commit') finish({ kind: 'unknown' });
        else if (told === 'prepare' && stderr.trim() !== '') finish({ kind: 'refused', stderr });
        else finish({ kind: 'lost' });
      };
      setActive(session, true);
      watch();
      // No old value: git moves the ref from whatever it holds.
      session.child.stdin.write(`start\nupdate ${ref} ${next}${old === null ? '' : ` ${old}`}\nprepare\n`);
    });
  }

  private ensureSession(packedRefs: string): Session {
    const current = this.session;
    if (current && !current.exited && current.packedRefs === packedRefs) return current;
    if (current) this.end(current); // idle between transactions: its git just exits
    const child = spawn(
      'git',
      ['-c', `core.hooksPath=${NO_HOOKS}`, 'update-ref', '--stdin', '--create-reflog', '-m', this.reflogMessage],
      { cwd: this.location.root, env: cleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let closed!: () => void;
    const session: Session = {
      child,
      packedRefs,
      stderr: [],
      stdout: '',
      onLine: null,
      onExit: null,
      exited: false,
      closed: new Promise<void>((resolve) => (closed = resolve)),
      killedAt: null,
      held: null,
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      session.stdout += chunk;
      for (let newline = session.stdout.indexOf('\n'); newline >= 0; newline = session.stdout.indexOf('\n')) {
        const line = session.stdout.slice(0, newline).replace(/\r$/, '');
        session.stdout = session.stdout.slice(newline + 1);
        session.onLine?.(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => session.stderr.push(chunk));
    child.stdin.on('error', () => {
      // git exited mid-transaction; its exit tells the story.
    });
    const exit = (error?: Error) => {
      if (session.exited) return;
      session.exited = true;
      if (error) session.stderr.push(Buffer.from(error.message));
      session.onExit?.();
      closed();
    };
    child.on('error', exit);
    child.on('close', () => exit());
    this.session = session;
    setActive(session, false);
    return session;
  }
}

/** Whether the session's git exits within `ms`. */
async function exitWithin(session: Session, ms: number): Promise<boolean> {
  return session.exited || (await settlesWithin(session.closed, ms));
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), Math.max(0, ms))));
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A file's identity (inode or file index, size, mtime and birth time), or null when there is none. */
async function identity(file: string): Promise<string | null> {
  const info = await stat(file, { bigint: true }).catch(() => null);
  return info ? `${info.ino}:${info.size}:${info.mtimeNs}:${info.birthtimeNs}` : null;
}

/** Keeps Node alive for a session only while a transaction is in flight. */
function setActive(session: Session, active: boolean): void {
  const { child } = session;
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as unknown as {
    ref?: () => void;
    unref?: () => void;
  }[]) {
    if (active) handle.ref?.();
    else handle.unref?.();
  }
}

let unreadable = 0;

/**
 * The identity of `<git-common-dir>/packed-refs` (size, inode and nanosecond
 * mtime and ctime), or `none` when there is none. A long-lived git trusts its
 * cached packed-refs while the file's stat looks unchanged to it, which on
 * Windows means the same size within the same whole second: a change here
 * means that git's view of packed-refs may be stale. A file that can't be
 * stat'ed gets a stamp no other call returns, so it always counts as changed.
 */
export async function packedRefsStamp(commonDir: string): Promise<string> {
  try {
    const info = await stat(path.join(commonDir, 'packed-refs'), { bigint: true });
    return `${info.size}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : `unreadable:${++unreadable}`;
  }
}
