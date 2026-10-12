// The dashboard's HTTP server (spec §20, Transport and auth, API): loopback
// only, a Host allowlist, the security headers, the browser session, the op
// API, the live events and the static app. Thin: every answer an op gives is
// exactly the core's.
//
//   GET  /health                      the start lock's probe: {"service","nonce"} (public)
//   POST /api/session                 exchanges a sign-in code for the session cookie
//   GET  /api/session                 who is signed in, since when
//   DELETE /api/session               signs out
//   GET  /api/instance                the running version, the launch worktree's pin, the port
//   GET  /api/events                  the live events (./events.ts)
//   GET  /api/op/<name>?input=<JSON>  a read op
//   POST /api/op/<name>               a write op, its input the JSON body
//   GET  /open?ref=<text>             to the issue or attempt any text with a full id names
//   GET  anything else                the static app: index.html (no-cache) for every route
//
// Every `/api` path but the sign-in needs the session (401 NO_SESSION, checked
// first); non-GET requests, the sign-in included, also need a same-origin
// `Origin` and `X-Grimoire: 1` (403 INVALID).
import { readFile, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { CallContext, Core } from '../../core';
import { GrimoireError, type ErrorBody, type ErrorCode } from '../../errors';
import { START_HEALTH_PATH, START_SERVICE } from '../../machine-local';
import { errorBodyOf } from '../internal';
import type { LiveEvents } from './events';
import { sessionCookieName, type SignIns } from './sign-in';

/** The CSP every response carries (spec §20, exact). */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** The hostnames the dashboard answers to, with any port (spec §20). */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The largest request body read. */
const MAX_BODY = 16 * 1024 * 1024;

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID: 400,
  NO_SESSION: 401,
  HUMAN_ONLY: 403,
  NOT_FOUND: 404,
  INTERNAL: 500,
  BUSY: 503,
};

/** A full issue id (with its collision suffix, if any) or an attempt handle inside any text. */
const ISSUE_IN_TEXT = /\bgr-[0-9a-hjkmnp-tv-z]{5,8}(?:~[0-9a-f]{4})?(?![0-9a-z])/;
const ATTEMPT_IN_TEXT = /\bat-[0-9a-hjkmnp-tv-z]{6}(?![0-9a-z])/;

export interface DashboardServerOptions {
  readonly core: Core;
  /** The call context of a dashboard call: surface `dashboard`, the launch worktree, the git identity. */
  readonly context: () => Promise<CallContext>;
  /** The per-clone id: names the session cookie. */
  readonly cloneId: string;
  /** The `start` lock's nonce: the health probe echoes it. */
  readonly nonce: string;
  /** The built dashboard (`dist/dashboard`). */
  readonly assetsDir: string;
  readonly signIns: SignIns;
  readonly live: LiveEvents;
  /** What `GET /api/instance` answers. */
  readonly instance: () => Promise<Record<string, unknown>>;
  /** Unexpected failures, for stderr. */
  readonly log: (line: string) => void;
}

function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;
  const match = /^(\[[0-9a-fA-F:.]*\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return match ? match[1]!.toLowerCase() : null;
}

function cookieOf(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function setHeaders(response: ServerResponse, headers: Readonly<Record<string, string | string[]>>): void {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
}

function json(response: ServerResponse, status: number, value: unknown, headers: Readonly<Record<string, string | string[]>> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  setHeaders(response, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.writeHead(status, { 'content-length': String(body.length) });
  response.end(body);
}

function failure(response: ServerResponse, body: ErrorBody, headers: Readonly<Record<string, string | string[]>> = {}, status?: number): void {
  json(response, status ?? STATUS[body.code] ?? 409, { error: body }, headers);
}

function refusal(code: ErrorCode, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return new GrimoireError(code, message, details).toBody();
}

function text(response: ServerResponse, status: number, message: string): void {
  setHeaders(response, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.writeHead(status);
  response.end(`${message}\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new GrimoireError('INVALID', 'the request body is too large', { fields: { body: 'at most 16 MB' } });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(raw: string, field: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new GrimoireError('INVALID', `the ${field} must be JSON`, { fields: { [field]: 'not valid JSON' } });
  }
}

/** Where `/open?ref=` lands: the issue or attempt a full id in `ref` names, else home. */
export function openTarget(ref: string): string {
  const lower = ref.toLowerCase();
  const issue = ISSUE_IN_TEXT.exec(lower)?.[0];
  if (issue) return `/issues/${issue}`;
  const attempt = ATTEMPT_IN_TEXT.exec(lower)?.[0];
  return attempt ? `/attempts/${attempt}` : '/';
}

export function createDashboardServer(options: DashboardServerOptions): http.Server {
  const cookieName = sessionCookieName(options.cloneId);
  const assetsDir = path.resolve(options.assetsDir);

  /** A non-GET request's same-origin `Origin` and `X-Grimoire: 1`: the refusal when either is missing, else null. */
  const crossSite = (request: IncomingMessage): ErrorBody | null => {
    const method = request.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') return null;
    const host = request.headers.host?.trim().toLowerCase();
    const origin = request.headers.origin?.trim().toLowerCase();
    if (!origin || origin !== `http://${host}`) {
      return refusal('INVALID', 'the dashboard takes writes only from its own pages (same-origin Origin)', { fields: { origin: 'must be this dashboard’s own origin' } });
    }
    if (request.headers['x-grimoire'] !== '1') {
      return refusal('INVALID', 'the dashboard takes writes only with the X-Grimoire: 1 header', { fields: { 'x-grimoire': 'must be 1' } });
    }
    return null;
  };

  const api = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const method = request.method ?? 'GET';
    if (url.pathname === '/api/session' && method === 'POST') {
      // The sign-in itself needs no session, only a request from the dashboard's own page.
      const refused = crossSite(request);
      if (refused) return failure(response, refused, {}, 403);
      const input = parseJson(await readBody(request), 'body') as { code?: unknown } | null;
      const token = options.signIns.exchange(input && typeof input === 'object' ? input.code : undefined);
      if (token === null) {
        return failure(response, refusal('NO_SESSION', 'this sign-in code is unknown, already used or expired; run `grimoire open` in a terminal for a new one'));
      }
      const session = options.signIns.session(token)!;
      return json(response, 200, { signed_in: true, since: new Date(session.since).toISOString() }, {
        'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    const cookie = cookieOf(request, cookieName);
    const session = options.signIns.session(cookie);
    if (!session) {
      return failure(response, refusal('NO_SESSION', 'this browser isn’t signed in to the dashboard; run `grimoire open` in a terminal to sign in'));
    }
    // The session cookie also rides along from another page on 127.0.0.1 (same site, another port).
    const refused = crossSite(request);
    if (refused) return failure(response, refused, {}, 403);
    if (url.pathname === '/api/session') {
      if (method === 'DELETE') {
        options.signIns.revoke(cookie);
        return json(response, 200, { signed_in: false }, { 'set-cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (method === 'GET') {
        const ctx = await options.context();
        return json(response, 200, { signed_in: true, since: new Date(session.since).toISOString(), identity: ctx.person });
      }
    }
    if (url.pathname === '/api/instance' && method === 'GET') return json(response, 200, await options.instance());
    if (url.pathname === '/api/events' && method === 'GET') {
      const last = request.headers['last-event-id'];
      options.live.attach(request, response, typeof last === 'string' ? last : url.searchParams.get('last_event_id'));
      return;
    }
    const opName = /^\/api\/op\/([a-z][a-z0-9_]*)$/.exec(url.pathname)?.[1];
    if (opName !== undefined) return op(request, response, url, opName);
    return failure(response, refusal('NOT_FOUND', `there is no dashboard API at ${url.pathname}`));
  };

  const op = async (request: IncomingMessage, response: ServerResponse, url: URL, name: string): Promise<void> => {
    const method = request.method ?? 'GET';
    const descriptor = options.core.ops.find((candidate) => candidate.name === name);
    if (descriptor?.kind === 'read' && method !== 'GET') {
      return failure(response, refusal('INVALID', `${name} is a read: GET /api/op/${name}?input=<JSON>`, { fields: { method: 'must be GET' } }), { allow: 'GET' });
    }
    if (descriptor?.kind === 'write' && method !== 'POST') {
      return failure(response, refusal('INVALID', `${name} is a write: POST /api/op/${name} with a JSON body`, { fields: { method: 'must be POST' } }), { allow: 'POST' });
    }
    const input = method === 'GET' ? parseJson(url.searchParams.get('input') ?? '', 'input') : parseJson(await readBody(request), 'body');
    const outcome = await options.core.call(name, input, await options.context());
    if (outcome.ok) return json(response, 200, outcome.result);
    return failure(response, outcome.error);
  };

  const serveStatic = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      return text(response, 400, 'grimoire: a malformed path');
    }
    const head = request.method === 'HEAD';
    const safe = !relative.includes('\0') && !relative.split(/[\\/]/).includes('..');
    const file = path.resolve(assetsDir, relative);
    if (safe && relative !== '' && file.startsWith(assetsDir + path.sep)) {
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) {
        const immutable = relative.startsWith('assets/');
        setHeaders(response, {
          'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          'content-length': String(info.size),
        });
        response.writeHead(200);
        return void response.end(head ? undefined : await readFile(file));
      }
    }
    // A missing file (it has an extension, or lives under assets/) is a 404; any other path is an app route.
    if (relative.startsWith('assets/') || /\.[a-z0-9]+$/i.test(relative)) return text(response, 404, 'grimoire: no such file');
    const index = await readFile(path.join(assetsDir, 'index.html')).catch(() => null);
    if (index === null) return text(response, 503, `grimoire: the dashboard's files are missing from ${assetsDir}`);
    setHeaders(response, { 'content-type': TYPES['.html']!, 'cache-control': 'no-cache', 'content-length': String(index.length) });
    response.writeHead(200);
    response.end(head ? undefined : index);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    setHeaders(response, SECURITY_HEADERS);
    const hostname = hostnameOf(request.headers.host);
    if (hostname === null || !ALLOWED_HOSTS.has(hostname)) {
      return text(response, 403, 'grimoire: the dashboard answers only at 127.0.0.1, localhost or [::1]');
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    if (url.pathname === START_HEALTH_PATH && method === 'GET') {
      return json(response, 200, { service: START_SERVICE, nonce: options.nonce });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(request, response, url);
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return text(response, 405, 'grimoire: only GET and HEAD outside /api');
    }
    if (url.pathname === '/open') {
      setHeaders(response, { location: openTarget(url.searchParams.get('ref') ?? ''), 'cache-control': 'no-store' });
      response.writeHead(302);
      return void response.end();
    }
    return serveStatic(request, response, url.pathname);
  };

  return http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const body = errorBodyOf(error, options.log);
      if (response.headersSent) return void response.destroy();
      failure(response, body);
    });
  });
}

/**
 * Listens on 127.0.0.1 at `port`, or on one of the next 9 ports when it is in
 * use or not permitted (spec §20). Returns the port it got.
 */
export async function listenOnLoopback(server: http.Server, port: number, tries = 10): Promise<number> {
  let last: unknown = null;
  for (let candidate = port; candidate < port + tries && candidate < 65_536; candidate++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port: candidate, host: '127.0.0.1', exclusive: true });
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
      last = error;
    }
  }
  throw new GrimoireError(
    'BUSY',
    `the dashboard can't listen on 127.0.0.1 at ports ${port}–${Math.min(port + tries - 1, 65_535)} (${(last as NodeJS.ErrnoException | null)?.code ?? 'no port free'}); free one, or set another with grimoire settings set dashboard.port <port>`,
    {},
  );
}
