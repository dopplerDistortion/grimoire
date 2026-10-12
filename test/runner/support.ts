// Shared setup for the runner tests (seam 1; spec §16 The runner): stand-in
// `claude` and `codex` executables on PATH that record their argv, env, cwd
// and stdin (./fake-agent.mjs), answering with real client output
// (test/fixtures/claude-code/print-json, auth-status; test/fixtures/codex/exec-json/runner).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeExecutable, makeTempDir, readFixture, readFixtureJson, removeDir } from '#harness';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

/** Every variable that marks an agent shell, names its session, or picks a billed credential: the tests' base env has none. */
const STRIPPED = [
  'AI_AGENT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_PROJECT_DIR',
  'CODEX_CI',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_VERSION',
  'CODEX_SANDBOX',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'GRIMOIRE_CHORE_ORIGIN',
];

export interface PlannedCall {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Codex: what the run writes to its `-o` file. */
  out?: string;
  /** Sleeps this long before answering (a hung client); its pid goes to `<name>.pid`. */
  sleepMs?: number;
}

export interface Plan {
  auth?: PlannedCall;
  login?: PlannedCall;
  mcp?: PlannedCall;
  answers?: PlannedCall[];
}

export interface RecordedCall {
  type: 'auth' | 'login' | 'mcp' | 'answer';
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** The cwd's entries when the call started. */
  cwdEntries: string[] | null;
  stdin: string;
}

export interface FakeAgents {
  /** The folder on PATH holding both stand-ins. */
  readonly bin: string;
  /** The stand-ins' absolute paths. */
  readonly claude: string;
  readonly codex: string;
  /** A person's env with the stand-ins first on PATH, plus `extra`. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  plan(name: 'claude' | 'codex', plan: Plan): Promise<void>;
  calls(name: 'claude' | 'codex'): RecordedCall[];
  cleanup(): Promise<void>;
}

export async function fakeAgents(): Promise<FakeAgents> {
  const bin = await makeTempDir('grimoire-fake-agents-');
  const claude = await fakeExecutable(bin, 'claude', FAKE_AGENT);
  const codex = await fakeExecutable(bin, 'codex', FAKE_AGENT);
  return {
    bin,
    claude,
    codex,
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) if (!STRIPPED.includes(key)) env[key] = value;
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
      env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
      return { ...env, ...extra };
    },
    async plan(name, plan) {
      await writeFile(path.join(bin, `${name}.plan.json`), JSON.stringify(plan));
    },
    calls(name) {
      const dir = path.join(bin, `${name}.calls`);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .sort()
        .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as RecordedCall);
    },
    cleanup: () => removeDir(bin),
  };
}

/** `claude auth status` printing the auth-status fixture `name` (none exits 1, as observed). */
export function authStatus(name: 'claude-ai' | 'api-key' | 'api-key-helper' | 'oauth-token' | 'third-party-bedrock' | 'none'): PlannedCall {
  return { stdout: readFixture(`claude-code/auth-status/${name}.json`), code: name === 'none' ? 1 : 0 };
}

/** `claude -p --output-format json` answering `answer` as its structured output (the success fixture's shape). */
export function claudeAnswer(answer: unknown): PlannedCall {
  const shape = readFixtureJson<Record<string, unknown>>('claude-code/print-json/success-structured-output.json');
  return { stdout: `${JSON.stringify({ ...shape, result: JSON.stringify(answer), structured_output: answer })}\n`, code: 0 };
}

/** A `claude -p` run that never satisfied the schema (exit 1, `error_max_turns`, no structured output). */
export function claudeMaxTurns(): PlannedCall {
  return { stdout: readFixture('claude-code/print-json/error-max-turns.json'), code: 1 };
}

/** `codex exec --json` succeeding with `answer` in its `-o` file (the fallback invocation's events). */
export function codexAnswer(answer: unknown): PlannedCall {
  return { stdout: readFixture('codex/exec-json/runner/fallback-final.jsonl'), code: 0, out: JSON.stringify(answer) };
}

/** A model API error: `error` then `turn.failed`, exit 1, no `-o` file. */
export function codexApiError(): PlannedCall {
  return { stdout: readFixture('codex/exec-json/runner/model-api-error.jsonl'), code: 1 };
}

/** The first ancestor of `dir` holding `.git`, or null. */
export function gitAncestor(dir: string): string | null {
  let at = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(at, '.git'))) return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

export { makeTempDir };
