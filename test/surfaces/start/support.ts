// Seam 3 (spec Testing Decisions): the real `grimoire start`, built exactly as
// `npm run build` builds it (CLI and dashboard), spawned against temporary
// repos and driven over HTTP, SSE and its control channel.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';
import { cloneId, MachineLocalStore, START_LOCK, startLockData } from '../../../src/machine-local';
import { callControl, controlPaths } from '../../../src/surfaces/start/control';
import { humanEnv } from '../cli/support';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && !key.startsWith('VITEST')) env[key] = value;
  }
  return env;
}

/** Builds the CLI and the dashboard (or only the CLI) into a temp `dist/`, at `version` (else package.json's). */
export async function buildFull(version?: string, target: 'all' | 'cli' = 'all'): Promise<{ bin: string; dist: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir('grimoire-start-build-');
  const dist = path.join(dir, 'dist');
  const result = await runCommand(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'build.mjs'), ...(target === 'cli' ? ['cli'] : []), '--out-dir', dist, ...(version ? ['--version', version] : [])],
    { cwd: repoRoot, env: buildEnv(), timeoutMs: 300_000 },
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return { bin: path.join(dist, 'grimoire.mjs'), dist, cleanup: () => removeDir(dir) };
}

/**
 * A person's environment for `start` in a test world: no agent marker, the
 * control channel's files in a directory of the test's own (the world's
 * LOCALAPPDATA on Windows, a short 0700 XDG_RUNTIME_DIR under /tmp elsewhere,
 * removed after the test), and a browser that only records the URLs it is
 * asked to open.
 */
export async function startEnv(worldRoot: string, extra: NodeJS.ProcessEnv = {}): Promise<{ env: NodeJS.ProcessEnv; opened: (count?: number) => Promise<string[]> }> {
  await mkdir(worldRoot, { recursive: true });
  const recorder = path.join(worldRoot, 'browser.mjs');
  const urls = path.join(worldRoot, 'opened.txt');
  await writeFile(recorder, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], process.argv[3] + '\\n');\n");
  let runtime: NodeJS.ProcessEnv = {};
  if (process.platform !== 'win32') {
    // Short: a socket path has ~104 bytes, and a world's root may be long (macOS' os.tmpdir()).
    const dir = await mkdtemp('/tmp/grt-');
    await chmod(dir, 0o700);
    // After every fixture's cleanup, so after the starts it spawned have stopped.
    onTestFinished(() => removeDir(dir));
    runtime = { XDG_RUNTIME_DIR: dir };
  }
  const env = humanEnv({
    LOCALAPPDATA: path.join(worldRoot, 'localappdata'),
    ...runtime,
    GRIMOIRE_BROWSER: JSON.stringify([process.execPath, recorder, urls]),
    ...extra,
  });
  /** The URLs opened so far, once there are `count` (the recorder runs detached, so it may lag). */
  const opened = async (count = 1) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const lines = (await readFile(urls, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
      if (lines.length >= count || Date.now() > deadline) return lines;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { env, opened };
}

export interface StartProcess {
  readonly child: ChildProcess;
  readonly port: number;
  readonly started: Record<string, unknown>;
  stderr(): string;
  /** Resolves with the exit code once it exits. */
  readonly exited: Promise<number | null>;
}

/** Spawns `start` in `cwd` and waits for its `{"started": …}` line. */
export function spawnStart(bin: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[] = ['--no-open']): Promise<StartProcess> {
  const child = spawn(process.execPath, [bin, 'start', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`start did not report serving within 60 s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 60_000);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`start exited ${code} before serving\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      const parsed = JSON.parse(stdout.slice(0, newline)) as { started?: Record<string, unknown>; error?: unknown };
      if (!parsed.started) return reject(new Error(`start printed ${stdout}\nstderr: ${stderr}`));
      resolve({ child, port: parsed.started.port as number, started: parsed.started, stderr: () => stderr, exited });
    });
  });
}

/** The clone's live start lock: its port and nonce. */
export async function startLockOf(commonDir: string): Promise<{ port: number; nonce: string; pid: number } | null> {
  const state = await new MachineLocalStore(commonDir).locks.inspect(START_LOCK);
  if (state.status !== 'held') return null;
  const data = startLockData(state.holder);
  return data ? { ...data, pid: state.holder.pid } : null;
}

/** Sends a control request to the clone's running start, as `open` and a second `start` do. */
export async function control(commonDir: string, env: NodeJS.ProcessEnv, op: 'sign-in' | 'stop', args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const lock = await startLockOf(commonDir);
  if (!lock) throw new Error('no start lock');
  return (await callControl(controlPaths(await cloneId(commonDir), lock.nonce, env), op, args)) as Record<string, unknown>;
}

/** Stops the clone's start over its control channel and waits for the process to exit (killing it after 20 s). */
export async function stopStart(process: StartProcess, commonDir: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  if (process.child.exitCode !== null) return process.child.exitCode;
  try {
    await control(commonDir, env, 'stop');
  } catch {
    process.child.kill();
  }
  const timer = setTimeout(() => process.child.kill(), 20_000);
  const code = await process.exited;
  clearTimeout(timer);
  return code;
}

/** The code inside a sign-in URL's fragment. */
export function codeOf(url: string): string {
  const fragment = new URL(url).hash.slice(1);
  const code = new URLSearchParams(fragment).get('code');
  if (!code) throw new Error(`no code in ${url}`);
  return code;
}

export interface HttpAnswer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  json(): Record<string, unknown>;
}

export interface HttpRequest {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** The Host header (default `127.0.0.1:<port>`). */
  readonly host?: string;
}

/** One request to 127.0.0.1:`port`, with full control of its headers. */
export function request(port: number, options: HttpRequest): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as Record<string, unknown> });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Same-origin write headers, as the dashboard's own pages send them. */
export function writeHeaders(port: number, cookie?: string): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${port}`,
    'x-grimoire': '1',
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  };
}

/** Exchanges `code` by POST /api/session; returns the `name=value` cookie it set. */
export async function exchange(port: number, code: string): Promise<{ answer: HttpAnswer; cookie: string | null }> {
  const answer = await request(port, { method: 'POST', path: '/api/session', headers: writeHeaders(port), body: JSON.stringify({ code }) });
  const setCookie = answer.headers['set-cookie']?.[0] ?? null;
  return { answer, cookie: setCookie ? setCookie.split(';')[0]! : null };
}

/** Signs in through the control channel, as `open` would, and returns the session cookie. */
export async function signedIn(port: number, commonDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { url } = (await control(commonDir, env, 'sign-in')) as { url: string };
  const { cookie } = await exchange(port, codeOf(url));
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

export interface SseEvent {
  readonly event: string;
  readonly id: string | null;
  readonly data: Record<string, unknown>;
  /** When it arrived, epoch ms. */
  readonly receivedAt: number;
}

/** A raw SSE client: every event as it arrives. */
export class SseClient {
  readonly events: SseEvent[] = [];
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  private end: () => void = () => {};
  private readonly waiters = new Set<() => void>();
  private constructor(private readonly req: http.ClientRequest) {
    this.ended = new Promise((resolve) => (this.end = resolve));
  }

  static connect(port: number, cookie: string, lastEventId?: string): Promise<SseClient> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { host: `127.0.0.1:${port}`, cookie, accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
        agent: false,
      });
      const client = new SseClient(req);
      req.on('response', (res) => {
        if (res.statusCode !== 200) return reject(new Error(`events answered ${res.statusCode}`));
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = 'message';
            let id: string | null = null;
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (data.length === 0) continue;
            client.events.push({ event, id, data: JSON.parse(data.join('\n')) as Record<string, unknown>, receivedAt: Date.now() });
            for (const wake of client.waiters) wake();
          }
        });
        res.on('error', () => {});
        res.on('end', () => client.end());
        resolve(client);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** The first event (from `from` on) that `match` accepts, within `timeoutMs`. */
  async next(match: (event: SseEvent) => boolean, timeoutMs = 10_000, from = 0): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.slice(from).find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching event within ${timeoutMs} ms; got ${JSON.stringify(this.events)}`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  close(): void {
    this.req.destroy();
  }
}
