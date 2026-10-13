// Attention, the dashboard's home (spec §20 Attention): only what a human
// must unblock, each item with its action inline (from the core's
// `attention`), then count tiles linking to the Issues quick views, then the
// live activity feed (the core's `activity`): person, "via client · session",
// verb, issue link, age. Every live update refetches both in place; new feed
// entries flash. The empty state reads "Nothing needs you. Agents are working
// through the frontier."
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, read, write } from './api';
import { showWhole, useLiveRefetch } from './data';
import { ago, short } from './format';
import { releaseAbandoned, resolveConflict } from './issue';
import type { ActivityEntry, ActivityResult, AttentionItem, AttentionResult, ShownStrayEdit } from './types';
import { ActorName, errorText, openDialog, toast } from './ui';

const EMPTY = 'Nothing needs you. Agents are working through the frontier.';

const TILES = [
  ['ready', 'Ready'],
  ['claimed', 'Claimed'],
  ['stale', 'Stale'],
  ['blocked', 'Blocked'],
  ['conflicts', 'Conflicts'],
] as const;

/** How many feed entries the home shows. */
const FEED_SIZE = 30;

export function AttentionScreen() {
  const [result, setResult] = useState<AttentionResult | null>(null);
  const [feed, setFeed] = useState<readonly ActivityEntry[]>([]);
  const [fresh, setFresh] = useState<{ commits: ReadonlySet<string>; at: number }>({ commits: new Set(), at: 0 });
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [attention, activity] = await Promise.all([read<AttentionResult>('attention'), read<ActivityResult>('activity', { limit: FEED_SIZE })]);
      setResult(attention);
      setFeed(activity.entries);
      // Entries this tab hadn't seen flash (none on the first load).
      if (known.current !== null) {
        const added = activity.entries.map((entry) => entry.commit).filter((commit) => !known.current!.has(commit));
        if (added.length > 0) setFresh({ commits: new Set(added), at: Date.now() });
      }
      known.current = new Set(activity.entries.map((entry) => entry.commit));
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useLiveRefetch(() => void refetch(), () => true);

  if (!result) return <p class="mute">{error ?? 'Loading…'}</p>;
  const reload = refetch;
  return (
    <div class="attention-screen">
      <div class="row between">
        <h1>Attention</h1>
        <span class="mute small attention-count">
          {result.items.length} item{result.items.length === 1 ? '' : 's'}
        </span>
      </div>
      {error ? <div class="banner bad">{error}</div> : null}
      <div class="panel attention-items">
        {result.items.length === 0 ? <div class="pad mute attention-empty">{EMPTY}</div> : null}
        {result.items.map((item) => (
          <Item key={itemKey(item)} item={item} reload={reload} />
        ))}
      </div>
      <div class="tiles">
        {TILES.map(([view, label]) => (
          <a key={view} class={`tile tile-${view}`} href={`/issues?view=${view}`}>
            <div class="v">{result.counts[view]}</div>
            <div class="l">{label}</div>
          </a>
        ))}
      </div>
      <h3>Live activity</h3>
      <div class="panel pad feed small">
        {feed.length === 0 ? <div class="mute">No activity yet.</div> : null}
        {feed.map((entry) => (
          <FeedEntry key={entry.commit} entry={entry} flash={fresh.commits.has(entry.commit) && Date.now() - fresh.at < 2_600} />
        ))}
      </div>
    </div>
  );
}

function itemKey(item: AttentionItem): string {
  switch (item.kind) {
    case 'sync_failure':
      return 'sync';
    case 'id_collision':
      return `collision:${item.id}`;
    case 'field_conflict':
    case 'open_attempts':
      return `${item.kind}:${item.issue}`;
    case 'stale_claim':
      return `stale:${item.attempt.attempt}`;
    case 'stray_edit':
      return `stray:${item.stray.id}`;
  }
}

function IssueLink({ id, title }: { id: string; title: string }) {
  return (
    <a href={`/issues/${id}`}>
      <span class="id">{id}</span> {title}
    </a>
  );
}

/** One attention row: its icon, what it is, why, and its actions. */
function Row({ tone, icon, title, detail, actions, kind }: { tone: string; icon: string; title: ComponentChildren; detail: ComponentChildren; actions: ComponentChildren; kind: string }) {
  return (
    <div class={`att att-${kind}`}>
      <div class={`ic chip ${tone}`}>{icon}</div>
      <div class="grow">
        <div class="b att-title">{title}</div>
        <div class="mute small att-detail">{detail}</div>
      </div>
      <div class="row wrap att-actions">{actions}</div>
    </div>
  );
}

function Item({ item, reload }: { item: AttentionItem; reload: () => Promise<void> }) {
  switch (item.kind) {
    case 'sync_failure':
      return (
        <Row
          kind="sync"
          tone="bad"
          icon="⇡"
          title={item.class === 'rejected' ? `${item.remote ?? 'The remote'} rejected the push of grimoire/tracker` : `Syncing with ${item.remote ?? 'the remote'} failed: authentication`}
          detail={
            <>
              <pre class="src remote-message">{item.message}</pre>
              <div class="sync-fix">{item.fix}</div>
              <div>
                Hit by a {item.client} {item.surface} process · {ago(item.at)}
                {item.pending_since ? ` · unpushed since ${ago(item.pending_since)}` : ''}
              </div>
            </>
          }
          actions={
            <>
              <a class="small" href="/settings">
                Sync settings
              </a>
              <button type="button" class="sync-now" onClick={() => void syncNow(reload)}>
                Sync now
              </button>
            </>
          }
        />
      );
    case 'id_collision':
      return (
        <Row
          kind="collision"
          tone="bad"
          icon="⑂"
          title={`Id collision: ${item.id} names ${item.sides.length} issues`}
          detail={
            <>
              Two clones minted the same id. Reads and writes of {item.id} give AMBIGUOUS_REF until someone picks the record that keeps it (CLI only in v1):
              <pre class="command">{item.command}</pre>
              {item.sides.map((side) => (
                <div key={side.id}>
                  <IssueLink id={side.id} title={side.title} /> <span class="mute">({side.status})</span>
                </div>
              ))}
            </>
          }
          actions={null}
        />
      );
    case 'field_conflict':
      return (
        <Row
          kind="conflict"
          tone="bad"
          icon="⑂"
          title={
            <>
              Fold conflict on <IssueLink id={item.issue} title={item.title} />
            </>
          }
          detail={`Two clones changed ${item.fields.join(', ')}. Claims, full-body replaces and edits of those fields are blocked until it is resolved.`}
          actions={
            <>
              <button type="button" class="resolve" onClick={() => void act(async () => resolveConflict(await showWhole(item.issue), reload))}>
                Resolve… 🔒
              </button>
              <a class="small" href={`/issues/${item.issue}`}>
                Open
              </a>
            </>
          }
        />
      );
    case 'open_attempts':
      return (
        <Row
          kind="open-attempts"
          tone="bad"
          icon="⑂"
          title={
            <>
              Two open attempts on <IssueLink id={item.issue} title={item.title} />
            </>
          }
          detail={`${item.attempts.map((a) => `${short(a.assignee)} (${a.attempt}, ${a.clients_seen.join(', ') || 'no client'}, ${ago(a.since)})`).join(' and ')} claimed it on different clones. Claims fail until one ends.`}
          actions={
            <>
              {item.attempts.map((a) => (
                <button key={a.attempt} type="button" class="abandon" onClick={() => releaseAbandoned({ id: item.issue }, a, reload)}>
                  Release {short(a.assignee)}’s as abandoned… 🔒
                </button>
              ))}
              <a class="small" href={`/issues/${item.issue}`}>
                Open
              </a>
            </>
          }
        />
      );
    case 'stale_claim': {
      const a = item.attempt;
      return (
        <Row
          kind="stale"
          tone="warn"
          icon="⏸"
          title={
            <>
              Stale claim: <IssueLink id={item.issue} title={item.title} />
            </>
          }
          detail={
            <>
              {short(a.assignee)}
              {a.clients_seen.length > 0 ? ` via ${a.clients_seen.join(', ')}` : ''} · claimed {ago(a.since)} · last activity {ago(a.last_activity_at)} ·{' '}
              <a href={`/attempts/${a.attempt}`}>{a.attempt}</a>
            </>
          }
          actions={
            <>
              <button type="button" class="abandon" onClick={() => releaseAbandoned({ id: item.issue }, a, reload)}>
                Release as abandoned… 🔒
              </button>
              <a class="small" href={`/issues/${item.issue}`}>
                Open
              </a>
            </>
          }
        />
      );
    }
    case 'stray_edit':
      return <StrayEditRow stray={item.stray} reload={reload} />;
  }
}

function StrayEditRow({ stray, reload }: { stray: ShownStrayEdit; reload: () => Promise<void> }) {
  return (
    <Row
      kind="stray"
      tone="warn"
      icon="✎"
      title={`Stray edit to ${stray.skill}`}
      detail={
        <>
          <code>{stray.path}</code> in {stray.worktree} · found {ago(stray.at)}
          {stray.open_attempts.length > 0 ? ` · agent attempts open then: ${stray.open_attempts.join(', ')}` : ''}. grimoire put the served text back; the edit reaches
          agents only if you record it.
        </>
      }
      actions={
        <>
          <button type="button" class="record-stray" onClick={() => recordStray(stray, reload)}>
            Record… 🔒
          </button>
          <button type="button" class="discard-stray" onClick={() => discardStray(stray, reload)}>
            Discard… 🔒
          </button>
        </>
      }
    />
  );
}

/** Runs an inline action: a failure shows as a toast with the core's code and message. */
async function act(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    toast(errorText(error));
  }
}

async function syncNow(reload: () => Promise<void>): Promise<void> {
  try {
    const result = await write<{ state: string; failure?: { message: string } }>('sync', {});
    toast(result.state === 'pending' ? `Still not pushed${result.failure ? `: ${result.failure.message}` : '.'}` : result.state === 'pushed' ? 'Pushed grimoire/tracker.' : 'In sync.');
  } catch (error) {
    toast(errorText(error));
  }
  await reload();
}

function recordStray(stray: ShownStrayEdit, reload: () => Promise<void>, replace?: { current: string | null; diff: string }) {
  openDialog({
    title: replace ? `Record over the current ${stray.skill}?` : `Record the stray edit to ${stray.skill}`,
    humanOnly: true,
    ok: replace ? `Record, replacing ${replace.current ?? 'nothing'}` : 'Record as a new version',
    body: replace ? (
      <>
        <p>{stray.skill} changed since the edit was made. The three-way diff (current, base, the stray edit):</p>
        <pre class="src">{replace.diff}</pre>
      </>
    ) : (
      <>
        <p>
          Makes this text a new version of <b>{stray.skill}</b>, served to every agent on the next refresh. Recorded in the skill ledger as your human edit.
        </p>
        <pre class="src">{stray.text}</pre>
      </>
    ),
    run: async () => {
      try {
        await write('skill_record', { stray: stray.id, ...(replace ? { replace: replace.current } : {}) });
      } catch (error) {
        if (!replace && error instanceof ApiError && error.code === 'BASE_MOVED') {
          const details = error.body.details as { current?: string | null; diff?: string };
          // The moved base needs its own confirmation: shown after this dialog closes.
          setTimeout(() => recordStray(stray, reload, { current: details.current ?? null, diff: details.diff ?? '' }), 0);
          return;
        }
        throw error;
      }
      toast(`Recorded the stray edit to ${stray.skill}.`);
      await reload();
    },
  });
}

function discardStray(stray: ShownStrayEdit, reload: () => Promise<void>) {
  openDialog({
    title: `Discard the stray edit to ${stray.skill}?`,
    humanOnly: true,
    danger: true,
    ok: 'Discard',
    body: (
      <>
        <p>Drops it from this machine’s stray-edit store. The served text stays in the copy.</p>
        <pre class="src">{stray.text}</pre>
      </>
    ),
    run: async () => {
      await write('skill_discard', { stray: stray.id });
      toast(`Discarded the stray edit to ${stray.skill}.`);
      await reload();
    },
  });
}

const VERBS: Readonly<Record<string, string>> = {
  create: 'created',
  comment: 'commented on',
  claim: 'claimed',
  release: 'released',
  close: 'closed',
  assign: 'assigned',
  reassign: 'reassigned',
  reopen: 'reopened',
  delete: 'deleted',
  resolve: 'resolved a conflict on',
  'outcome-set': 'overrode an outcome on',
  purge: 'purged a trace of',
  quarantine: 'quarantined',
  unquarantine: 'lifted a quarantine',
  'settings-set': 'changed a store setting',
  fold: 'folded the tracker',
  capture: 'attached session records',
  init: 'set up the tracker',
  compile: 'compiled the wiki',
  propose: 'drafted a skill proposal',
  accept: 'accepted a proposal',
  reject: 'rejected a proposal',
  'wiki-edit': 'edited the wiki',
  'skill-edit': 'edited a skill',
  record: 'recorded a stray edit',
};

function verbOf(entry: ActivityEntry): string {
  if (entry.op === 'update') return entry.fields && entry.fields.length > 0 ? `changed ${entry.fields.join(', ')} of` : 'updated';
  return VERBS[entry.op] ?? entry.op;
}

function FeedEntry({ entry, flash }: { entry: ActivityEntry; flash: boolean }) {
  return (
    <div class={flash ? 'feed-entry flash' : 'feed-entry'}>
      <ActorName person={entry.person} client={entry.actor.client} session={entry.actor.session} /> {verbOf(entry)}{' '}
      {entry.issue ? (
        <a href={`/issues/${entry.issue}`} class="id">
          {entry.issue}
        </a>
      ) : null}
      {entry.attempt ? (
        <>
          {' '}
          <a href={`/attempts/${entry.attempt}`} class="id mute">
            {entry.attempt}
          </a>
        </>
      ) : null}{' '}
      <span class="mute">· {ago(entry.at)}</span>
    </div>
  );
}

