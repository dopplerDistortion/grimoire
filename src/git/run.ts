import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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

export interface GitRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs git in `cwd` with the clean environment and no hooks; never throws on a non-zero exit. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: { input?: string | Buffer } = {},
): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${NO_HOOKS}`, ...args], {
      cwd,
      env: cleanGitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {
      // git may exit before reading its stdin; the exit code tells the story.
    });
    child.stdin.end(options.input);
  });
}
