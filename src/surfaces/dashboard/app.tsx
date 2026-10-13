// The dashboard's app shell (spec §20, Shell): the sign-in exchange, the
// signed-out page, and the frame the views plug into (sidebar, content routed
// by path, footer with the live state, the sync chip and the signed-in
// identity), plus the dialog host and toasts every view shares. When this
// clone's store can't be used here (NOT_SYNCED, UPGRADE_REQUIRED), a full
// page with the remedies takes the frame's place, never an empty board; the
// pin-mismatch banner sits above everything. Served under a CSP with no inline
// script or style: every style lives in styles.css.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, BlockedEvent, blocks, instance, read, session, signedOut, signIn, signOut, storeBlocked, type ApiErrorBody, type InstanceInfo, type SessionInfo } from './api';
import { IssuesScreen } from './issues';
import { connectLive, type LiveState } from './live';
import { interceptLinks, usePath } from './router';
import { SettingsScreen } from './settings';
import { SyncChip, syncNow } from './sync';
import { DialogHost, errorText, Me, toast, Toasts } from './ui';

/** Where a signed-in browser goes after `/login`: a same-origin path only. */
function nextPath(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return raw;
  return '/';
}

type Phase = { kind: 'loading' } | { kind: 'signed-out'; reason?: string } | { kind: 'signed-in'; session: SessionInfo; instance: InstanceInfo };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    const out = () => setPhase({ kind: 'signed-out' });
    signedOut.addEventListener('signed-out', out);
    void (async () => {
      if (location.pathname === '/login') {
        const fragment = new URLSearchParams(location.hash.slice(1));
        const code = fragment.get('code');
        // The code is single-use: drop it from the address bar and history at once.
        history.replaceState(null, '', '/login');
        if (!code) return setPhase({ kind: 'signed-out', reason: 'This sign-in link has no code.' });
        try {
          await signIn(code);
        } catch (error) {
          return setPhase({ kind: 'signed-out', reason: error instanceof ApiError ? error.message : 'Signing in failed.' });
        }
        location.replace(nextPath(fragment.get('next')));
        return;
      }
      try {
        const [who, running] = await Promise.all([session(), instance()]);
        setPhase({ kind: 'signed-in', session: who, instance: running });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NO_SESSION') return setPhase({ kind: 'signed-out' });
        setPhase({ kind: 'signed-out', reason: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => signedOut.removeEventListener('signed-out', out);
  }, []);

  if (phase.kind === 'loading') return <p class="loading">Loading…</p>;
  if (phase.kind === 'signed-out') return <SignedOut reason={phase.reason} />;
  return <Shell session={phase.session} instance={phase.instance} />;
}

function SignedOut({ reason }: { reason?: string | undefined }) {
  return (
    <main class="signed-out">
      <h1>grimoire</h1>
      <p>Open the dashboard from your terminal:</p>
      <pre class="command">grimoire open &lt;ref&gt;</pre>
      <p class="hint">Run it in this repository (or `grimoire start` if nothing serves it yet); it opens a signed-in tab.</p>
      {reason ? <p class="reason">{reason}</p> : null}
    </main>
  );
}

const SECTIONS = [
  { path: '/', label: 'Attention' },
  { path: '/issues', label: 'Issues' },
  { path: '/knowledge', label: 'Knowledge' },
  { path: '/settings', label: 'Settings' },
];

function sectionOf(path: string): string {
  const top = `/${path.split('/')[1] ?? ''}`;
  return SECTIONS.some((section) => section.path === top) ? top : '/';
}

/** How often a full page checks whether the store became usable (besides every live update). */
const RECHECK_MS = 5_000;

/** A read that tells whether this clone's store can be used here: null when it can, else the refusal. */
async function probeStore(): Promise<ApiErrorBody | null> {
  try {
    await read('settings_get');
    return null;
  } catch (error) {
    return error instanceof ApiError && blocks(error.body, 'GET') ? error.body : null;
  }
}

function Shell({ session: who, instance: running }: { session: SessionInfo; instance: InstanceInfo }) {
  const [live, setLive] = useState<LiveState>('connecting');
  const [info, setInfo] = useState(running);
  const [blocked, setBlocked] = useState<ApiErrorBody | null>(null);
  const path = usePath();
  const shell = useRef<HTMLDivElement>(null);
  const section = sectionOf(path);
  useEffect(() => (shell.current ? interceptLinks(shell.current) : undefined), [blocked === null]);

  const recheck = () => void probeStore().then(setBlocked);
  useEffect(() => {
    const onBlocked = (event: Event) => setBlocked((event as BlockedEvent).body);
    storeBlocked.addEventListener('blocked', onBlocked);
    recheck();
    return () => storeBlocked.removeEventListener('blocked', onBlocked);
  }, []);
  // While a full page shows, the store is checked again on a timer as well as on every live update.
  useEffect(() => {
    if (blocked === null) return;
    const timer = setInterval(recheck, RECHECK_MS);
    return () => clearInterval(timer);
  }, [blocked === null]);

  useEffect(
    () =>
      connectLive({
        onState: setLive,
        // Views refetch through onLive; the shell keeps its own instance facts fresh. Never a page reload.
        onSignal: (signal) => {
          if (signal.kind === 'reload' || signal.change.instance) void instance().then(setInfo, () => {});
          recheck();
        },
      }),
    [],
  );

  const banner = info.notice ? <div class="banner pin-banner">{info.notice}</div> : null;
  if (blocked) {
    return (
      <Me.Provider value={{ email: who.identity?.email ?? null, name: who.identity?.name ?? null }}>
        {banner}
        <FullPage refusal={blocked} onRetry={recheck} />
        <DialogHost />
        <Toasts />
      </Me.Provider>
    );
  }

  return (
    <Me.Provider value={{ email: who.identity?.email ?? null, name: who.identity?.name ?? null }}>
    <div class="shell" ref={shell}>
      {banner}
      <nav class="sidebar">
        <span class="brand">grimoire</span>
        {SECTIONS.map((entry) => (
          <a key={entry.path} href={entry.path} class={section === entry.path ? 'current' : undefined}>
            {entry.label}
          </a>
        ))}
      </nav>
      <main class={section === '/issues' ? 'content issues-content' : 'content'}>
        {section === '/issues' ? (
          <IssuesScreen path={path} />
        ) : section === '/settings' ? (
          <SettingsScreen session={who} />
        ) : (
          <h1>{SECTIONS.find((entry) => entry.path === section)?.label ?? 'grimoire'}</h1>
        )}
      </main>
      <footer class="footer">
        <span class={`live live-${live}`}>{live === 'live' ? 'live' : live === 'reconnecting' ? 'reconnecting…' : 'connecting…'}</span>
        <SyncChip />
        <span class="identity">{who.identity?.email ?? who.identity?.name ?? 'no git identity'}</span>
        <span class="version">grimoire {info.version}</span>
        <button type="button" onClick={() => void signOut().finally(() => location.replace('/'))}>
          Sign out
        </button>
      </footer>
      <DialogHost />
      <Toasts />
    </div>
    </Me.Provider>
  );
}

interface Remedy {
  readonly kind?: string;
  readonly text: string;
  readonly command?: string;
}

/**
 * The full-page states (spec §20): NOT_SYNCED with its remedy (and Sync now,
 * which fetches the tracker), UPGRADE_REQUIRED with its remedies in order.
 */
function FullPage({ refusal, onRetry }: { refusal: ApiErrorBody; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const retry = (
    <button type="button" class="retry" onClick={onRetry}>
      Retry
    </button>
  );
  if (refusal.code === 'NOT_SYNCED') {
    const remedy = typeof refusal.details.remedy === 'string' ? refusal.details.remedy : null;
    return (
      <main class="gate gate-not-synced">
        <div class="small mute">grimoire · NOT_SYNCED</div>
        <h1>No tracker here yet</h1>
        <p class="gate-message">{refusal.message}</p>
        {remedy ? (
          <>
            <h3>Remedy</h3>
            <p class="remedy">{remedy}</p>
          </>
        ) : null}
        <p class="mute small">Nothing is lost: the board shows once this clone has the tracker.</p>
        <div class="row">
          <button
            type="button"
            class="pri sync-now"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void syncNow()
                .then(toast, (failure: unknown) => toast(errorText(failure)))
                .finally(() => {
                  setBusy(false);
                  onRetry();
                });
            }}
          >
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
          {retry}
        </div>
      </main>
    );
  }
  const remedies = (Array.isArray(refusal.details.remedies) ? refusal.details.remedies : []).filter(
    (remedy): remedy is Remedy => typeof remedy === 'object' && remedy !== null && typeof (remedy as Remedy).text === 'string',
  );
  return (
    <main class="gate gate-upgrade">
      <div class="small mute">grimoire · UPGRADE_REQUIRED</div>
      <h1>This needs another grimoire</h1>
      <p class="gate-message">{refusal.message}</p>
      <p class="mute small">Nothing was changed.</p>
      {remedies.length > 0 ? (
        <>
          <h3>Remedies, in order</h3>
          <ol class="remedies">
            {remedies.map((remedy, k) => (
              <li key={k} class="remedy">
                <div>{remedy.text}</div>
                {remedy.command ? <pre class="command">{remedy.command}</pre> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <div class="row">{retry}</div>
    </main>
  );
}
