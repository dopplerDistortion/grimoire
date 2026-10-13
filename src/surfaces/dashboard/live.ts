// The dashboard's live events (spec §20, SSE): one `EventSource` per tab on
// `/api/events`. The browser resumes with `Last-Event-ID` on its own after a
// drop; the server then sends what changed meanwhile (or `reload`). When the
// browser gives up instead (a 401 once a restarted `start` has forgotten the
// session), the session is checked: signed out shows the signed-out page,
// anything else opens the stream again from the last id.
//
// Views listen with `onLive`: a `change` names what to refetch, a `reload`
// means refetch everything. Neither reloads the page, so drafts, focus and
// scroll survive every update.
import { ApiError, session } from './api';

/** What a `change` event carries: the client refetches only what changed. */
export interface ChangeSet {
  readonly tips: { readonly local: string | null; readonly remote: string | null };
  readonly issues: readonly string[];
  readonly attempts: readonly string[];
  readonly knowledge: boolean;
  readonly settings: boolean;
  readonly sync: boolean;
  readonly machine: boolean;
  readonly instance: boolean;
  readonly agent: boolean;
}

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/** What views hear: refetch what a change names, or everything on reload. */
export type LiveSignal = { readonly kind: 'change'; readonly change: ChangeSet } | { readonly kind: 'reload' };

export interface LiveHandlers {
  readonly onSignal?: (signal: LiveSignal) => void;
  readonly onState?: (state: LiveState) => void;
}

/** How long after the browser gave up the stream is opened again. */
const REOPEN_MS = 2_000;

const listeners = new Set<(signal: LiveSignal) => void>();

/** Calls `listener` with every live signal while the shell's stream is open; returns a function that stops. */
export function onLive(listener: (signal: LiveSignal) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Opens the stream; returns a function that closes it. */
export function connectLive(handlers: LiveHandlers): () => void {
  let source: EventSource | null = null;
  let lastId: string | null = null;
  let closed = false;
  let reopen: ReturnType<typeof setTimeout> | null = null;
  const signal = (value: LiveSignal) => {
    handlers.onSignal?.(value);
    for (const listener of listeners) listener(value);
  };
  const parse = (event: Event): unknown => {
    const message = event as MessageEvent<string>;
    if (message.lastEventId) lastId = message.lastEventId;
    try {
      return JSON.parse(message.data);
    } catch {
      return null;
    }
  };

  const open = () => {
    const current = new EventSource(lastId === null ? '/api/events' : `/api/events?last_event_id=${encodeURIComponent(lastId)}`);
    source = current;
    current.addEventListener('open', () => handlers.onState?.('live'));
    current.addEventListener('ready', (event) => {
      parse(event);
      handlers.onState?.('live');
    });
    current.addEventListener('change', (event) => {
      const change = parse(event) as ChangeSet | null;
      if (change) signal({ kind: 'change', change });
    });
    current.addEventListener('reload', (event) => {
      parse(event);
      signal({ kind: 'reload' });
    });
    current.addEventListener('error', () => {
      handlers.onState?.('reconnecting');
      // CONNECTING: the browser retries on its own. CLOSED: it gave up (a non-200 answer).
      if (closed || current.readyState !== EventSource.CLOSED) return;
      void session().then(
        () => true,
        // NO_SESSION has already told the app (api.ts): it shows the signed-out page.
        (error: unknown) => !(error instanceof ApiError && error.code === 'NO_SESSION'),
      ).then((retry) => {
        if (retry && !closed) reopen = setTimeout(open, REOPEN_MS);
      });
    });
  };

  open();
  handlers.onState?.('connecting');
  return () => {
    closed = true;
    if (reopen !== null) clearTimeout(reopen);
    source?.close();
  };
}
