// The dashboard's client for `start`'s API (spec §20): reads are
// `GET /api/op/<name>?input=<JSON>`, writes `POST /api/op/<name>`, with the
// shapes and errors of the core's operations. Every non-GET request carries
// `X-Grimoire: 1` (the server refuses one without it), and the session rides
// in the HttpOnly cookie the sign-in set.

/** The error envelope every failure answers with (spec §9). */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly body: ApiErrorBody,
    readonly status: number,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.body.code;
  }
}

/** Fires when any call finds the browser signed out (401 NO_SESSION). */
export const signedOut = new EventTarget();

/** What `storeBlocked` fires with: the refusal that makes the dashboard a full page. */
export class BlockedEvent extends Event {
  constructor(readonly body: ApiErrorBody) {
    super('blocked');
  }
}

/**
 * Fires when a call finds this clone's store unusable here (spec §20,
 * Full-page states): a read answering NOT_SYNCED (no tracker, or not the one
 * `config.yml` names), or any call answering UPGRADE_REQUIRED. A write's
 * NOT_SYNCED (shallow history) stays the write's own error.
 */
export const storeBlocked = new EventTarget();

/** Whether `body` makes the dashboard a full page, for a call made with `method`. */
export function blocks(body: ApiErrorBody, method: string): boolean {
  return body.code === 'UPGRADE_REQUIRED' || (body.code === 'NOT_SYNCED' && method === 'GET');
}

async function answer<T>(response: Response, method: string): Promise<T> {
  const text = await response.text();
  let value: unknown = null;
  try {
    value = text === '' ? null : JSON.parse(text);
  } catch {
    throw new ApiError({ code: 'INTERNAL', message: `the dashboard server answered ${response.status} without JSON`, retryable: false, details: {} }, response.status);
  }
  const error = (value as { error?: ApiErrorBody } | null)?.error;
  if (!response.ok || error) {
    const body = error ?? { code: 'INTERNAL', message: `the dashboard server answered ${response.status}`, retryable: false, details: {} };
    if (body.code === 'NO_SESSION') signedOut.dispatchEvent(new Event('signed-out'));
    if (blocks(body, method)) storeBlocked.dispatchEvent(new BlockedEvent(body));
    throw new ApiError(body, response.status);
  }
  return value as T;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { accept: 'application/json', 'content-type': 'application/json', 'x-grimoire': '1' };
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  return answer<T>(await fetch(url, init), method);
}

/** A read op. */
export function read<T = unknown>(op: string, input: Record<string, unknown> = {}): Promise<T> {
  return send<T>('GET', `/api/op/${encodeURIComponent(op)}?input=${encodeURIComponent(JSON.stringify(input))}`);
}

/** A write op. */
export function write<T = unknown>(op: string, input: Record<string, unknown> = {}): Promise<T> {
  return send<T>('POST', `/api/op/${encodeURIComponent(op)}`, input);
}

export interface SessionInfo {
  readonly signed_in: boolean;
  readonly since?: string;
  readonly identity?: { readonly name: string | null; readonly email: string | null };
}

export interface InstanceInfo {
  readonly version: string;
  readonly pin: string | null;
  readonly pin_differs: boolean;
  readonly notice: string | null;
  readonly port: number;
  readonly started_at: string;
}

/** Exchanges a sign-in code for the session cookie. */
export function signIn(code: string): Promise<SessionInfo> {
  return send<SessionInfo>('POST', '/api/session', { code });
}

export function signOut(): Promise<SessionInfo> {
  return send<SessionInfo>('DELETE', '/api/session');
}

export function session(): Promise<SessionInfo> {
  return send<SessionInfo>('GET', '/api/session');
}

export function instance(): Promise<InstanceInfo> {
  return send<InstanceInfo>('GET', '/api/instance');
}

/** This machine's runner: status only (it is enabled from a terminal). */
export function runner<T>(): Promise<T> {
  return send<T>('GET', '/api/runner');
}
