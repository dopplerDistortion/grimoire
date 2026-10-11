import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanGitEnv, NO_HOOKS, runGit } from './run';

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
  | { readonly kind: 'unknown' };

/** How many transactions an update may lose (see `Attempt`) before it gives up. */
const ATTEMPTS = 3;

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
 */
export class RefUpdater {
  private session: Session | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** Sessions whose git is exiting. */
  private readonly ending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly reflogMessage: string,
    /** The repository's `packedRefsStamp`. */
    private readonly packedRefs: () => Promise<string>,
  ) {}

  /**
   * Moves `ref` from `old` (the zero oid: create it) to `next`, atomically.
   * After `close`, the update still runs, on a git that exits right after it.
   */
  update(ref: string, next: string, old: string): Promise<RefUpdate> {
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
    if (this.session) this.end(this.session);
    this.session = null;
    await Promise.all(this.ending);
  }

  /** Lets a session's git exit (aborting any open transaction); Node stays alive until it has. */
  private end(session: Session): void {
    if (session.exited) return;
    setActive(session, true);
    const exited: Promise<void> = new Promise<void>((resolve) => {
      if (session.exited) resolve();
      else session.child.once('close', () => resolve());
    }).finally(() => this.ending.delete(exited));
    this.ending.add(exited);
    session.child.stdin.end();
  }

  private async transact(ref: string, next: string, old: string): Promise<RefUpdate> {
    for (let attempt = 1; ; attempt++) {
      const session = this.ensureSession(await this.packedRefs());
      let result = await this.attempt(session, ref, next, old);
      if (result.kind === 'unknown') result = (await this.landed(ref, next)) ? { kind: 'moved' } : { kind: 'lost' };
      if (result.kind === 'moved') return { moved: true };
      if (result.kind === 'refused') return { moved: false, stderr: result.stderr };
      // Lost: start over on a new git (this one's packed-refs can't be trusted, or it is gone).
      if (this.session === session) this.session = null;
      this.end(session);
      if (attempt >= ATTEMPTS) return { moved: false, stderr: '' };
    }
  }

  /** Whether `ref` holds `next`, asked of a new git: `next` is new, so only this update can have put it there. */
  private async landed(ref: string, next: string): Promise<boolean> {
    const run = await runGit(this.cwd, ['for-each-ref', '--contains', next, '--format=%(refname)', ref]);
    if (run.code !== 0) throw new Error(`could not tell whether ${ref} moved to ${next}: ${run.stderr.trim()}`);
    return run.stdout.toString('utf8').trim() === ref;
  }

  /** One transaction: commits only if packed-refs is unchanged since git started, checked under the ref's lock. */
  private attempt(session: Session, ref: string, next: string, old: string): Promise<Attempt> {
    return new Promise((resolve, reject) => {
      let told: 'prepare' | 'checking' | 'commit' | 'abort' = 'prepare';
      const finish = (result: Attempt) => {
        session.onLine = null;
        session.onExit = null;
        setActive(session, false);
        resolve(result);
      };
      const unexpected = (line: string) => {
        session.child.kill();
        if (told === 'commit') return; // its exit says `unknown`: whether the ref moved is found out
        session.onLine = null;
        session.onExit = null;
        reject(new Error(`git update-ref --stdin answered ${JSON.stringify(line)}`));
      };
      session.stderr.length = 0;
      session.onLine = (line) => {
        if (line === 'start: ok' && told === 'prepare') return;
        if (line === 'prepare: ok' && told === 'prepare') {
          // git holds the ref's lock now: no one else can move it.
          told = 'checking';
          void this.packedRefs()
            .catch(() => 'unreadable')
            .then((packedRefs) => {
              if (session.exited) return;
              told = packedRefs === session.packedRefs ? 'commit' : 'abort';
              session.child.stdin.write(`${told}\n`);
            });
          return;
        }
        if (line === 'commit: ok' && told === 'commit') return finish({ kind: 'moved' });
        if (line === 'abort: ok' && told === 'abort') return finish({ kind: 'lost' });
        unexpected(line);
      };
      session.onExit = () => {
        const stderr = Buffer.concat(session.stderr).toString('utf8');
        if (told === 'commit') finish({ kind: 'unknown' });
        else if (told === 'prepare' && stderr.trim() !== '') finish({ kind: 'refused', stderr });
        else finish({ kind: 'lost' });
      };
      setActive(session, true);
      session.child.stdin.write(`start\nupdate ${ref} ${next} ${old}\nprepare\n`);
    });
  }

  private ensureSession(packedRefs: string): Session {
    const current = this.session;
    if (current && !current.exited && current.packedRefs === packedRefs) return current;
    if (current) this.end(current); // idle between transactions: its git just exits
    const child = spawn(
      'git',
      ['-c', `core.hooksPath=${NO_HOOKS}`, 'update-ref', '--stdin', '--create-reflog', '-m', this.reflogMessage],
      { cwd: this.cwd, env: cleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const session: Session = { child, packedRefs, stderr: [], stdout: '', onLine: null, onExit: null, exited: false };
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
    };
    child.on('error', exit);
    child.on('close', () => exit());
    this.session = session;
    setActive(session, false);
    return session;
  }
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
