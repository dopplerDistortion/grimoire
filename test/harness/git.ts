import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand, type RunResult } from './process';

/** The harness's global git config (see the comments inside it). */
export const HARNESS_GIT_CONFIG = fileURLToPath(new URL('./gitconfig', import.meta.url));

/**
 * Returns a copy of `base` with every inherited `GIT_*` variable removed (a test
 * run from inside a git hook would otherwise inherit GIT_DIR and friends) and
 * git pinned to the harness config: no system config, the harness file as the
 * global config, no prompts, and no repo discovery above the OS temp dir.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = HARNESS_GIT_CONFIG;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  return env;
}

/**
 * Applies `gitEnv` to `process.env` in place, so code under test that spawns
 * git with the inherited environment is isolated too. The Vitest setup file
 * calls this once per test file.
 */
export function isolateGitEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const isolated = gitEnv(env);
  for (const key of Object.keys(env)) {
    if (!(key in isolated)) delete env[key];
  }
  Object.assign(env, isolated);
}

export interface GitOptions {
  /** Written to git's stdin. */
  input?: string | Buffer;
  /** Extra variables, applied after the harness isolation. */
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly result: RunResult,
  ) {
    super(
      `git ${args.join(' ')} exited ${result.code ?? result.signal} in ${cwd}\n${result.stderr.trim()}`,
    );
    this.name = 'GitError';
  }
}

/** Runs real git in `cwd` under the harness isolation; never throws on a non-zero exit. */
export function gitResult(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<RunResult> {
  return runCommand('git', args, {
    cwd,
    env: { ...gitEnv(), ...options.env },
    input: options.input,
  });
}

/**
 * Runs real git in `cwd` under the harness isolation and returns its stdout
 * with trailing whitespace trimmed. Throws a GitError on a non-zero exit.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const result = await gitResult(cwd, args, options);
  if (result.code !== 0) throw new GitError(args, cwd, result);
  return result.stdout.trimEnd();
}
