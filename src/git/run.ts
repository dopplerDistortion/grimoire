import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { GrimoireError } from '../errors';

/**
 * `GIT_*` variables grimoire passes through to git: where the user's config
 * lives, and how they reach remotes. Every other `GIT_*` variable (GIT_DIR,
 * GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_CONFIG_PARAMETERS inherited from a
 * hook, author overrides, …) is dropped, so git sees only the repo it is
 * pointed at (spec §4, Git environment).
 */
const PASS_THROUGH = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_EXEC_PATH',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
]);

/** The environment every grimoire git process runs with. */
export function cleanGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !PASS_THROUGH.has(upper)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  // Reads never touch the network, even in a partial clone (spec §4, Read path).
  env.GIT_NO_LAZY_FETCH = '1';
  // Replace refs must never change what a tracker object reads as.
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

/**
 * A `core.hooksPath` that can never hold a hook (a path under the null device),
 * so no hook — `reference-transaction` included — runs for grimoire's git.
 */
export const NO_HOOKS = path.join(os.devNull, 'grimoire-no-hooks');

/**
 * How long a local git may go without a sign of life (output, or the answer
 * to a request) before grimoire counts it as stuck. Local git answers in
 * milliseconds; this is for a hung one (a wedged filesystem, a frozen
 * process), which grimoire kills, with its whole tree on Windows, and
 * reports as BUSY, so nothing waits on it forever.
 */
export const GIT_STALL_MS = 5_000;

/**
 * How long a git may go without a sign of life: a fixed time, or one asked
 * for each time the watch is (re)armed, so it can shrink as a deadline nears.
 */
export type StallLimit = number | (() => number);

/** The stall time `limit` gives now. */
export function stallOf(limit: StallLimit): number {
  return typeof limit === 'number' ? limit : limit();
}

/** BUSY: a local git stopped answering, and was killed. Nothing changed; the next call starts a new git. */
export class GitStalledError extends GrimoireError {
  constructor(command: string, stallMs: number) {
    super('BUSY', `git ${command} stopped answering for ${(stallMs / 1000).toFixed(1)} s and was killed; try again`);
  }
}

/**
 * Kills `child` at once and, on Windows, every process it started: there,
 * `git` is a launcher whose own child does the work and would outlive it.
 * `group`: on POSIX, kill the process group `child` leads (spawned detached).
 */
export function killTree(child: ChildProcess, options: { group?: boolean } = {}): void {
  const { pid } = child;
  if (pid === undefined) return;
  // Gone already, so its pid may name another process now; a group may still hold its children.
  if (!options.group && (child.exitCode !== null || child.signalCode !== null)) return;
  if (process.platform === 'win32') return reaper.kill(child);
  try {
    if (options.group) process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/** `taskkill` for `child`'s whole tree, started on this thread; `child.kill()` when it can't start. */
function taskkill(child: ChildProcess): void {
  const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  kill.on('error', () => child.kill());
}

const REAPER_THREAD = `
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
parentPort.on('message', ({ id, pid }) => {
  let told = false;
  const tell = (started) => {
    if (!told) parentPort.postMessage({ id, started });
    told = true;
  };
  const kill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  kill.on('spawn', () => tell(true));
  kill.on('error', () => tell(false));
});
`;

/**
 * Starts Windows kills (`taskkill`) on a thread of its own. Starting a
 * process blocks the thread that starts it, on a loaded machine for hundreds
 * of milliseconds: on grimoire's own thread, a kill would hold up whatever
 * waits behind it, first of all the BUSY it gives. The thread starts with the
 * first kill and keeps Node alive only while a kill is on its way; a kill
 * still on its way when Node exits, or when the thread can't run, is started
 * here instead.
 */
class Reaper {
  private thread: Worker | null = null;
  private readonly pending = new Map<number, ChildProcess>();
  private nextId = 0;
  private hooked = false;

  kill(child: ChildProcess): void {
    const thread = this.start();
    if (!thread) return taskkill(child);
    const id = ++this.nextId;
    this.pending.set(id, child);
    thread.ref();
    thread.postMessage({ id, pid: child.pid });
  }

  private start(): Worker | null {
    if (this.thread) return this.thread;
    let thread: Worker;
    try {
      thread = new Worker(REAPER_THREAD, { eval: true });
    } catch {
      return null;
    }
    thread.on('message', ({ id, started }: { id: number; started: boolean }) => {
      const child = this.pending.get(id);
      this.pending.delete(id);
      if (child && !started) child.kill();
      if (this.pending.size === 0) thread.unref();
    });
    const gone = () => {
      if (this.thread === thread) this.thread = null;
      this.flush();
    };
    thread.on('error', gone);
    thread.on('exit', gone);
    if (!this.hooked) process.on('exit', () => this.flush());
    this.hooked = true;
    this.thread = thread;
    return thread;
  }

  /** Starts here every kill the thread hasn't said it started. */
  private flush(): void {
    for (const child of this.pending.values()) taskkill(child);
    this.pending.clear();
  }
}

const reaper = new Reaper();

export interface GitRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunGitOptions {
  readonly input?: string | Buffer;
  /** How long git may go without output before it is killed as stuck (GitStalledError); default GIT_STALL_MS. */
  readonly stallMs?: StallLimit;
}

/**
 * Runs git in `cwd` with the clean environment and no hooks; never throws on
 * a non-zero exit. A git that stops answering is killed: GitStalledError.
 */
export function runGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${NO_HOOKS}`, ...args], {
      cwd,
      env: cleanGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const limit = options.stallMs ?? GIT_STALL_MS;
    let stalled = false;
    let watchdog: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(watchdog);
      const stallMs = stallOf(limit);
      watchdog = setTimeout(() => {
        stalled = true;
        killTree(child);
        reject(new GitStalledError(args[0] ?? '', stallMs));
      }, stallMs);
    };
    alive();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      alive();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      alive();
    });
    child.on('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      if (!stalled) resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {
      // git may exit before reading its stdin; the exit code tells the story.
    });
    child.stdin.end(options.input);
  });
}
