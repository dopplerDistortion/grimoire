// Small display helpers: ages, people, hosts.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3m ago", "2h ago", "4d ago"; "just now" under a minute. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const d = Math.max(0, now - at);
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.round(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return `${Math.round(d / DAY)}d ago`;
}

/** A duration: "40m", "5h", "2.5d". */
export function duration(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

/** The person part of an email: "ana" for ana@acme.dev. */
export function short(email: string | null | undefined): string {
  if (!email) return '—';
  return email.split('@')[0] || email;
}

/** The host of an http(s) URL, or null. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

export const DAY_MS = DAY;
