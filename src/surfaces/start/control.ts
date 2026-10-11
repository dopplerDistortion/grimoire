// The control channel (spec §12 `start` and `open`, §20; spike D, R5): how
// `open` and a second `start` ask the clone's running `start` for a fresh
// sign-in code, and how a takeover asks it to stop. Part of the frozen
// cross-pin contract (§21): other pins speak this protocol to this release's
// `start`, and this release to theirs, so it may only gain what older ones
// ignore.
//
// Transport: a Windows named pipe, `\\.\pipe\grimoire-<clone>-<nonce>`, or a
// Unix socket `<clone>-<nonce>.sock` in a 0700 directory with a short path
// (`$XDG_RUNTIME_DIR/grimoire`, else `/tmp/grimoire-<uid>`). `<clone>` is the
// first 12 hex digits of the per-clone id and `<nonce>` the live `start`
// lock's nonce, so a client reaches only the instance the lock names.
//
// Authentication (spike D's R5 verdict): a pipe's default DACL lets Everyone
// read it and Node can't narrow it, so every request proves knowledge of a
// per-user secret that never crosses the channel. `start` writes the secret
// fresh before it listens: `%LOCALAPPDATA%\grimoire\control\<clone16>.secret`
// on Windows (its inherited ACL admits only SYSTEM, Administrators and the
// user), `<socket dir>/<clone16>.secret` (0600) elsewhere.
//
// Protocol 1, one request per connection, each message one line of JSON:
//
//   → {"v":1,"op":"sign-in"|"stop","args":"<JSON text>","nonce":"<32 hex>","at":<epoch ms>,"mac":"<64 hex>"}
//   ← {"v":1,"ok":true,"result":"<JSON text>","mac":"<64 hex>"}
//   ← {"v":1,"ok":false,"error":"<JSON text {code, message}>","mac":"<64 hex>"}
//
// The request's mac is HMAC-SHA256(secret, "grimoire-control\n1\n<op>\n<nonce>\n<at>\n<args>"),
// the reply's HMAC-SHA256(secret, "grimoire-control\n1\nreply\n<nonce>\n<ok|error>\n<result or error>").
// The server writes nothing on a connection until its request is verified: a
// bad mac, a stale `at` (more than 60 s away) or a reused nonce closes it
// unanswered. The client checks the reply's mac, so a squatter can't answer.
// `v` stays 1: later releases may add fields (outside the mac) and ops, which
// an older `start` ignores or answers with the error code UNKNOWN_OP.
//
//   sign-in  args {"ref"?: string}  →  {"url", "port", "version", "pin", "pid"}
//   stop     args {}                →  {"stopping": true, "pid"}
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const CONTROL_PROTOCOL = 1;
const DOMAIN = 'grimoire-control';
/** How far a request's `at` may be from the server's clock. */
const MAX_SKEW_MS = 60_000;
/** The longest request or reply line read. */
const MAX_LINE = 64 * 1024;
/** How long a connection may take to send its request. */
const REQUEST_TIMEOUT_MS = 5_000;

export type ControlOp = 'sign-in' | 'stop';

export interface ControlPaths {
  /** The pipe path or socket file a client connects to. */
  readonly endpoint: string;
  /** The per-user secret file. */
  readonly secretFile: string;
  /** The directory that holds the secret (and, outside Windows, the socket). */
  readonly dir: string;
}

/** Where the control channel's files live for this user (uninstall removes the clone's). */
export function controlDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'grimoire', 'control');
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) return path.join(runtime, 'grimoire');
  // Short on purpose: a socket path has ~104 bytes (macOS' os.tmpdir() is too long).
  return path.join('/tmp', `grimoire-${os.userInfo().uid}`);
}

/** The control channel of the `start` whose lock holds `nonce`, for the clone `cloneId` names. */
export function controlPaths(cloneId: string, nonce: string, env: NodeJS.ProcessEnv = process.env): ControlPaths {
  const dir = controlDir(env);
  const secretFile = path.join(dir, `${cloneId.slice(0, 16)}.secret`);
  const name = `${cloneId.slice(0, 12)}-${nonce}`;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\grimoire-${name}` : path.join(dir, `${name}.sock`);
  return { endpoint, secretFile, dir };
}

function mac(secret: string, parts: readonly (string | number)[]): string {
  return createHmac('sha256', secret).update([DOMAIN, String(CONTROL_PROTOCOL), ...parts.map(String)].join('\n'), 'utf8').digest('hex');
}

function sameHex(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !/^[0-9a-f]{64}$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Makes the directory the secret (and socket) live in: 0700 and this user's own, outside Windows. */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const info = await lstat(dir);
  const uid = os.userInfo().uid;
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error(`${dir} must be a directory only this user can use (mode 0700), so grimoire won't put its control socket there`);
  }
}

/** Reads one line (up to MAX_LINE bytes) from `socket`; null when it closes or overflows first. */
function readLine(socket: net.Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const finish = (line: string | null) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      resolve(line);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) return finish(buffer.subarray(0, newline).toString('utf8'));
      if (buffer.length > MAX_LINE) finish(null);
    };
    const onEnd = () => finish(null);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.once('error', onEnd);
  });
}

export interface ControlRequest {
  readonly op: string;
  readonly args: Record<string, unknown>;
}

/** What a handler answers: a result, or an error the client shows. */
export type ControlAnswer = { readonly result: unknown } | { readonly error: { readonly code: string; readonly message: string } };

export interface ControlServer {
  readonly paths: ControlPaths;
  /** Stops listening and removes the secret (when it is still this server's). */
  close(): Promise<void>;
}

/**
 * Writes a fresh secret, then listens. `handle` answers each verified request;
 * `after` runs once its reply is flushed (a `stop` shuts down there).
 */
export async function serveControl(
  paths: ControlPaths,
  handle: (request: ControlRequest) => Promise<{ answer: ControlAnswer; after?: () => void }>,
): Promise<ControlServer> {
  await ensureDir(paths.dir);
  const secret = randomBytes(32).toString('hex');
  await rm(paths.secretFile, { force: true });
  await writeFile(paths.secretFile, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  const seen = new Map<string, number>();
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    void (async () => {
      const line = await readLine(socket);
      const request = line === null ? null : verify(line);
      // Nothing is written on a connection whose request isn't verified.
      if (request === null) return void socket.destroy();
      socket.setTimeout(0);
      let answer: ControlAnswer;
      let after: (() => void) | undefined;
      try {
        ({ answer, after } = await handle({ op: request.op, args: request.args }));
      } catch (error) {
        answer = { error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } };
      }
      const ok = 'result' in answer;
      const text = JSON.stringify('result' in answer ? (answer.result ?? null) : answer.error);
      const reply = {
        v: CONTROL_PROTOCOL,
        ok,
        [ok ? 'result' : 'error']: text,
        mac: mac(secret, ['reply', request.nonce, ok ? 'ok' : 'error', text]),
      };
      socket.end(`${JSON.stringify(reply)}\n`, () => after?.());
    })();
  });

  const verify = (line: string): { op: string; args: Record<string, unknown>; nonce: string } | null => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    const { v, op, args, nonce, at } = message;
    if (v !== CONTROL_PROTOCOL || typeof op !== 'string' || typeof args !== 'string') return null;
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce) || typeof at !== 'number') return null;
    const now = Date.now();
    if (Math.abs(now - at) > MAX_SKEW_MS || seen.has(nonce)) return null;
    if (!sameHex(message.mac, mac(secret, [op, nonce, at, args]))) return null;
    for (const [old, when] of seen) if (now - when > 2 * MAX_SKEW_MS) seen.delete(old);
    seen.set(nonce, now);
    try {
      const parsed: unknown = JSON.parse(args);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return { op, args: parsed as Record<string, unknown>, nonce };
    } catch {
      return null;
    }
  };

  // Never readableAll/writableAll: they only widen the pipe's DACL (spike D).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();

  return {
    paths,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      // A newer `start` may have written its own secret since: leave that one.
      const current = await readFile(paths.secretFile, 'utf8').catch(() => null);
      if (current?.trim() === secret) await rm(paths.secretFile, { force: true }).catch(() => {});
    },
  };
}

/** Removes socket files a killed `start` of this clone left (never the live one's). */
export async function removeStaleSockets(paths: ControlPaths): Promise<void> {
  if (process.platform === 'win32') return;
  const own = path.basename(paths.endpoint);
  const prefix = own.slice(0, own.indexOf('-') + 1);
  for (const name of await readdir(paths.dir).catch(() => [] as string[])) {
    if (name !== own && name.startsWith(prefix) && name.endsWith('.sock')) await rm(path.join(paths.dir, name), { force: true }).catch(() => {});
  }
}

/** Why a control request got no answer. */
export class ControlError extends Error {
  constructor(
    message: string,
    /** `unreachable`: nothing listens; `refused`: it closed without answering (the secret didn't match); `failed`: it answered with an error. */
    readonly reason: 'unreachable' | 'refused' | 'failed',
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

/** Sends one request to the `start` at `paths` and returns its verified result. */
export async function callControl(
  paths: ControlPaths,
  op: ControlOp,
  args: Record<string, unknown> = {},
  options: { readonly timeoutMs?: number; readonly secret?: string } = {},
): Promise<unknown> {
  const secret =
    options.secret ??
    (await readFile(paths.secretFile, 'utf8').then(
      (text) => text.trim(),
      () => {
        throw new ControlError(`the running grimoire start's secret file ${paths.secretFile} can't be read`, 'unreachable');
      },
    ));
  const nonce = randomBytes(16).toString('hex');
  const at = Date.now();
  const text = JSON.stringify(args);
  const request = { v: CONTROL_PROTOCOL, op, args: text, nonce, at, mac: mac(secret, [op, nonce, at, text]) };
  const socket = net.connect(paths.endpoint);
  const timer = setTimeout(() => socket.destroy(), options.timeoutMs ?? 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', (error) => reject(new ControlError(`grimoire start isn't listening on its control channel (${(error as NodeJS.ErrnoException).code ?? error.message})`, 'unreachable')));
    });
    socket.write(`${JSON.stringify(request)}\n`);
    const line = await readLine(socket);
    if (line === null) throw new ControlError('grimoire start closed the control channel without answering', 'refused');
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ControlError('grimoire start answered something that is not JSON', 'refused');
    }
    const ok = reply.ok === true;
    const body = ok ? reply.result : reply.error;
    if (reply.v !== CONTROL_PROTOCOL || typeof body !== 'string' || !sameHex(reply.mac, mac(secret, ['reply', nonce, ok ? 'ok' : 'error', body]))) {
      throw new ControlError('the control channel answered without proof of the secret', 'refused');
    }
    const value: unknown = JSON.parse(body);
    if (ok) return value;
    const error = (value ?? {}) as { code?: unknown; message?: unknown };
    throw new ControlError(typeof error.message === 'string' ? error.message : 'grimoire start refused the request', 'failed', typeof error.code === 'string' ? error.code : undefined);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
