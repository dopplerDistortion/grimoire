import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { cleanGitEnv, NO_HOOKS } from './run';

export type RefUpdate = { readonly moved: true } | { readonly moved: false; readonly stderr: string };

interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  /** The `packedRefsStamp` when it started. */
  readonly packedRefs: string;
  readonly stderr: Buffer[];
  stdout: string;
  /** The transaction in flight: told each stdout line, and told when git exits. */
  onLine: ((line: string) => void) | null;
  onExit: (() => void) | null;
  exited: boolean;
}

/**
 * One long-lived `git update-ref --stdin` per repository: each compare-and-set
 * is its own transaction (`start`, `update <ref> <new> <old>`, `prepare`,
 * `commit`), so moving a ref costs a pipe round trip, not a process. git exits
 * on a failed transaction; the next update starts a new process. Updates run
 * one at a time, in call order. Every update gets the same reflog message.
 *
 * git checks the old value against its cached packed-refs while the file's
 * stat looks unchanged to it. A process that outlived a packed-refs rewrite
 * could take a stale value for the current one and let a lost update through,
 * so a new packed-refs stamp always gets a new process.
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
  ) {}

  /**
   * Moves `ref` from `old` (the zero oid: create it) to `next`, atomically.
   * `packedRefs` is `packedRefsStamp`, taken just before.
   */
  update(ref: string, next: string, old: string, packedRefs: string): Promise<RefUpdate> {
    const run = this.tail.then(() => this.transact(ref, next, old, packedRefs));
    this.tail = run.catch(() => {});
    return run;
  }

  /** Starts git ahead of the first update, unless it is running already. */
  warm(packedRefs: string): void {
    if (!this.closed && (!this.session || this.session.exited)) this.ensureSession(packedRefs);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    if (this.session) this.end(this.session);
    this.session = null;
    await Promise.all(this.ending);
  }

  /** Lets an idle session's git exit; Node stays alive until it has. */
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

  private transact(ref: string, next: string, old: string, packedRefs: string): Promise<RefUpdate> {
    const session = this.ensureSession(packedRefs);
    return new Promise((resolve, reject) => {
      const done = (result: RefUpdate) => {
        session.onLine = null;
        session.onExit = null;
        setActive(session, false);
        resolve(result);
      };
      session.stderr.length = 0;
      session.onLine = (line) => {
        if (line === 'commit: ok') done({ moved: true });
        else if (!/^(start|prepare): ok$/.test(line)) {
          session.onLine = null;
          session.onExit = null;
          reject(new Error(`git update-ref --stdin answered ${JSON.stringify(line)}`));
          session.child.kill();
        }
      };
      session.onExit = () => done({ moved: false, stderr: Buffer.concat(session.stderr).toString('utf8') });
      setActive(session, true);
      session.child.stdin.write(`start\nupdate ${ref} ${next} ${old}\nprepare\ncommit\n`);
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

/**
 * The identity of `<git-common-dir>/packed-refs` (size, inode and nanosecond
 * mtime), or `none`. A long-lived git trusts its cached packed-refs while the
 * file's stat looks unchanged to it, which can miss a same-size rewrite inside
 * one timestamp tick; a change here means that git must be restarted.
 */
export async function packedRefsStamp(commonDir: string): Promise<string> {
  const info = await stat(path.join(commonDir, 'packed-refs'), { bigint: true }).catch(() => null);
  return info ? `${info.size}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}` : 'none';
}
