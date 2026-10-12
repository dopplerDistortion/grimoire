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

async function answer<T>(response: Response): Promise<T> {
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
  return answer<T>(await fetch(url, init));
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
