// The dashboard's live events (spec §20, SSE): one `EventSource` per tab on
// `/api/events`. The browser resumes with `Last-Event-ID` on its own after a
// drop; the server then sends what changed meanwhile (or `reload`).

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

export interface LiveHandlers {
  readonly onChange?: (change: ChangeSet) => void;
  readonly onReload?: () => void;
  readonly onState?: (state: LiveState) => void;
}

/** Opens the stream; returns a function that closes it. */
export function connectLive(handlers: LiveHandlers): () => void {
  const source = new EventSource('/api/events');
  handlers.onState?.('connecting');
  const parse = (event: Event): unknown => {
    try {
      return JSON.parse((event as MessageEvent<string>).data);
    } catch {
      return null;
    }
  };
  source.addEventListener('open', () => handlers.onState?.('live'));
  source.addEventListener('ready', () => handlers.onState?.('live'));
  source.addEventListener('error', () => handlers.onState?.('reconnecting'));
  source.addEventListener('change', (event) => {
    const change = parse(event) as ChangeSet | null;
    if (change) handlers.onChange?.(change);
  });
  source.addEventListener('reload', () => handlers.onReload?.());
  return () => source.close();
}
