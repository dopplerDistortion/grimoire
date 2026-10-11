// The dashboard's app shell (spec §20, Shell): the sign-in exchange, the
// signed-out page, and the frame later views plug into (sidebar, content,
// footer with the live state and the signed-in identity). Served under a CSP
// with no inline script or style: every style lives in styles.css.
import { useEffect, useState } from 'preact/hooks';
import { ApiError, instance, session, signedOut, signIn, signOut, type InstanceInfo, type SessionInfo } from './api';
import { connectLive, type LiveState } from './live';

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

function Shell({ session: who, instance: running }: { session: SessionInfo; instance: InstanceInfo }) {
  const [live, setLive] = useState<LiveState>('connecting');
  const [info, setInfo] = useState(running);

  useEffect(
    () =>
      connectLive({
        onState: setLive,
        onReload: () => location.reload(),
        onChange: (change) => {
          if (change.instance) void instance().then(setInfo, () => {});
        },
      }),
    [],
  );

  return (
    <div class="shell">
      {info.notice ? <div class="banner">{info.notice}</div> : null}
      <nav class="sidebar">
        <span class="brand">grimoire</span>
        {SECTIONS.map((section) => (
          <a key={section.path} href={section.path} class={location.pathname === section.path ? 'current' : undefined}>
            {section.label}
          </a>
        ))}
      </nav>
      <main class="content">
        <h1>{SECTIONS.find((section) => section.path === location.pathname)?.label ?? 'grimoire'}</h1>
      </main>
      <footer class="footer">
        <span class={`live live-${live}`}>{live === 'live' ? 'live' : live === 'reconnecting' ? 'reconnecting…' : 'connecting…'}</span>
        <span class="identity">{who.identity?.email ?? who.identity?.name ?? 'no git identity'}</span>
        <span class="version">grimoire {info.version}</span>
        <button type="button" onClick={() => void signOut().finally(() => location.replace('/'))}>
          Sign out
        </button>
      </footer>
    </div>
  );
}
