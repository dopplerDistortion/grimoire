import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cleanGitEnv, NO_HOOKS } from './run';

export interface GitObject {
  type: string;
  content: Buffer;
}

interface Pending {
  oid: string;
  resolve(object: GitObject | null): void;
  reject(error: Error): void;
}

/**
 * One long-lived `git cat-file --batch` per repository: reads cost a pipe round
 * trip, not a process. Requests are answered in order, so callers may pipeline.
 * The process is unref'd while idle, so it never keeps Node alive; `close()`
 * ends it. A crashed process fails its pending reads and is respawned on the
 * next read.
 */
export class ObjectReader {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending[] = [];
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly cwd: string) {}

  /** Reads an object, or null when the repository doesn't have it. */
  read(oid: string): Promise<GitObject | null> {
    return new Promise((resolve, reject) => {
      const child = this.ensureChild();
      this.pending.push({ oid, resolve, reject });
      this.setActive(true);
      child.stdin.write(`${oid}\n`);
    });
  }

  /** Starts the process ahead of the first read. */
  warm(): void {
    this.ensureChild();
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Keep Node alive until git has exited, or the await below never settles.
    this.setActive(true);
    this.child = null;
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();
    await exited;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn('git', ['-c', `core.hooksPath=${NO_HOOKS}`, 'cat-file', '--batch'], {
      cwd: this.cwd,
      env: cleanGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // Surfaces as the process closing.
    });
    const fail = (reason: string) => {
      if (this.child === child) this.child = null;
      this.buffer = Buffer.alloc(0);
      const error = new Error(`git cat-file --batch ${reason}: ${Buffer.concat(stderr).toString('utf8').trim()}`);
      for (const request of this.pending.splice(0)) request.reject(error);
    };
    child.on('error', (error) => fail(error.message));
    child.on('close', (code) => fail(`exited ${code}`));
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.setActive(false);
    return child;
  }

  private setActive(active: boolean): void {
    const child = this.child;
    if (!child) return;
    const handles = [child, child.stdin, child.stdout, child.stderr] as unknown as {
      ref?: () => void;
      unref?: () => void;
    }[];
    for (const handle of handles) {
      if (active) handle.ref?.();
      else handle.unref?.();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.pending[0];
      if (!head) break;
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const header = this.buffer.toString('utf8', 0, newline);
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.pending.shift();
        head.resolve(null);
        continue;
      }
      const [, type, size] = header.split(' ');
      const length = Number(size);
      const end = newline + 1 + length;
      if (this.buffer.length < end + 1) break;
      const content = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.pending.shift();
      head.resolve({ type: type ?? '', content });
    }
    if (this.pending.length === 0) this.setActive(false);
  }
}
