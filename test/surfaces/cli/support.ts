// Seam 3 (spec Testing Decisions): the real `grimoire` CLI, built exactly as
// `npm run build` builds it, spawned against temporary repos.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';

export { buildGrimoire } from '../mcp/support';

/**
 * Every variable that marks an agent shell or names its session (spec §7,
 * spikes A and E). The test process itself may run inside an agent's shell,
 * so a "human" run strips them all.
 */
const AGENT_VARIABLES = [
  'AI_AGENT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_VERSION',
  'CODEX_SANDBOX',
];

/** The test process's environment without any agent marker, plus `extra`. */
export function humanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AGENT_VARIABLES.includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface CliRun {
  code: number | null;
  /** stdout, parsed: the CLI always prints exactly one JSON object there. */
  json: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/** Asserts `stdout` is exactly one JSON object (whitespace around it allowed) and returns it. */
export function oneJsonObject(stdout: string, stderr = ''): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not one JSON document:\n${stdout}\nstderr:\n${stderr}`);
  }
  expect(parsed, stdout).toBeTypeOf('object');
  expect(parsed).not.toBeNull();
  expect(Array.isArray(parsed)).toBe(false);
  return parsed as Record<string, unknown>;
}

/** Runs `node <bin> ...args` in `cwd` with pipes (no TTY), as a person's shell unless `env` adds markers. */
export async function cli(
  bin: string,
  args: readonly string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): Promise<CliRun> {
  const result = await runCommand(process.execPath, [bin, ...args], {
    cwd: options.cwd,
    env: options.env ?? humanEnv(),
    input: options.input,
    timeoutMs: 60_000,
  });
  return { code: result.code, json: oneJsonObject(result.stdout, result.stderr), stdout: result.stdout, stderr: result.stderr };
}

export interface PtyRun {
  /** The CLI's exit code. */
  code: number | null;
  /** Everything the terminal showed, VT sequences removed. */
  screen: string;
}

/** Strips VT/ANSI control sequences, turning cursor-forward moves back into spaces. */
function plainText(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Number(n || '1')))
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\r/g, '');
}

/**
 * Wrapper run inside the pseudo terminal: runs the real command with the
 * terminal as its stdio, and records its exit code (a headless conhost
 * doesn't pass it on).
 */
const WRAPPER = `const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.GRIMOIRE_TEST_PTY);
const run = spawnSync(spec.command, spec.args, { stdio: 'inherit', cwd: spec.cwd, env: spec.env });
writeFileSync(spec.exitFile, String(run.status));
`;

/** Python relay for POSIX: runs argv in a fresh pty, relaying our stdin and stdout. */
const PTY_RELAY = 'import pty, sys\npty.spawn(sys.argv[1:])\n';

/**
 * Runs `node <bin> ...args` at an interactive terminal: a pseudo console on
 * Windows (`conhost --headless`, the ConPTY host), a pty elsewhere (Python's
 * `pty`). Each time the screen shows `answers[i].when`, types `answers[i].type`
 * and Enter.
 */
export async function cliAtTerminal(
  bin: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; answers?: { when: RegExp; type: string }[] },
): Promise<PtyRun> {
  const dir = await makeTempDir('grimoire-pty-');
  try {
    const wrapper = path.join(dir, 'wrapper.cjs');
    const exitFile = path.join(dir, 'exit');
    await writeFile(wrapper, WRAPPER);
    await writeFile(path.join(dir, 'relay.py'), PTY_RELAY);
    const spec = {
      command: process.execPath,
      args: [bin, ...args],
      cwd: options.cwd,
      env: options.env ?? humanEnv(),
      exitFile,
    };
    const env = { ...process.env, GRIMOIRE_TEST_PTY: JSON.stringify(spec) };
    // conhost re-parses its command line and eats backslashes: give it forward slashes.
    const forward = (p: string) => p.split(path.sep).join('/');
    const [command, commandArgs] =
      process.platform === 'win32'
        ? ['conhost.exe', ['--headless', '--width', '250', '--height', '50', '--', process.execPath, forward(wrapper)]]
        : ['python3', [path.join(dir, 'relay.py'), process.execPath, wrapper]];
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, commandArgs, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const answers = [...(options.answers ?? [])];
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the terminal session did not finish; it showed:\n${plainText(output)}`));
      }, 60_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        const next = answers[0];
        if (next && next.when.test(plainText(output))) {
          answers.shift();
          child.stdin.write(`${next.type}\r`);
        }
      });
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(output);
      });
    });
    const code = await readFile(exitFile, 'utf8')
      .then((text) => (text === 'null' ? null : Number(text)))
      .catch(() => null);
    return { code, screen: plainText(raw) };
  } finally {
    await removeDir(dir);
  }
}

/** The last JSON object a terminal screen shows (the CLI's stdout, among prompts and echoes). */
export function lastJsonOnScreen(screen: string): Record<string, unknown> {
  const lines = screen.split('\n').map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith('{')) continue;
    // Pretty-printed output spans lines: take from here to the line that closes it.
    for (let j = i; j < lines.length; j++) {
      try {
        return oneJsonObject(lines.slice(i, j + 1).join('\n'));
      } catch {
        // not closed yet
      }
    }
  }
  throw new Error(`no JSON object on the screen:\n${screen}`);
}
