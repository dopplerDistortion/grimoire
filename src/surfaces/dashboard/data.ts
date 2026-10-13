// Reads for the Issues screens, through `/api/op/<name>` with the core's
// shapes: every page of a `list`, the quick views' counts, and a whole issue
// (`show` continued by its cursor until the body and every comment are in).
import { useEffect, useRef } from 'preact/hooks';
import { ApiError, read } from './api';
import { onLive, type ChangeSet } from './live';
import type { ActivityEntry, ActivityResult, IssueDetail, ListResult, ListRow, ShowResult } from './types';

export const QUICK_VIEWS = [
  ['open', 'Open'],
  ['ready', 'Ready'],
  ['claimed', 'Claimed'],
  ['stale', 'Stale'],
  ['blocked', 'Blocked'],
  ['conflicts', 'Conflicts'],
  ['closed', 'Closed'],
  ['all', 'All'],
] as const;

export type QuickView = (typeof QUICK_VIEWS)[number][0];

export interface ListFilters {
  readonly view?: QuickView;
  readonly label?: string;
  /** `me`, `none` or an email. */
  readonly assignee?: string;
  readonly parent?: string;
}

/** Every row `list` gives for these filters, following its cursor. */
export async function listAll(filters: ListFilters): Promise<ListRow[]> {
  const input: Record<string, unknown> = { limit: 200 };
  if (filters.view) input.view = filters.view;
  if (filters.label) input.label = [filters.label];
  if (filters.assignee) input.assignee = filters.assignee;
  if (filters.parent) input.parent = filters.parent;
  const rows: ListRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const result: ListResult = await read<ListResult>('list', cursor === null ? input : { ...input, cursor });
    rows.push(...result.rows);
    cursor = result.cursor;
    if (cursor === null) break;
  }
  return rows;
}

/** How many issues each quick view holds: the `total` of a one-row `list` per view. */
export async function quickCounts(): Promise<Record<QuickView, number>> {
  const totals = await Promise.all(QUICK_VIEWS.map(([view]) => read<ListResult>('list', { view, limit: 1 }).then((result) => result.total)));
  return Object.fromEntries(QUICK_VIEWS.map(([view], i) => [view, totals[i]!])) as Record<QuickView, number>;
}

/** The whole issue: `show` with every comment, continued by its cursor (the body first, then older comments). */
export async function showWhole(id: string): Promise<IssueDetail> {
  for (let attempt = 0; ; attempt++) {
    try {
      const first = await read<ShowResult>('show', { ref: id, comments: 'all' });
      let body = first.body ?? '';
      let comments = [...first.comments];
      let cursor = first.cursor;
      for (let page = 0; cursor !== null && page < 1_000; page++) {
        const next: ShowResult = await read<ShowResult>('show', { ref: id, comments: 'all', cursor });
        // A page that continues the body carries `body` (and, once the body is done, the newest comments);
        // a page of older comments has none.
        if (next.body !== undefined) {
          body += next.body;
          comments = [...next.comments];
        } else {
          comments = [...next.comments, ...comments];
        }
        cursor = next.cursor;
      }
      const { cursor: _c, truncated: _t, body_from: _b, ...rest } = first;
      return { ...rest, body, comments };
    } catch (error) {
      // The issue changed between pages (a stale cursor): read it again from the start, once.
      if (attempt === 0 && error instanceof ApiError && error.code === 'INVALID') continue;
      throw error;
    }
  }
}

/** The issue's writes, newest first (up to 200). */
export async function issueActivity(id: string): Promise<ActivityEntry[]> {
  const result = await read<ActivityResult>('activity', { issue: id, limit: 200 });
  return [...result.entries];
}

/**
 * Calls `refetch` whenever a live update could have changed what a view shows:
 * a `reload`, or a `change` that `relevant` accepts. The view keeps showing
 * what it has meanwhile, so nothing remounts: drafts, focus and scroll stay.
 */
export function useLiveRefetch(refetch: (change: ChangeSet | null) => void, relevant: (change: ChangeSet) => boolean): void {
  const latest = useRef({ refetch, relevant });
  latest.current = { refetch, relevant };
  useEffect(
    () =>
      onLive((signal) => {
        if (signal.kind === 'reload') latest.current.refetch(null);
        else if (latest.current.relevant(signal.change)) latest.current.refetch(signal.change);
      }),
    [],
  );
}
