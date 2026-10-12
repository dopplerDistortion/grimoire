// `runner enable` and `runner disable` (spec §16 Enabling): find the client's
// platform binary, run the preflight, and store the machine-local config.
// The human-only gate (no agent markers, a terminal, a typed confirmation) is
// the surface's; this module never asks anything itself.
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GrimoireError } from '../errors';
import { readRunnerConfig, removeRunnerConfig, writeRunnerConfig, type RunnerConfig, type RunnerKind } from './config';
import { childEnv, preflight, type Preflight } from './guard';
import { CODEX_VERIFIED_VERSION } from './invocation';
import { checkBinary } from './process';
import { storeAt } from './run';

/** What enabling says before it stores anything (spec §16 Enabling). */
export function enableWarnings(kind: RunnerKind): string[] {
  const warnings = [
    'Runner runs draw on your plan’s shared 5-hour and weekly limits: the same limits your own sessions use.',
    'Each run starts the client unattended, with no tools, on your own login; at most 6 runs a day, and a 6 h pause after 2 failed runs in a row.',
  ];
  if (kind === 'claude') warnings.push('Unattended `claude -p` use on a subscription is a policy gray zone: check Anthropic’s current terms for your plan.');
  else {
    warnings.push(
      `Your Codex config stays in use; its MCP servers, hooks, notify program and developer instructions are switched off for each run, one setting at a time. That list was verified against Codex ${CODEX_VERIFIED_VERSION}: a later release may add a setting it doesn’t cover.`,
    );
  }
  return warnings;
}

const isFile = (file: string) => stat(file).then((found) => found.isFile(), () => false);

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return (key ? (env[key] ?? '') : '').split(path.delimiter).filter((dir) => dir !== '');
}

/** The native `codex` an npm install's shim in `dir` runs (spike F): `node_modules/@openai/codex/node_modules/@openai/codex-<platform>-<arch>/vendor/<triple>/bin/`. */
async function codexNative(packageDir: string): Promise<string | null> {
  const scope = path.join(packageDir, 'node_modules', '@openai');
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const platformPackage of (await readdir(scope).catch(() => [] as string[])).filter((name) => name.startsWith(`codex-${process.platform}-`)).sort()) {
    const vendor = path.join(scope, platformPackage, 'vendor');
    for (const triple of (await readdir(vendor).catch(() => [] as string[])).sort()) {
      const candidate = path.join(vendor, triple, 'bin', exe);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The client's platform binary from PATH: `claude.exe` / `codex.exe` on
 * Windows (an npm `codex.cmd` shim is followed to its native binary, never
 * run), the file itself elsewhere (an npm `codex` script likewise).
 */
export async function findBinary(kind: RunnerKind, env: NodeJS.ProcessEnv): Promise<string> {
  for (const dir of pathDirs(env)) {
    if (process.platform === 'win32') {
      const exe = path.join(dir, `${kind}.exe`);
      if (await isFile(exe)) return exe;
      if (kind === 'codex' && (await isFile(path.join(dir, 'codex.cmd')))) {
        const native = await codexNative(path.join(dir, 'node_modules', '@openai', 'codex'));
        if (native) return native;
      }
      continue;
    }
    const file = path.join(dir, kind);
    if (!(await isFile(file))) continue;
    const real = await realpath(file);
    if (kind === 'codex' && real.endsWith('.js')) {
      const native = await codexNative(path.dirname(path.dirname(real)));
      if (native) return native;
    }
    return real;
  }
  throw new GrimoireError('INVALID', `the runner can't find ${kind}'s platform binary on PATH${process.platform === 'win32' ? ` (${kind}.exe)` : ''}; install ${kind === 'claude' ? 'Claude Code' : 'the Codex CLI'}, or name the binary with --binary`, {
    fields: { binary: 'not found on PATH' },
  });
}

export interface EnableOptions {
  readonly root: string;
  readonly kind: RunnerKind;
  readonly allowApiBilling: boolean;
  readonly model?: string | null;
  /** The binary's absolute path; default: found on PATH. */
  readonly binary?: string;
  /** The environment runs will inherit. */
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /**
   * Asked when the preflight refuses only because runs would bill an API key,
   * a token or a cloud provider (the interactive enable): true allows it.
   */
  readonly allowBilling?: (why: string) => Promise<boolean>;
}

export interface EnableResult {
  readonly runner: RunnerConfig;
  /** What enabling said. */
  readonly warnings: string[];
  /** Codex: the MCP servers each run switches off (names only). */
  readonly mcp_servers?: readonly string[];
}

/** Runs the preflight in a fresh temp directory with the child's environment. */
async function preflightOnce(config: Pick<RunnerConfig, 'kind' | 'binary' | 'allow_api_billing'>, env: NodeJS.ProcessEnv): Promise<Preflight> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grimoire-runner-'));
  try {
    const cwd = path.join(root, 'cwd');
    await mkdir(cwd);
    return await preflight(config, cwd, childEnv(config.kind, env));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

/** Whether a preflight refusal is about billing only (and so allowing API billing could lift it). */
function billingOnly(error: unknown): boolean {
  if (!(error instanceof GrimoireError) || error.code !== 'INVALID') return false;
  const preflightDetails = error.details.preflight as { variables?: unknown; auth_method?: unknown } | undefined;
  if (!preflightDetails) return false;
  return Array.isArray(preflightDetails.variables) || ['api_key', 'api_key_helper', 'oauth_token', 'third_party'].includes(String(preflightDetails.auth_method));
}

/** Finds the binary, runs the preflight and stores the config. Nothing is stored when the preflight refuses. */
export async function enableRunner(options: EnableOptions): Promise<EnableResult> {
  const store = await storeAt(options.root);
  const binary = options.binary ?? (await findBinary(options.kind, options.env));
  await checkBinary(binary);
  let allow = options.allowApiBilling;
  let checked: Preflight;
  try {
    checked = await preflightOnce({ kind: options.kind, binary, allow_api_billing: allow }, options.env);
  } catch (error) {
    if (allow || !options.allowBilling || !billingOnly(error) || !(await options.allowBilling((error as GrimoireError).message))) throw error;
    allow = true;
    checked = await preflightOnce({ kind: options.kind, binary, allow_api_billing: allow }, options.env);
  }
  const runner: RunnerConfig = {
    kind: options.kind,
    binary,
    allow_api_billing: allow,
    model: options.model?.trim() ? options.model.trim() : null,
    enabled_at: (options.now?.() ?? new Date()).toISOString(),
    auth_method: checked.auth_method,
  };
  await writeRunnerConfig(store, runner);
  return { runner, warnings: enableWarnings(options.kind), ...(checked.mcp_servers ? { mcp_servers: checked.mcp_servers } : {}) };
}

/** Turns the runner off for this clone; `was` is the config it had. */
export async function disableRunner(root: string): Promise<{ disabled: boolean; was: RunnerConfig | null }> {
  const was = await removeRunnerConfig(await storeAt(root));
  return { disabled: was !== null, was };
}

export { readRunnerConfig };
