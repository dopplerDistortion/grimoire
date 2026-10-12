// The dashboard's app shell (spec §20, Shell): the sign-in exchange, the
// signed-out page, and the frame the views plug into (sidebar, content routed
// by path, footer with the live state and the signed-in identity), plus the
// dialog host and toasts every view shares. Served under a CSP with no inline
// script or style: every style lives in styles.css.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, instance, session, signedOut, signIn, signOut, type InstanceInfo, type SessionInfo } from './api';
import { IssuesScreen } from './issues';
import { connectLive, type LiveState } from './live';
import { interceptLinks, usePath } from './router';
import { DialogHost, Me, Toasts } from './ui';

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

function Shell({ session: who, instance: running }: { session: SessionInfo; instance: InstanceInfo }) {
  const [live, setLive] = useState<LiveState>('connecting');
  const [info, setInfo] = useState(running);
  const path = usePath();
  const shell = useRef<HTMLDivElement>(null);
  const section = sectionOf(path);
  useEffect(() => (shell.current ? interceptLinks(shell.current) : undefined), []);

  useEffect(
    () =>
      connectLive({
        onState: setLive,
        // Views refetch through onLive; the shell keeps its own instance facts fresh. Never a page reload.
        onSignal: (signal) => {
          if (signal.kind === 'reload' || signal.change.instance) void instance().then(setInfo, () => {});
        },
      }),
    [],
  );

  return (
    <Me.Provider value={{ email: who.identity?.email ?? null, name: who.identity?.name ?? null }}>
    <div class="shell" ref={shell}>
      {info.notice ? <div class="banner">{info.notice}</div> : null}
      <nav class="sidebar">
        <span class="brand">grimoire</span>
        {SECTIONS.map((entry) => (
          <a key={entry.path} href={entry.path} class={section === entry.path ? 'current' : undefined}>
            {entry.label}
          </a>
        ))}
      </nav>
      <main class={section === '/issues' ? 'content issues-content' : 'content'}>
        {section === '/issues' ? <IssuesScreen path={path} /> : <h1>{SECTIONS.find((entry) => entry.path === section)?.label ?? 'grimoire'}</h1>}
      </main>
      <footer class="footer">
        <span class={`live live-${live}`}>{live === 'live' ? 'live' : live === 'reconnecting' ? 'reconnecting…' : 'connecting…'}</span>
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
