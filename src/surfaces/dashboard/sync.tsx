// How syncing goes, as the footer's chip and the Settings sync panel show it
// (spec §20 Shell, Settings): `sync_status`, read again whenever a live
// update says the tips or the sync status moved, and Sync now (`sync`:
// fetch → fold → push), which tells every view showing the status at once.
import { useCallback, useEffect, useState } from 'preact/hooks';
import { read, write } from './api';
import { useLiveRefetch } from './data';
import { ago } from './format';
import type { SyncPosition, SyncResult, SyncStatus } from './types';

const listeners = new Set<() => void>();

/** Tells every `useSyncStatus` to read again (after Sync now). */
function syncChanged(): void {
  for (const listener of listeners) listener();
}

/** The sync status, kept fresh by live updates; null until first read (or when it can't be read). */
export function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const refetch = useCallback(() => {
    void read<SyncStatus>('sync_status').then(setStatus, () => {});
  }, []);
  useEffect(() => {
    refetch();
    listeners.add(refetch);
    return () => void listeners.delete(refetch);
  }, [refetch]);
  useLiveRefetch(refetch, (change) => change.sync || change.machine);
  return status;
}

/** Runs Sync now; resolves with what it did, in words. */
export async function syncNow(): Promise<string> {
  try {
    const result = await write<SyncResult>('sync');
    if (result.state === 'pushed') return 'Synced: fetched, folded and pushed grimoire/tracker.';
    if (result.state === 'in-sync') return `Synced: grimoire/tracker is in sync${result.fold ? ' (folded what the remote had)' : ''}.`;
    if (result.reason === 'no-remote') return 'Nothing pushed: this clone has no remote to push to.';
    if (result.reason === 'no-default-branch') return 'Nothing pushed: the remote has no default branch yet.';
    return `Sync failed${result.failure ? ` (${result.failure.class}): ${result.failure.message}` : ''}`;
  } finally {
    syncChanged();
  }
}

/** The local tracker against the remote's, in a few words: "↑2 ↓1 diverged", "in sync". */
export function positionText(position: SyncPosition | null): string {
  if (!position) return 'unknown';
  const counts = `${position.ahead ? `↑${position.ahead} ` : ''}${position.behind ? `↓${position.behind} ` : ''}`.trim();
  switch (position.state) {
    case 'none':
      return 'no tracker';
    case 'unpublished':
      return 'not on the remote yet';
    case 'in-sync':
      return 'in sync';
    case 'diverged':
      return `diverged ${counts}`;
    default:
      return counts;
  }
}

/** The footer's chip: push rejected, diverged, ahead or behind, or in sync with the last sync's time. */
export function SyncChip() {
  const status = useSyncStatus();
  if (!status) return null;
  const synced = status.last_success_at ? ` · synced ${ago(status.last_success_at)}` : '';
  const ahead = status.position?.ahead ? ` · ↑${status.position.ahead}` : '';
  let tone = '';
  let text: string;
  if (status.failure?.class === 'rejected') {
    tone = 'bad';
    text = `⚠ push rejected${ahead}`;
  } else if (status.failure?.class === 'auth') {
    tone = 'bad';
    text = `⚠ sync: authentication failed${ahead}`;
  } else if (status.position?.state === 'diverged') {
    tone = 'warn';
    text = `${positionText(status.position)}${synced}`;
  } else if (status.position?.state === 'in-sync') {
    tone = 'ok';
    text = `in sync${synced}`;
  } else {
    text = `${positionText(status.position)}${status.failure ? ' · sync failed' : synced}`;
  }
  return (
    <a class={`chip sync-chip ${tone}`} href="/settings" title={status.summary}>
      {text}
    </a>
  );
}
