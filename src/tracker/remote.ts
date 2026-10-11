// Network git for sync (spec §4, Sync): non-interactive and bounded. No prompt
// can appear and nothing can hang: stdin is ignored, every prompt path is
// switched off, and each step has a timeout that kills git's whole process tree.
import { spawn } from 'node:child_process';
import { cleanGitEnv, killTree, NO_HOOKS, type GitRun } from '../git/run';

/** Why a sync failed (spec §4, Failure reporting). */
export type SyncFailureClass = 'auth' | 'network' | 'rejected';

export interface NetworkGitRun extends GitRun {
  /** True when the step ran out of time and was killed. */
  readonly timedOut: boolean;
}

export interface NetworkGitOptions {
  /** Kill the step after this long. */
  readonly timeoutMs: number;
  /** Written to git's stdin, which is then closed (oid lists); stdin is ignored otherwise. */
  readonly input?: string;
  /**
   * Whether the user chose how git runs ssh (`GIT_SSH_COMMAND`, `GIT_SSH` or
   * `core.sshCommand`): then grimoire leaves ssh alone; otherwise ssh runs
   * with `BatchMode=yes`.
   */
  readonly sshChosen: boolean;
}

/** The environment network git runs with: the clean git environment, with every prompt switched off. */
export function networkGitEnv(sshChosen: boolean, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = cleanGitEnv(base);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.SSH_ASKPASS_REQUIRE = 'never';
  if (!sshChosen && env.GIT_SSH_COMMAND === undefined && env.GIT_SSH === undefined) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  return env;
}

/**
 * Runs one network git step in `cwd`: no hooks, no auto maintenance, no
 * signed pushes, stdin ignored, and the step killed (with its children) at
 * the timeout. Never throws on a non-zero exit.
 */
export function runNetworkGit(cwd: string, args: readonly string[], options: NetworkGitOptions): Promise<NetworkGitRun> {
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = spawn(
      'git',
      ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'maintenance.auto=false', '-c', 'push.gpgSign=false', ...args],
      {
        cwd,
        env: networkGitEnv(options.sshChosen),
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group on POSIX, so a timeout can kill ssh and the
        // remote helpers too (and no controlling terminal to prompt on).
        detached: posix,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, { group: posix });
    }, options.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
    });
    if (child.stdin) {
      child.stdin.on('error', () => {
        // git may exit before reading its stdin; the exit code tells the story.
      });
      child.stdin.end(options.input);
    }
  });
}

/** Removes the userinfo from every URL in `text` (`https://user:token@host` → `https://host`). */
export function stripUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1');
}

const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /permission denied \((publickey|keyboard-interactive|password)/i,
  /permission denied, please try again/i,
  /host key verification failed/i,
  /invalid (username|credentials|username or password)/i,
  /http basic: access denied/i,
  /requested url returned error: 40[13]\b/i,
  /\bhttp 40[13]\b/i,
  /support for password authentication was removed/i,
  /bad credentials/i,
  /no supported authentication methods/i,
];

/** The failure class of a git step that failed for any reason but a push rejection. */
export function classifyFailure(run: NetworkGitRun): Exclude<SyncFailureClass, 'rejected'> {
  if (run.timedOut) return 'network';
  return AUTH_PATTERNS.some((pattern) => pattern.test(run.stderr)) ? 'auth' : 'network';
}

/** The most this records of a remote's message. */
const MESSAGE_LIMIT = 2_000;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** What the remote said (its `remote:` lines), trimmed; empty when it said nothing. */
export function remoteLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('remote:'))
    .map((line) => line.slice('remote:'.length).replace(ANSI, '').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** git's own error lines (`fatal:`, `error:`), trimmed. */
function errorLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, '').trim())
    .filter((line) => /^(fatal|error):/i.test(line) && !/^error: failed to push some refs/i.test(line))
    .join('\n');
}

/** A message fit to record and show: userinfo stripped, length capped. */
export function recordable(text: string): string {
  const stripped = stripUserinfo(text.trim());
  return stripped.length > MESSAGE_LIMIT ? `${stripped.slice(0, MESSAGE_LIMIT - 1)}…` : stripped;
}

/** The message of a failed step: what the remote said, else git's error lines, else a fallback. */
export function failureMessage(step: string, run: NetworkGitRun, timeoutMs: number): string {
  if (run.timedOut) return recordable(`git ${step} timed out after ${Math.round(timeoutMs / 1000)} s`);
  const said = [remoteLines(run.stderr), errorLines(run.stderr)].filter((part) => part !== '').join('\n');
  return recordable(said || `git ${step} failed (exit ${run.code})`);
}

/** One ref's line of `git push --porcelain`. */
export interface PushedRef {
  /** ` ` fast-forward, `+` forced, `*` new, `=` up to date, `!` rejected. */
  readonly flag: string;
  /** For example `[rejected] (fetch first)` or `[remote rejected] (pre-receive hook declined)`. */
  readonly summary: string;
}

/** The porcelain line for `ref`, or null when git printed none (it failed before pushing). */
export function pushedRef(stdout: string, ref: string): PushedRef | null {
  for (const line of stdout.split(/\r?\n/)) {
    const [flag, refs, summary] = line.split('\t');
    if (flag !== undefined && refs !== undefined && summary !== undefined && refs.endsWith(`:${ref}`)) {
      return { flag, summary: summary.trim() };
    }
  }
  return null;
}

/**
 * Whether a rejected push only lost a race, so fetch, fold and push again:
 * the remote moved since the fetch (git saw it in the ref advertisement), or
 * another push moved it while this one ran (the remote's compare-and-set
 * failed). A D/F ref conflict or a hook's refusal is no race.
 */
export function lostRace(pushed: PushedRef, stderr: string): boolean {
  if (pushed.flag !== '!') return false;
  if (/^\[rejected\]/.test(pushed.summary)) return /non-fast-forward|fetch first|stale info/.test(pushed.summary);
  if (!/^\[remote rejected\]/.test(pushed.summary)) return false;
  return /incorrect old value|failed to lock|is at [0-9a-f]+ but expected/.test(`${pushed.summary}\n${remoteLines(stderr)}\n${stderr}`);
}
