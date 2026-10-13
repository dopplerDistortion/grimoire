// Attention, the dashboard's home (spec §20 Attention): only what a human
// must unblock, each item with its action inline (from the core's
// `attention`), then count tiles linking to the Issues quick views, then the
// live activity feed (the core's `activity`): person, "via client · session",
// verb, issue link, age. Every live update refetches both in place; new feed
// entries flash. The empty state reads "Nothing needs you. Agents are working
// through the frontier."
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, read, runner as readRunner, write } from './api';
import { showWhole, useLiveRefetch } from './data';
import { ago, short } from './format';
import { releaseAbandoned, resolveConflict } from './issue';
import { acknowledgeDialog } from './skills';
import { quarantineDialog } from './trace-actions';
import type { ActivityEntry, ActivityResult, AttentionItem, AttentionResult, RunnerInfo, ShownStrayEdit } from './types';
import { ActorName, errorText, openDialog, toast, Version } from './ui';

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
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const [feed, setFeed] = useState<readonly ActivityEntry[]>([]);
  const [fresh, setFresh] = useState<{ commits: ReadonlySet<string>; at: number }>({ commits: new Set(), at: 0 });
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [attention, activity] = await Promise.all([read<AttentionResult>('attention'), read<ActivityResult>('activity', { limit: FEED_SIZE })]);
      setResult(attention);
      // This machine's runner is read beside the ops; its trouble is an item too, and failing to read it hides only that.
      void readRunner<RunnerInfo>().then(setRunner, () => setRunner(null));
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
  const trouble = runnerTrouble(runner);
  const count = result.items.length + (trouble ? 1 : 0);
  return (
    <div class="attention-screen">
      <div class="row between">
        <h1>Attention</h1>
        <span class="mute small attention-count">
          {count} item{count === 1 ? '' : 's'}
        </span>
      </div>
      {error ? <div class="banner bad">{error}</div> : null}
      <div class="panel attention-items">
        {count === 0 ? <div class="pad mute attention-empty">{EMPTY}</div> : null}
        {result.items.map((item) => (
          <Item key={itemKey(item)} item={item} reload={reload} />
        ))}
        {trouble ? <RunnerRow runner={runner!} trouble={trouble} /> : null}
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
    case 'pending_proposal':
      return `proposal:${item.proposal.id}`;
    case 'skill_fork':
      return `fork:${item.skill}`;
    case 'wiki_conflict':
    case 'flagged_page':
      return `${item.kind}:${item.slug}`;
    case 'set_aside':
      return `set-aside:${item.pair}`;
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
function Row({ tone, icon, title, detail, actions, kind, id }: { tone: string; icon: string; title: ComponentChildren; detail: ComponentChildren; actions: ComponentChildren; kind: string; id?: string }) {
  return (
    <div class={`att att-${kind}`} data-id={id}>
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
                Hit by {hitBy(item.client, item.surface)} · {ago(item.at)}
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
    case 'pending_proposal': {
      const p = item.proposal;
      return (
        <Row
          kind="proposal"
          tone="acc"
          icon="✦"
          title={
            <>
              Skill proposal pending: {p.action} <b>{p.skill}</b> <span class="id">{p.id}</span>
            </>
          }
          detail={
            <>
              waiting {p.age_hours < 1 ? 'under an hour' : `${p.age_hours}h`} · <span class="red-count">{p.red_flags} red flag{p.red_flags === 1 ? '' : 's'}</span> · {p.traces} cited
              trace{p.traces === 1 ? '' : 's'} · {p.pages} page{p.pages === 1 ? '' : 's'}
            </>
          }
          actions={
            <a class="button pri review" href={`/knowledge/proposals/${p.id}`}>
              Review
            </a>
          }
        />
      );
    }
    case 'skill_fork':
      return (
        <Row
          kind="fork"
          tone="warn"
          icon="⑂"
          title={
            <>
              {item.fork ? 'Skill fork to pick' : 'Contested skill decision'}: <a href={`/knowledge/skills/${encodeURIComponent(item.skill)}`}>{item.skill}</a>
            </>
          }
          detail={
            <>
              {item.fork ? 'Two clones changed it apart; ' : `An accept met a reject of ${item.contested.join(', ')}; `}
              the ledger serves <Version id={item.current} /> until someone acknowledges one of{' '}
              {item.choices.map((choice, k) => (
                <span key={choice.version}>
                  {k > 0 ? ', ' : ''}
                  <Version id={choice.version} />
                  {choice.by ? ` (${choice.kind ?? 'change'} by ${short(choice.by)})` : ''}
                </span>
              ))}
              .
            </>
          }
          actions={
            <button
              type="button"
              class="acknowledge"
              onClick={() =>
                acknowledgeDialog(
                  item.skill,
                  item.choices.map((choice) => choice.version),
                  item.choices.find((choice) => choice.standing)?.version ?? null,
                  reload,
                )
              }
            >
              Acknowledge… 🔒
            </button>
          }
        />
      );
    case 'wiki_conflict':
      return (
        <Row
          kind="wiki-conflict"
          tone="bad"
          icon="⑂"
          title={
            <>
              Conflicted wiki page: <a href={`/knowledge/wiki/${item.slug}`}>{item.title}</a>
            </>
          }
          detail={
            <>
              A fold set {item.sides === 1 ? 'a side' : `${item.sides} sides`} aside. The Wiki Maintainer reconciles it on its next run, or reconcile it yourself:{' '}
              <code>grimoire wiki edit {item.slug}</code>
            </>
          }
          actions={
            <a class="small" href={`/knowledge/wiki/${item.slug}`}>
              Open page
            </a>
          }
        />
      );
    case 'set_aside':
      return (
        <Row
          kind="set-aside"
          tone="warn"
          icon="⊘"
          title={
            <>
              Set-aside pair: <span class="id">{item.trace}</span> ({item.outcome})
            </>
          }
          detail={`Seen in ${item.strikes} failed compiles, so it is never offered again. Quarantine it if the trace itself is the problem.`}
          actions={
            <>
              <a class="small open-trace" href={`/attempts/${item.trace}`}>
                Open trace
              </a>
              <button type="button" class="quarantine" onClick={() => quarantineDialog({ trace: item.trace }, reload)}>
                Quarantine… 🔒
              </button>
            </>
          }
        />
      );
    case 'flagged_page':
      return (
        <Row
          kind="flagged"
          tone="warn"
          icon="⚑"
          title={
            <>
              Flagged wiki page: <a href={`/knowledge/wiki/${item.slug}`}>{item.title}</a>
            </>
          }
          detail={`A compile that wrote it consumed the quarantined trace${item.flagged_by.length === 1 ? '' : 's'} ${item.flagged_by.join(', ')}.`}
          actions={
            <>
              {item.flagged_by.map((trace) => (
                <a key={trace} class="small open-trace" href={`/attempts/${trace}`}>
                  Open {trace}
                </a>
              ))}
              <button type="button" class="quarantine-page" onClick={() => quarantineDialog({ page: item.slug }, reload)}>
                Quarantine page… 🔒
              </button>
            </>
          }
        />
      );
  }
}

/** What is wrong with this machine's runner, if anything a person must see: its backoff, or a refused preflight. */
function runnerTrouble(runner: RunnerInfo | null): string | null {
  if (!runner?.enabled) return null;
  if (runner.paused_until && Date.parse(runner.paused_until) > Date.now()) return `paused until ${runner.paused_until} after ${runner.consecutive_failures ?? 2} failed runs in a row`;
  if (runner.trigger?.preflight) return `its preflight was refused: ${runner.trigger.message ?? 'see grimoire status'}`;
  return null;
}

function RunnerRow({ runner, trouble }: { runner: RunnerInfo; trouble: string }) {
  return (
    <Row
      kind="runner"
      tone="bad"
      icon="⚙"
      title={`The runner (${runner.kind ?? 'this machine'}) is ${trouble.startsWith('paused') ? 'backing off' : 'refused'}`}
      detail={
        <>
          {trouble}. Status only here: <code>grimoire status</code> and <code>{runner.commands.disable}</code> work in a terminal.
        </>
      }
      actions={
        <a class="small" href="/knowledge">
          Knowledge
        </a>
      }
    />
  );
}

function StrayEditRow({ stray, reload }: { stray: ShownStrayEdit; reload: () => Promise<void> }) {
  return (
    <Row
      kind="stray"
      id={stray.id}
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

const SURFACE_NOUNS: Readonly<Record<string, string>> = { mcp: 'server', cli: 'CLI call', hook: 'hook', runner: 'runner' };

/** Whose process hit a sync failure: "the dashboard", "a claude-code server". */
function hitBy(client: string, surface: string): string {
  if (surface === 'dashboard') return 'the dashboard';
  return `a ${client} ${SURFACE_NOUNS[surface] ?? surface}`;
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
  dismiss: 'dismissed a proposal',
  reconsider: 'reconsidered a proposal',
  lapse: 'lapsed a proposal',
  restore: 'restored a skill',
  'skill-delete': 'deleted a skill',
  eject: 'ejected a skill',
  acknowledge: 'acknowledged a skill version',
  unblock: 'lifted a skill name’s block',
  'proposal-purge': 'purged a proposal',
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

