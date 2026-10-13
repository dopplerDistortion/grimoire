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
  /** Why the process never started (ENOENT, EACCES), when it didn't. */
  readonly spawnError?: string;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  readonly input?: string;
  readonly timeoutMs: number;
}

/** Runs `binary` with `args` and collects its output. Never throws for the child's own failure. */
export function runProcess(binary: string, args: readonly string[], options: ProcessOptions): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
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
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    let settled = false;
    const finish = (run: ProcessRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error.code ?? error.message }));
    child.on('close', (code) =>
      finish({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut }),
    );
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
