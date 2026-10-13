// The child's environment and the billing guard (spec §16 Billing guard;
// spike D P6, spike F C4). The guard runs before every run, with the child's
// exact environment and cwd, and reads only what the client itself reports:
// credential files are never read.
import { GrimoireError } from '../errors';
import type { RunnerConfig, RunnerKind } from './config';
import { CLAUDE_AUTH_ARGS, CODEX_LOGIN_ARGS, CODEX_MCP_LIST_ARGS } from './invocation';
import { runProcess } from './process';

const PREFLIGHT_TIMEOUT_MS = 60_000;

/**
 * Variables the child never inherits: bare mode (`CLAUDE_CODE_SIMPLE=1`
 * reports `none` and fails every `-p` run, P6), and a parent agent session's
 * markers and ids, which would tie the child to that session (spike D).
 */
const DROPPED = ['CLAUDE_CODE_SIMPLE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SESSION_ID', 'GRIMOIRE_CHORE_ORIGIN'];
const DROPPED_PREFIXES = ['CLAUDE_CODE_MESSAGING_'];

/** The child's environment: the caller's, less the dropped variables, plus the client's runner settings. */
export function childEnv(kind: RunnerKind, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || DROPPED.includes(upper) || DROPPED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    env[key] = value;
  }
  if (kind === 'claude') env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

/** Credentials in the environment that outrank the plan's login, by client. */
const BILLED_VARIABLES: Readonly<Record<RunnerKind, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
};

function setIn(env: NodeJS.ProcessEnv, name: string): boolean {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key !== undefined && (env[key] ?? '').trim() !== '';
}

const ALLOW_HINT = 'unset it, or enable the runner with --allow-api-billing to let runs bill it';

/** INVALID: the preflight refused the run; nothing ran. */
export function refused(message: string, preflight: Record<string, unknown>): GrimoireError {
  return new GrimoireError('INVALID', message, { fields: { preflight: 'refused' }, preflight });
}

/** The auth methods `claude auth status` reports that bill something other than the plan (P6). */
const BILLED_METHODS = ['api_key', 'api_key_helper', 'oauth_token', 'third_party'];

export interface Preflight {
  /** What the client reported: `claude.ai`, `api_key`, … (Claude); `chatgpt` or `api_key` (Codex). */
  readonly auth_method: string;
  /** Codex: the MCP servers the run switches off, by name. */
  readonly mcp_servers?: readonly string[];
}

/**
 * The billing guard (and, for Codex, the MCP server list): refuses the run
 * unless the client would bill the plan, or API billing is allowed. `cwd` and
 * `env` are the child's own; `signal` kills a client call under way (the runner stopping).
 */
export async function preflight(
  config: Pick<RunnerConfig, 'kind' | 'binary' | 'allow_api_billing'>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Preflight> {
  if (!config.allow_api_billing) {
    const billed = BILLED_VARIABLES[config.kind].filter((name) => setIn(env, name));
    if (billed.length > 0) {
      throw refused(`the runner won't start ${config.kind}: ${billed.join(', ')} ${billed.length === 1 ? 'is' : 'are'} set, so runs would bill ${billed.length === 1 ? 'it' : 'them'} instead of your plan; ${ALLOW_HINT}`, {
        kind: config.kind,
        variables: billed,
      });
    }
  }
  return config.kind === 'claude' ? claudePreflight(config, cwd, env, signal) : codexPreflight(config, cwd, env, signal);
}

async function claudePreflight(config: Pick<RunnerConfig, 'binary' | 'allow_api_billing'>, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Preflight> {
  const run = await runProcess(config.binary, CLAUDE_AUTH_ARGS, { cwd, env, timeoutMs: PREFLIGHT_TIMEOUT_MS, signal });
  // Parsed whatever the exit code: `none` exits 1 with its JSON on stdout (P6).
  let method: unknown;
  try {
    method = (JSON.parse(run.stdout) as { authMethod?: unknown }).authMethod;
  } catch {
    method = undefined;
  }
  if (typeof method !== 'string') {
    throw refused(`the runner's preflight failed: \`claude auth status\` didn't report an auth method${run.spawnError ? ` (${run.spawnError})` : run.timedOut ? ' (timed out)' : ''}`, {
      kind: 'claude',
      auth_method: null,
    });
  }
  if (method === 'claude.ai') return { auth_method: method };
  if (method === 'none') {
    throw refused('the runner won\'t start claude: it isn\'t logged in (auth method none); run `claude` and log in with your plan', { kind: 'claude', auth_method: method });
  }
  if (BILLED_METHODS.includes(method)) {
    if (config.allow_api_billing) return { auth_method: method };
    throw refused(`the runner won't start claude: its auth method is ${method}, which bills outside your plan; ${ALLOW_HINT}`, { kind: 'claude', auth_method: method });
  }
  throw refused(`the runner's preflight failed: \`claude auth status\` reported an auth method this release doesn't know (${method.slice(0, 40)})`, { kind: 'claude', auth_method: method.slice(0, 40) });
}

async function codexPreflight(config: Pick<RunnerConfig, 'binary' | 'allow_api_billing'>, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Preflight> {
  // Never logged: an API-key login prints the key, partly masked.
  const login = await runProcess(config.binary, CODEX_LOGIN_ARGS, { cwd, env, timeoutMs: PREFLIGHT_TIMEOUT_MS, signal });
  const said = `${login.stdout}\n${login.stderr}`;
  let method: string;
  if (/Logged in using ChatGPT/.test(said)) method = 'chatgpt';
  else if (/Logged in using an API key/.test(said)) method = 'api_key';
  else {
    throw refused('the runner won\'t start codex: `codex login status` doesn\'t show a login; run `codex login` with your ChatGPT plan', { kind: 'codex', auth_method: 'none' });
  }
  if (method === 'api_key' && !config.allow_api_billing) {
    throw refused(`the runner won't start codex: it is logged in with an API key, which bills outside your plan; ${ALLOW_HINT}`, { kind: 'codex', auth_method: method });
  }
  return { auth_method: method, mcp_servers: await codexMcpServers(config.binary, cwd, env, signal) };
}

/**
 * The MCP servers a Codex run would start, by name only (spike F): listed with
 * the exec's overrides, in its cwd and env. Never logged: a server's `env` can
 * hold secrets. A list that fails refuses the run.
 */
async function codexMcpServers(binary: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string[]> {
  const run = await runProcess(binary, CODEX_MCP_LIST_ARGS, { cwd, env, timeoutMs: PREFLIGHT_TIMEOUT_MS, signal });
  let names: string[] | null = null;
  if (run.code === 0) {
    try {
      const listed = JSON.parse(run.stdout) as unknown;
      if (Array.isArray(listed) && listed.every((entry) => typeof (entry as { name?: unknown })?.name === 'string')) {
        names = listed.map((entry) => (entry as { name: string }).name);
      }
    } catch {
      names = null;
    }
  }
  if (names === null) {
    throw refused(
      'the runner won\'t start codex: `codex mcp list --json` failed, so it can\'t tell which of your MCP servers to switch off for the run',
      { kind: 'codex', mcp_list: 'failed' },
    );
  }
  return names;
}
