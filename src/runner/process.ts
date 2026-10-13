// Starting the person's client (spec §16 Spawn): the platform binary by its
// absolute path, never through a shell or a `.cmd` shim, `windowsHide`, with
// a kill timeout that takes the whole process tree.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { killTree } from '../git/run';

/** The most of each stream a run keeps. */
const OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface ProcessRun {
  /** The exit code, or null when the process was killed or never started. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** The process was killed because `signal` fired. */
  readonly aborted?: boolean;
  /** Why the process never started (ENOENT, EACCES), when it didn't. */
  readonly spawnError?: string;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
  readonly timeoutMs: number;
  /** Kills the process tree and settles at once when it fires (the runner stopping). */
  readonly signal?: AbortSignal;
  /** How long output may keep coming after the process exits (default 2 s). */
  readonly drainMs?: number;
}

/** How long a process's pipes may stay open after it exits: a process it left behind may hold them. */
export const DRAIN_MS = 2_000;

/**
 * Runs `binary` with `args` and collects its output. Never throws for the
 * child's own failure, and always settles: once the process exits, its output
 * gets `drainMs` to end; then whatever it left holding the pipes is killed and
 * the pipes are closed. On POSIX the process leads its own process group, so a
 * kill (the timeout, `signal`, a leftover after the drain) takes everything it
 * started, even after it exited itself. On Windows, a kill while it runs takes
 * its tree (taskkill /T); a process it left behind after exiting is no longer
 * in its tree, and only loses the pipes.
 */
export function runProcess(binary: string, args: readonly string[], options: ProcessOptions): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const drainMs = options.drainMs ?? DRAIN_MS;
    if (options.signal?.aborted) return resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
    const child = spawn(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: posix });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let sizes = [0, 0];
    const keep = (chunks: Buffer[], index: 0 | 1) => (chunk: Buffer) => {
      if (sizes[index]! >= OUTPUT_LIMIT) return;
      chunks.push(chunk);
      sizes = index === 0 ? [sizes[0]! + chunk.length, sizes[1]!] : [sizes[0]!, sizes[1]! + chunk.length];
    };
    child.stdout.on('data', keep(out, 0));
    child.stderr.on('data', keep(err, 1));
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const kill = () => killTree(child, { group: posix });
    const finish = (run: ProcessRun) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(run);
    };
    const collected = (): ProcessRun => ({
      code: timedOut || aborted ? null : exitCode,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut,
      ...(aborted ? { aborted } : {}),
    });
    /** Settles without waiting for the pipes: whatever still holds them is killed, and they are closed. */
    const settleNow = () => {
      if (settled) return;
      kill();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      finish(collected());
    };
    /** Kills the tree, then settles once the pipes close, or after the drain at the latest. */
    const stop = () => {
      kill();
      if (exited) return settleNow();
      timers.push(setTimeout(settleNow, drainMs));
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      stop();
    };
    timers.push(
      setTimeout(() => {
        if (!exited) timedOut = true;
        stop();
      }, options.timeoutMs),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error.code ?? error.message }));
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      timers.push(setTimeout(settleNow, drainMs));
    });
    child.on('close', () => finish(collected()));
    // The child may exit before reading its stdin; its exit code tells the story.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** Whether `binary` is something the runner may start directly: an absolute path to a file, the `.exe` on Windows. */
export async function checkBinary(binary: string): Promise<void> {
  if (!path.isAbsolute(binary)) throw new GrimoireError('INVALID', `the runner's binary must be an absolute path, not ${binary}`, { fields: { binary: 'must be absolute' } });
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(binary)) {
    throw new GrimoireError('INVALID', `the runner starts the platform binary (the .exe), never a shim like ${path.basename(binary)}`, {
      fields: { binary: 'must be the .exe, not a .cmd, .bat or .ps1 shim' },
    });
  }
  const found = await stat(binary).catch(() => null);
  if (!found?.isFile()) throw new GrimoireError('INVALID', `the runner's binary ${binary} isn't there`, { fields: { binary: 'not found' } });
}
