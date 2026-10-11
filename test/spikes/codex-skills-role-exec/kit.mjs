// Spike F (GOK-131) kit: shared helpers for the scenario scripts. Each run gets
// a throwaway CODEX_HOME (never ~/.codex) and the scripted Responses API
// stand-in (scripted-responses.mjs). Spike scaffolding, never part of the package.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * One request the stand-in logged.
 * @typedef {{ at: string, method: string, url: string, headers: Record<string, string>, auth: { scheme: string, length: number } | null, body: any }} LoggedRequest
 */

export const KIT = path.dirname(fileURLToPath(import.meta.url));

/** The native codex.exe behind the npm shim (the runner spawns the .exe, never the .cmd). */
export function codexExe() {
  if (process.env.CODEX_EXE) return process.env.CODEX_EXE;
  const prefix = spawnSync('npm prefix -g', { encoding: 'utf8', shell: true }).stdout.trim();
  const exe = path.join(
    prefix,
    'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  );
  if (!existsSync(exe)) throw new Error(`codex.exe not found at ${exe}`);
  return exe;
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the stand-in with a fresh request log in `stateDir`.
 * @param {string} stateDir
 */
export async function startMock(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  rmSync(path.join(stateDir, 'port'), { force: true });
  rmSync(path.join(stateDir, 'requests.jsonl'), { force: true });
  const child = spawn(process.execPath, [path.join(KIT, 'scripted-responses.mjs'), stateDir], { stdio: 'inherit' });
  for (let i = 0; i < 100 && !existsSync(path.join(stateDir, 'port')); i++) await sleep(50);
  const port = Number(readFileSync(path.join(stateDir, 'port'), 'utf8'));
  return { port, stop: () => child.kill(), requests: () => readRequests(stateDir) };
}

/**
 * @param {string} stateDir
 * @returns {LoggedRequest[]}
 */
export function readRequests(stateDir) {
  const file = path.join(stateDir, 'requests.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Every file under `dir`, recursively.
 * @param {string} dir
 * @returns {string[]}
 */
export function findFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? findFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

/**
 * @param {string} cwd
 * @param {...string} args
 */
export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A fresh git repo with one empty commit.
 * @param {string} dir
 */
export function mkRepo(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '.');
  git(dir, '-c', 'user.email=a@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/**
 * @param {string} file
 * @param {string} text
 */
export function writeFile(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Provider lines pointing Codex at the stand-in, as TOML.
 * @param {number} port
 */
export const providerToml = (port) =>
  `model = "gpt-5.5"\nmodel_provider = "mock"\n\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`;

/**
 * The same provider as `-c` overrides, for runs that ignore the user config.
 * @param {number} port
 */
export const providerArgs = (port) => [
  '-c',
  `model_providers.mock={ name = "mock", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses" }`,
  '-c',
  'model_provider="mock"',
  '-c',
  'model="gpt-5.5"',
];

/**
 * A fresh CODEX_HOME whose config.toml points at the stand-in and trusts `trust`.
 * @param {string} home
 * @param {number} port
 * @param {{ trust?: string[], extra?: string }} [options]
 */
export function writeHome(home, port, { trust = [], extra = '' } = {}) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const trustToml = trust.map((dir) => `[projects.'${dir}']\ntrust_level = "trusted"\n`).join('\n');
  writeFileSync(path.join(home, 'config.toml'), `${providerToml(port)}\n${extra}\n${trustToml}`);
  return home;
}

/**
 * Runs codex.exe and resolves {code, stdout, stderr, ms}.
 * @param {string[]} args
 * @param {{ cwd: string, home: string, env?: Record<string, string>, stdin?: string, timeoutMs?: number }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, ms: number }>}
 */
export function runCodex(args, { cwd, home, env = {}, stdin = '', timeoutMs = 180_000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(codexExe(), args, {
      cwd,
      env: { ...process.env, CODEX_HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/**
 * Drives `codex app-server` (the same core the TUI uses): one thread, one turn
 * per prompt, waiting for turn/completed each time. Resolves the thread id.
 * @param {{ home: string, cwd: string, prompts: string[], threadParams?: Record<string, unknown>, betweenTurns?: (n: number) => Promise<void> }} options
 */
export async function appServerTurns({ home, cwd, prompts, threadParams = {}, betweenTurns = async () => {} }) {
  const child = spawn(codexExe(), ['app-server'], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  /** @type {(msg: any) => void} */
  let onNotification = () => {};
  /** @type {any[]} */
  const notifications = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      notifications.push(msg);
      onNotification(msg);
    }
  });
  let nextId = 0;
  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<any>}
   */
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) =>
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result))),
    );
  };
  await request('initialize', { clientInfo: { name: 'gok131_probe', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  const started = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', ...threadParams });
  const threadId = started.thread.id;
  /** @type {(string | null)[]} */
  const statuses = [];
  for (const [n, text] of prompts.entries()) {
    if (n > 0) await betweenTurns(n);
    /** @type {Promise<any>} */
    const done = new Promise((resolve) => {
      onNotification = (msg) => {
        if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) resolve(msg.params);
      };
    });
    await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const completed = await done;
    statuses.push(completed.turn?.status ?? null);
  }
  child.kill();
  return { threadId, statuses, notifications };
}

/**
 * The scripted model's plan, as the prompt text the stand-in looks for.
 * @param {unknown[]} steps
 */
export const plan = (steps) => `PLAN: ${JSON.stringify(steps)}`;
