// Dashboard sign-in (spec §20, Transport and auth): `start` and `open` hand
// the browser a single-use code in the URL fragment (`/login#code=…`), which
// the page exchanges by `POST /api/session` for a session cookie. Codes expire
// after ~60 s; sessions last until `start` stops (they live in its memory).
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a sign-in code may wait for its exchange. */
export const CODE_TTL_MS = 60_000;

export interface DashboardSession {
  /** When the browser signed in, epoch ms. */
  readonly since: number;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

/** The cookie of one clone's dashboard: its name carries the per-clone id, never the tracker root. */
export function sessionCookieName(cloneId: string): string {
  return `grimoire_${cloneId.slice(0, 16)}`;
}

export class SignIns {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, DashboardSession>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** A fresh single-use code. */
  issueCode(): string {
    const now = this.clock();
    for (const [code, expires] of this.codes) if (expires <= now) this.codes.delete(code);
    const code = token();
    this.codes.set(code, now + CODE_TTL_MS);
    return code;
  }

  /** Spends `code`: a new session's token, or null when the code is unknown, spent or expired. */
  exchange(code: unknown): string | null {
    if (typeof code !== 'string' || code.length === 0 || code.length > 128) return null;
    const expires = this.codes.get(code);
    if (expires === undefined) return null;
    this.codes.delete(code);
    if (expires <= this.clock()) return null;
    const session = token();
    this.sessions.set(session, { since: this.clock() });
    return session;
  }

  /** The session `cookie` names, or null. */
  session(cookie: string | null): DashboardSession | null {
    if (cookie === null) return null;
    const candidate = Buffer.from(cookie);
    for (const [known, session] of this.sessions) {
      const bytes = Buffer.from(known);
      if (bytes.length === candidate.length && timingSafeEqual(bytes, candidate)) return session;
    }
    return null;
  }

  /** Signs the session out. */
  revoke(cookie: string | null): void {
    if (cookie !== null && this.session(cookie)) this.sessions.delete(cookie);
  }
}
