// The Issues screen (spec §20, Issues): quick views with their counts,
// filters (label, assignee, parent, title text), the list ordered by `seq`,
// a board toggle with derived columns, and New issue. `/issues/<id>` opens
// the issue in a split pane beside a narrow list, at the same deep URL. The
// list comes from `list` with the view and filters; every chip reads the
// core's derived fields. Live changes refetch in place and flash their rows;
// nothing remounts, so drafts, focus and scroll survive.
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { read, write } from './api';
import { DAY_MS, ago, short } from './format';
import { listAll, QUICK_VIEWS, quickCounts, useLiveRefetch, type QuickView } from './data';
import { IssuePane, type IssueContext } from './issue';
import { navigate } from './router';
import type { ListRow } from './types';
import { ActorName, StateChip, errorText, openDialog, toast, useMe } from './ui';

interface Filters {
  readonly view: QuickView;
  readonly label: string;
  readonly assignee: string;
  readonly parent: string;
  readonly q: string;
}

const NO_FILTERS: Filters = { view: 'open', label: '', assignee: '', parent: '', q: '' };

function rowFacts(row: ListRow) {
  return {
    status: row.status,
    conflict: row.conflict !== null,
    claimed: row.open_attempts.length > 0,
    stale: row.open_attempts.some((a) => a.stale),
    openBlockers: row.open_blocker_count,
    openChildren: row.open_child_count,
    ready: row.ready,
  };
}

/** The quick view a `?view=` query names; Open otherwise. */
function viewOf(search: string): QuickView {
  const named = new URLSearchParams(search).get('view');
  return QUICK_VIEWS.find(([view]) => view === named)?.[0] ?? NO_FILTERS.view;
}

export function IssuesScreen({ path }: { path: string }) {
  const me = useMe();
  const match = /^\/issues\/([^/]+)$/.exec(path);
  const selected = match ? decodeURIComponent(match[1]!) : null;
  // A tile on the home links to a quick view: `/issues?view=ready`.
  const [filters, setFilters] = useState<Filters>(() => ({ ...NO_FILTERS, view: viewOf(location.search) }));
  const [board, setBoard] = useState(false);
  const [rows, setRows] = useState<ListRow[] | null>(null);
  const [all, setAll] = useState<ListRow[]>([]);
  const [counts, setCounts] = useState<Partial<Record<QuickView, number>>>({});
  const [labels, setLabels] = useState<string[]>([]);
  const [flashed, setFlashed] = useState<{ ids: readonly string[]; at: number }>({ ids: [], at: 0 });
  const [error, setError] = useState<string | null>(null);

  const server = { label: filters.label, assignee: filters.assignee, parent: filters.parent };
  const refetch = useCallback(async () => {
    try {
      const [current, every, totals, used] = await Promise.all([
        listAll({ ...server, view: board ? 'all' : filters.view }),
        listAll({}),
        quickCounts(),
        read<{ labels: { name: string }[] }>('labels').then((result) => result.labels.map((label) => label.name)),
      ]);
      setRows(current);
      setAll(every);
      setCounts(totals);
      setLabels(used);
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [board, filters.view, filters.label, filters.assignee, filters.parent]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useLiveRefetch(
    (change) => {
      void refetch();
      if (change) {
        setFlashed({ ids: change.issues, at: Date.now() });
        if (change.agent && change.issues.length > 0) toast(`An agent changed ${change.issues.join(', ')}.`, change.issues.length === 1 ? `/issues/${change.issues[0]}` : undefined);
      }
    },
    (change) => change.issues.length > 0 || change.attempts.length > 0,
  );

  const people = useMemo(() => {
    const seen = new Set<string>();
    if (me.email) seen.add(me.email);
    for (const row of all) for (const attempt of row.open_attempts) seen.add(attempt.assignee);
    return [...seen].sort();
  }, [all, me.email]);
  const context: IssueContext = { rows: all, labels, people };
  const parents = useMemo(() => [...new Set(all.map((row) => row.parent).filter((p): p is string => p !== null))].sort(), [all]);

  const q = filters.q.trim().toLowerCase();
  const shown = (rows ?? []).filter((row) => q === '' || row.title.toLowerCase().includes(q));
  const isFlash = (id: string) => flashed.ids.includes(id) && Date.now() - flashed.at < 2_600;
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  const head = (
    <div class="row between">
      <h1>Issues</h1>
      <div class="row">
        {selected ? null : (
          <button type="button" class="board-toggle" onClick={() => setBoard(!board)}>
            {board ? 'List' : 'Board'}
          </button>
        )}
        <button type="button" class="pri new-issue" onClick={() => newIssue(all, labels)}>
          New issue
        </button>
      </div>
    </div>
  );

  const filterBar = (
    <>
      {board && !selected ? null : (
        <div class="row wrap quick-views">
          {QUICK_VIEWS.map(([view, label]) => (
            <button key={view} type="button" class={`qv ${filters.view === view ? 'on' : ''}`} data-view={view} onClick={() => set({ view })}>
              {label} <span class="mute">{counts[view] ?? ''}</span>
            </button>
          ))}
        </div>
      )}
      <div class="row wrap filters">
        <select class="filter-label" value={filters.label} onChange={(event) => set({ label: event.currentTarget.value })}>
          <option value="">any label</option>
          {labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
        <select class="filter-assignee" value={filters.assignee} onChange={(event) => set({ assignee: event.currentTarget.value })}>
          <option value="">anyone</option>
          <option value="me">me</option>
          <option value="none">unassigned</option>
          {people
            .filter((person) => person !== me.email)
            .map((person) => (
              <option key={person} value={person}>
                {person}
              </option>
            ))}
        </select>
        <select class="filter-parent" value={filters.parent} onChange={(event) => set({ parent: event.currentTarget.value })}>
          <option value="">any parent</option>
          {parents.map((parent) => (
            <option key={parent} value={parent}>
              {parent} {all.find((row) => row.id === parent)?.title.slice(0, 30) ?? ''}
            </option>
          ))}
        </select>
        <input class="filter-q" placeholder="Filter titles" value={filters.q} onInput={(event) => set({ q: event.currentTarget.value })} />
      </div>
    </>
  );

  const list = (
    <div class="panel">
      <table class={selected ? 'issues compact' : 'issues'}>
        <thead>
          <tr>
            <th>Id</th>
            <th>Title</th>
            <th>State</th>
            {selected ? null : (
              <>
                <th>Assignee</th>
                <th>Parent</th>
                <th>Updated</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr
              key={row.id}
              data-id={row.id}
              class={`click ${selected === row.id ? 'sel' : ''} ${isFlash(row.id) ? 'flash' : ''}`}
              onClick={(event) => {
                if ((event.target as Element).closest('a')) return;
                navigate(`/issues/${row.id}`);
              }}
            >
              <td class="id">
                <a href={`/issues/${row.id}`}>{row.id}</a>
              </td>
              <td>
                <div class="title">{row.title}</div>
                <div class="row wrap label-chips">
                  {row.labels.map((label) => (
                    <span key={label} class="chip lbl">
                      {label}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <StateChip facts={rowFacts(row)} />
              </td>
              {selected ? null : (
                <>
                  <td class="small">
                    {row.open_attempts.length === 0 ? (
                      <span class="mute">—</span>
                    ) : (
                      row.open_attempts.map((a) => (
                        <div key={a.attempt}>
                          <ActorName person={a.assignee} client={a.clients_seen.find((client) => client !== 'dashboard')} />
                          {a.stale ? <span class="chip warn"> {ago(a.last_activity_at)}</span> : null}
                        </div>
                      ))
                    )}
                  </td>
                  <td class="small">{row.parent ? <span class="id">{row.parent}</span> : <span class="mute">—</span>}</td>
                  <td class="small mute">{ago(row.updated_at)}</td>
                </>
              )}
            </tr>
          ))}
          {rows !== null && shown.length === 0 ? (
            <tr>
              <td colSpan={6} class="mute empty">
                No issues match.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );

  return (
    <div class={selected ? 'split' : 'single'}>
      <div class="pane list-pane">
        {head}
        {filterBar}
        {error ? <div class="err">{error}</div> : null}
        {rows === null ? <p class="mute">Loading…</p> : board && !selected ? <Board rows={shown} isFlash={isFlash} /> : list}
      </div>
      {selected ? (
        <div class="pane detail-pane">
          <IssuePane key={selected} id={selected} context={context} />
        </div>
      ) : null}
    </div>
  );
}

/** The board: Ready, Waiting (blocked, open sub-issues or conflicted), Claimed, Closed in the last 7 days. */
function Board({ rows, isFlash }: { rows: readonly ListRow[]; isFlash: (id: string) => boolean }) {
  const open = rows.filter((row) => row.status === 'open');
  const now = Date.now();
  const columns: [string, string, ListRow[]][] = [
    ['ready', 'Ready', open.filter((row) => row.ready)],
    ['waiting', 'Waiting', open.filter((row) => row.open_attempts.length === 0 && !row.ready)],
    ['claimed', 'Claimed', open.filter((row) => row.open_attempts.length > 0)],
    ['closed', 'Closed (7 days)', rows.filter((row) => row.status !== 'open' && now - Date.parse(row.updated_at) < 7 * DAY_MS)],
  ];
  return (
    <div class="board">
      {columns.map(([key, title, cards]) => (
        <div key={key} class="col" data-column={key}>
          <h3>
            {title} · {cards.length}
          </h3>
          {cards.map((row) => (
            <a key={row.id} href={`/issues/${row.id}`} class={`card ${isFlash(row.id) ? 'flash' : ''}`} data-id={row.id}>
              <div class="row between">
                <span class="id">{row.id}</span>
                <span class="chips">
                  {row.conflict ? <span class="chip bad">conflict</span> : null}
                  {row.open_attempts.some((a) => a.stale) ? <span class="chip warn">stale</span> : null}
                </span>
              </div>
              <div class="card-title">{row.title}</div>
              <div class="row wrap label-chips">
                {row.labels.map((label) => (
                  <span key={label} class="chip lbl">
                    {label}
                  </span>
                ))}
              </div>
              {key === 'closed' || (key === 'waiting' && (row.open_blocker_count > 0 || row.open_child_count > 0)) ? <StateChip facts={{ ...rowFacts(row), conflict: false }} /> : null}
              {row.open_attempts.map((a) => (
                <div key={a.attempt} class="small">
                  {short(a.assignee)}
                </div>
              ))}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

function newIssue(rows: readonly ListRow[], labels: readonly string[]) {
  openDialog({
    title: 'New issue',
    ok: 'Create',
    body: (
      <>
        <label class="field">
          Title
          <input name="title" />
        </label>
        <label class="field">
          Body
          <textarea name="body" rows={6} />
        </label>
        <label class="field">
          Labels (comma-separated)
          <input name="labels" list="new-issue-labels" />
          <datalist id="new-issue-labels">
            {labels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </label>
        <label class="field">
          Parent
          <select name="parent">
            <option value="">none</option>
            {rows
              .filter((row) => row.status === 'open')
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} {row.title.slice(0, 50)}
                </option>
              ))}
          </select>
        </label>
        <label class="field">
          Blocked by (one or more)
          <select name="blocked_by" multiple size={Math.min(6, Math.max(2, rows.length))}>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.id} {row.title.slice(0, 50)}
              </option>
            ))}
          </select>
        </label>
      </>
    ),
    validate: (values) => ((values.title ?? '').trim() === '' ? 'A title is required.' : null),
    run: async (values) => {
      const form = document.querySelector<HTMLSelectElement>('.modal select[name="blocked_by"]');
      const blockers = form ? [...form.selectedOptions].map((option) => option.value) : [];
      const labelList = (values.labels ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label !== '');
      const created = await write<{ id: string }>('create', {
        title: values.title!.trim(),
        ...(values.body ? { body: values.body } : {}),
        ...(labelList.length > 0 ? { labels: labelList } : {}),
        ...(values.parent ? { parent: values.parent } : {}),
        ...(blockers.length > 0 ? { blocked_by: blockers } : {}),
      });
      toast(`Created ${created.id}.`);
      navigate(`/issues/${created.id}`);
    },
  });
}
