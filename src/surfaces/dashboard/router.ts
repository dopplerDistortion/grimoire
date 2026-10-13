// Path routing (spec §20, Shell): `/issues/<id>` and the other deep routes
// are real paths, served `index.html` by `start`. Navigation is pushState, so
// a route change never reloads the page (drafts survive it too).
import { useEffect, useState } from 'preact/hooks';

const listeners = new Set<() => void>();

/** Goes to `path` (same origin) without reloading the page. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const listener of listeners) listener();
}

window.addEventListener('popstate', () => {
  for (const listener of listeners) listener();
});

/** The current path, re-rendering on every navigation. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  return path;
}

/**
 * Turns clicks on same-origin `<a href="/…">` links into navigations (the
 * shell installs it once). Modified clicks, other targets and downloads keep
 * the browser's own behaviour.
 */
export function interceptLinks(root: HTMLElement): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;
    event.preventDefault();
    navigate(href);
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}
