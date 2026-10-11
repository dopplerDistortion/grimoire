import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
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
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    kill.on('error', () => child.kill());
    return;
  }
  try {
    if (options.group) process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

export interface GitRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface RunGitOptions {
  readonly input?: string | Buffer;
  /** How long git may go without output before it is killed as stuck (GitStalledError); default GIT_STALL_MS. */
  readonly stallMs?: number;
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
    const stallMs = options.stallMs ?? GIT_STALL_MS;
    let stalled = false;
    let watchdog: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(watchdog);
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
