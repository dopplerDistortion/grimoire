import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cleanGitEnv, GIT_STALL_MS, GitStalledError, killTree, NO_HOOKS } from './run';

export interface GitObject {
  /** The object's oid: what the requested name resolved to. */
  oid: string;
  type: string;
  content: Buffer;
}

interface Pending {
  resolve(object: GitObject | null): void;
  reject(error: Error): void;
}

/** One `git cat-file --batch` process, with the reads it has yet to answer. */
interface Batch {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Pending[];
  buffer: Buffer;
  /** Armed while reads wait: fires when git has said nothing for the stall time. */
  watchdog: NodeJS.Timeout | undefined;
}

/**
 * One long-lived `git cat-file --batch` per repository: reads cost a pipe round
 * trip, not a process. Requests are answered in order, so callers may pipeline.
 * A request may name a ref: git resolves it when it reads the request (loose
 * refs and reftable fresh each time, packed-refs only when its stat changed).
 * The process is unref'd while idle, so it never keeps Node alive; `close()`
 * ends it. A read after `close()` still gets its answer, from a process that
 * ends once its reads are answered. A crashed process fails its pending reads
 * and is respawned on the next read. So is a stuck one: when git says nothing
 * for `stallMs` while reads wait, it is killed (with its tree on Windows) and
 * they fail with GitStalledError (BUSY).
 */
export class ObjectReader {
  private batch: Batch | null = null;
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly stallMs = GIT_STALL_MS,
  ) {}

  /** Reads the object `name` (an oid or a full ref name) names, or null when there is none. */
  read(name: string): Promise<GitObject | null> {
    return new Promise((resolve, reject) => {
      const batch = this.ensureBatch();
      batch.pending.push({ resolve, reject });
      setActive(batch, true);
      if (batch.pending.length === 1) this.watch(batch);
      batch.child.stdin.write(`${name}\n`);
    });
  }

  /** Starts the process ahead of the first read. */
  warm(): void {
    if (!this.closed) this.ensureBatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    const batch = this.batch;
    this.batch = null;
    if (batch) await end(batch, this.stallMs);
  }

  /** (Re)arms the watchdog: git has `stallMs` to say something about the reads that wait, or it is killed. */
  private watch(batch: Batch): void {
    clearTimeout(batch.watchdog);
    batch.watchdog = setTimeout(() => {
      if (this.batch === batch) this.batch = null;
      killTree(batch.child);
      const error = new GitStalledError('cat-file --batch', this.stallMs);
      for (const request of batch.pending.splice(0)) request.reject(error);
    }, this.stallMs);
  }

  private ensureBatch(): Batch {
    if (this.batch) return this.batch;
    const child = spawn('git', ['-c', `core.hooksPath=${NO_HOOKS}`, 'cat-file', '--batch'], {
      cwd: this.cwd,
      env: cleanGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const batch: Batch = { child, pending: [], buffer: Buffer.alloc(0), watchdog: undefined };
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => this.onData(batch, chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // Surfaces as the process closing.
    });
    const fail = (reason: string) => {
      clearTimeout(batch.watchdog);
      if (this.batch === batch) this.batch = null;
      const error = new Error(`git cat-file --batch ${reason}: ${Buffer.concat(stderr).toString('utf8').trim()}`);
      for (const request of batch.pending.splice(0)) request.reject(error);
    };
    child.on('error', (error) => fail(error.message));
    child.on('close', (code) => fail(`exited ${code}`));
    this.batch = batch;
    setActive(batch, false);
    return batch;
  }

  private onData(batch: Batch, chunk: Buffer): void {
    batch.buffer = batch.buffer.length === 0 ? chunk : Buffer.concat([batch.buffer, chunk]);
    for (;;) {
      const head = batch.pending[0];
      if (!head) break;
      const newline = batch.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const header = batch.buffer.toString('utf8', 0, newline);
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        batch.buffer = batch.buffer.subarray(newline + 1);
        batch.pending.shift();
        head.resolve(null);
        continue;
      }
      const [oid, type, size] = header.split(' ');
      const length = Number(size);
      const end = newline + 1 + length;
      if (batch.buffer.length < end + 1) break;
      const content = Buffer.from(batch.buffer.subarray(newline + 1, end));
      batch.buffer = batch.buffer.subarray(end + 1);
      batch.pending.shift();
      head.resolve({ oid: oid ?? '', type: type ?? '', content });
    }
    // Any answer is a sign of life: the reads still waiting get a new stall time.
    if (batch.pending.length > 0) return this.watch(batch);
    clearTimeout(batch.watchdog);
    setActive(batch, false);
    if (this.closed && this.batch === batch) {
      this.batch = null;
      void end(batch, this.stallMs);
    }
  }
}

/**
 * Lets a process exit once it has answered what it was asked; Node stays
 * alive until it has. One still running `stallMs` later is killed.
 */
function end(batch: Batch, stallMs: number): Promise<void> {
  const { child } = batch;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  setActive(batch, true);
  const stuck = setTimeout(() => killTree(child), stallMs);
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve())).finally(() => clearTimeout(stuck));
  child.stdin.end();
  return exited;
}

/** Keeps Node alive for a process only while it has reads to answer. */
function setActive(batch: Batch, active: boolean): void {
  const { child } = batch;
  const handles = [child, child.stdin, child.stdout, child.stderr] as unknown as {
    ref?: () => void;
    unref?: () => void;
  }[];
  for (const handle of handles) {
    if (active) handle.ref?.();
    else handle.unref?.();
  }
}
