// Issue detail (spec §20, Issue detail): the header, the main column (title,
// labels, conflict banners, the body, the timeline, a comment box) and the
// side panel (assignee and open attempts, status actions, parent and
// sub-issues, blockers and blocks, links, past attempts, delete). Every action
// is a core op through `/api/op/<name>`, recorded as the signed-in person
// through the dashboard; human-only ones carry 🔒 and a dialog naming them.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, write } from './api';
import { BodyBlock } from './body-editor';
import { issueActivity, showWhole, useLiveRefetch } from './data';
import { ago, duration, hostOf, short } from './format';
import { Markdown } from './markdown';
import { navigate } from './router';
import type { ActivityEntry, IssueDetail, ListRow, ListedOpenAttempt, PastAttempt, ShownComment } from './types';
import { ActorName, errorText, LockTag, openDialog, OutcomeChip, StateChip, toast, useMe, type FormValues } from './ui';

export interface IssueContext {
  /** Every issue, for the parent and blocker pickers and the issues this one blocks. */
  readonly rows: readonly ListRow[];
  /** Labels in use, for the label picker. */
  readonly labels: readonly string[];
  /** Identities seen on the tracker, for assign. */
  readonly people: readonly string[];
}

const ENDINGS: Readonly<Record<string, string>> = {
  done: 'closed it as done',
  canceled: 'closed it as canceled',
  release: 'released it',
  'release-abandoned': 'released it as abandoned',
  reassign: 'reassigned it',
  superseded: 'sealed it as superseded',
};

const FIELD_NAMES: Readonly<Record<string, string>> = {
  title: 'the title',
  status: 'the status',
  body: 'the body',
  labels: 'the labels',
  parent: 'the parent',
  blocked_by: 'the blockers',
  links: 'the links',
};

/** Runs an inline action: a failure shows as a toast with the core's code and message. */
async function act(action: () => Promise<unknown>, done?: string): Promise<boolean> {
  try {
    await action();
    if (done) toast(done);
    return true;
  } catch (error) {
    toast(errorText(error));
    return false;
  }
}

function personOf(actor: Readonly<Record<string, unknown>>): string | null {
  return typeof actor.person === 'string' ? actor.person : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A conflicted field's value, as text a person can compare. */
function shown(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  return JSON.stringify(value);
}

export function IssuePane({ id, context }: { id: string; context: IssueContext }) {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [flash, setFlash] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [whole, entries] = await Promise.all([showWhole(id), issueActivity(id).catch(() => [] as ActivityEntry[])]);
      setIssue(whole);
      setActivity(entries);
      setMissing(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        setIssue(null);
        setMissing(error.message);
      } else {
        toast(errorText(error));
      }
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefetch(
    (change) => {
      void reload();
      if (change) setFlash(Date.now());
    },
    (change) => change.issues.includes(id) || change.attempts.length > 0,
  );

  if (missing !== null) {
    return (
      <div class="issue missing">
        <div class="row between">
          <h1 class="mono">{id}</h1>
          <a href="/issues" class="small" title="Close">
            ✕
          </a>
        </div>
        <p class="mute">{missing}</p>
      </div>
    );
  }
  if (!issue) return <p class="mute loading-issue">Loading {id}…</p>;
  return <IssueView issue={issue} activity={activity} context={context} reload={reload} flash={flash} />;
}

function stateFacts(issue: IssueDetail) {
  return {
    status: issue.status,
    conflict: issue.conflict !== null,
    claimed: issue.open_attempts.length > 0,
    stale: issue.open_attempts.some((a) => a.stale),
    openBlockers: issue.blockers.filter((b) => b.status === 'open' || b.status === 'unknown').length,
    openChildren: issue.children.filter((c) => c.status === 'open').length,
    ready: issue.ready,
  };
}

function IssueView({ issue, activity, context, reload, flash }: { issue: IssueDetail; activity: readonly ActivityEntry[]; context: IssueContext; reload: () => Promise<void>; flash: number }) {
  const id = issue.id;
  const forgeHost = hostOf(issue.link);
  return (
    <div class="issue" data-issue={id}>
      <div class="row between wrap small issue-head">
        <div class="row wrap">
          <span class="id">{id}</span>
          <StateChip facts={stateFacts(issue)} />
          <span class="mute">
            #{issue.seq} · opened {ago(issue.created_at)} by {short(issue.created_by)}
          </span>
        </div>
        <div class="row">
          <button
            type="button"
            class="link small"
            title={issue.local_link}
            onClick={() => {
              void navigator.clipboard?.writeText(issue.local_link).then(
                () => toast(`Copied ${issue.local_link}`),
                () => toast(issue.local_link),
              );
            }}
          >
            Copy local link
          </button>
          {forgeHost ? (
            <a class="small" href={issue.link} target="_blank" rel="noreferrer noopener" title={issue.link}>
              Forge ↗
            </a>
          ) : (
            <span class="small mute" title="the forge link">
              {issue.link}
            </span>
          )}
          <span class="mute small mono revision" title="The revision: changes whenever the title, status, labels, relations, links or body change">
            {issue.revision.slice(0, 12)}
          </span>
          <a href="/issues" class="small" title="Close">
            ✕
          </a>
        </div>
      </div>
      <TitleEditor issue={issue} reload={reload} />
      <LabelsEditor issue={issue} labels={context.labels} reload={reload} />
      <ConflictBanners issue={issue} reload={reload} />
      <div class="detail">
        <div class="main-col">
          <BodyBlock issue={issue} reload={reload} />
          <Timeline issue={issue} activity={activity} flash={flash} />
          <CommentBox issue={issue} reload={reload} />
        </div>
        <aside class="dside">
          <SidePanel issue={issue} context={context} reload={reload} />
        </aside>
      </div>
    </div>
  );
}

function TitleEditor({ issue, reload }: { issue: IssueDetail; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <h1 class="issue-title">
        {issue.title}{' '}
        <button type="button" class="link small edit-title" onClick={() => setDraft(issue.title)}>
          edit
        </button>
      </h1>
    );
  }
  const save = async () => {
    const title = draft.trim();
    if (title === '' || title === issue.title) return setDraft(null);
    if (await act(() => write('update', { id: issue.id, title }))) {
      setDraft(null);
      await reload();
    }
  };
  return (
    <form
      class="row title-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input class="grow title-input" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      <button type="submit" class="pri">
        Save
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        Cancel
      </button>
    </form>
  );
}

function LabelsEditor({ issue, labels, reload }: { issue: IssueDetail; labels: readonly string[]; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState('');
  const listId = `labels-${issue.id}`;
  return (
    <form
      class="row wrap labels"
      onSubmit={(event) => {
        event.preventDefault();
        const label = draft.trim();
        if (!label) return;
        void act(() => write('update', { id: issue.id, labels_add: [label] })).then(async (ok) => {
          if (ok) {
            setDraft('');
            await reload();
          }
        });
      }}
    >
      {issue.labels.map((label) => (
        <span key={label} class="chip lbl">
          {label}{' '}
          <button
            type="button"
            class="link"
            title={`remove ${label}`}
            onClick={() => void act(() => write('update', { id: issue.id, labels_remove: [label] })).then(reload)}
          >
            ×
          </button>
        </span>
      ))}
      <input class="label-input" list={listId} placeholder="+ label" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      <datalist id={listId}>
        {labels.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
    </form>
  );
}

function releaseAbandoned(issue: IssueDetail, attempt: ListedOpenAttempt, reload: () => Promise<void>) {
  openDialog({
    title: `Release ${issue.id} as abandoned`,
    humanOnly: true,
    danger: true,
    ok: 'Release as abandoned',
    body: (
      <>
        <p>
          Ends <b>{attempt.assignee}</b>’s attempt <code>{attempt.attempt}</code> with outcome <b>fail</b> and no debrief, and leaves the issue open and
          unassigned.
        </p>
        <p class="mute small">
          {attempt.clients_seen.join(', ') || 'no client'} · claimed {ago(attempt.since)} · last activity {ago(attempt.last_activity_at)}
        </p>
        <label class="field">
          Comment (optional)
          <textarea name="comment" rows={2} />
        </label>
      </>
    ),
    run: async (values) => {
      await write('release', { id: issue.id, attempt: attempt.attempt, abandoned: true, ...(values.comment?.trim() ? { comment: values.comment.trim() } : {}) });
      toast(`Released ${attempt.attempt} as abandoned.`);
      await reload();
    },
  });
}

function ConflictBanners({ issue, reload }: { issue: IssueDetail; reload: () => Promise<void> }) {
  const conflict = issue.conflict;
  if (!conflict) return null;
  const fields = conflict.fields.filter((field) => field !== 'open_attempts');
  const twoAttempts = conflict.fields.includes('open_attempts');
  const kept = (field: string): unknown => (field in issue ? (issue as unknown as Record<string, unknown>)[field] : null);
  const resolve = () =>
    openDialog({
      title: `Resolve the conflict on ${issue.id}`,
      humanOnly: true,
      ok: 'Resolve',
      body: (
        <>
          <p class="mute small">
            The same operation as <code>grimoire resolve</code>: for each field, say whose value stands. The conflict records go in one commit.
          </p>
          {fields.map((field) => (
            <fieldset key={field} class="resolve-field">
              <legend>{FIELD_NAMES[field] ?? field}</legend>
              <label class="row top-al">
                <input type="radio" name={`take:${field}`} value="kept" defaultChecked />
                <span>
                  <b class="pre">{shown(kept(field))}</b>
                  <br />
                  <span class="mute small">kept by the fold (what the issue shows)</span>
                </span>
              </label>
              <label class="row top-al">
                <input type="radio" name={`take:${field}`} value="theirs" />
                <span>
                  <b class="pre">{shown(conflict.theirs[field])}</b>
                  <br />
                  <span class="mute small">set aside by the fold</span>
                </span>
              </label>
              <div class="mute small">
                Before both changes: <span class="pre">{shown(conflict.base[field])}</span>
              </div>
            </fieldset>
          ))}
        </>
      ),
      run: async (values: FormValues) => {
        const picked: Record<string, string> = {};
        for (const field of fields) picked[field] = values[`take:${field}`] ?? 'kept';
        const known = ['title', 'status', 'parent', 'body', 'deleted'];
        const input: Record<string, unknown> = { id: issue.id, fields: Object.fromEntries(Object.entries(picked).filter(([field]) => known.includes(field))) };
        if (fields.some((field) => !known.includes(field))) input.take = 'kept';
        await write('resolve', input);
        toast(`Resolved the conflict on ${issue.id}.`);
        await reload();
      },
    });
  return (
    <>
      {fields.length > 0 ? (
        <div class="banner bad conflict-banner">
          <b>Conflict on {fields.map((field) => FIELD_NAMES[field] ?? field).join(', ')}.</b> Two clones changed it before they synced. Claims, full-body
          replaces and edits of {fields.length === 1 ? 'that field' : 'those fields'} are blocked until it is resolved; comments and anchored patches still
          work.
          <dl class="conflict-values">
            {fields.map((field) => (
              <div key={field}>
                <dt>{FIELD_NAMES[field] ?? field}</dt>
                <dd>
                  kept <span class="pre">{shown(kept(field))}</span> · set aside <span class="pre">{shown(conflict.theirs[field])}</span> · base{' '}
                  <span class="pre">{shown(conflict.base[field])}</span>
                </dd>
              </div>
            ))}
          </dl>
          <div class="row">
            <button type="button" class="resolve" onClick={resolve}>
              Resolve…
            </button>
            <LockTag />
          </div>
        </div>
      ) : null}
      {twoAttempts ? (
        <div class="banner bad">
          <b>Two open attempts.</b>{' '}
          {issue.open_attempts.map((a) => `${short(a.assignee)} (${a.attempt}, ${ago(a.since)})`).join(' and ')} claimed it on different clones. Claims fail
          until one ends.
          <div class="row wrap">
            {issue.open_attempts.map((a) => (
              <button key={a.attempt} type="button" onClick={() => releaseAbandoned(issue, a, reload)}>
                Release {short(a.assignee)}’s as abandoned…
              </button>
            ))}
            <LockTag />
          </div>
        </div>
      ) : null}
    </>
  );
}

interface TimelineItem {
  readonly at: string;
  /** Orders items made at the same instant: create, attempt start, field change, comment, attempt end. */
  readonly rank: number;
  readonly key: string;
  readonly node: ComponentChildren;
}

function clientOf(actor: Readonly<Record<string, unknown>>): string | null {
  return str(actor.client);
}

function Timeline({ issue, activity, flash }: { issue: IssueDetail; activity: readonly ActivityEntry[]; flash: number }) {
  const items: TimelineItem[] = [];
  const entryFor = (op: string, attempt: string) => activity.find((entry) => entry.op === op && entry.attempt === attempt);
  for (const comment of issue.comments) items.push({ at: comment.at, rank: 3, key: `c:${comment.id}`, node: <CommentCard comment={comment} /> });
  const attempts: { attempt: string; assignee: string; since: string; opened: string; past: PastAttempt | null }[] = [
    ...issue.past_attempts.map((past) => ({ attempt: past.attempt, assignee: past.assignee, since: past.since, opened: past.opened, past })),
    ...issue.open_attempts.map((open) => ({ attempt: open.attempt, assignee: open.assignee, since: open.since, opened: '', past: null })),
  ];
  for (const a of attempts) {
    const start = activity.find((entry) => (entry.op === 'claim' || entry.op === 'assign' || entry.op === 'reassign') && entry.attempt === a.attempt) ?? (a.opened === 'claim' ? entryFor('claim', a.attempt) : undefined);
    if (a.opened !== 'unclaimed-close') {
      items.push({
        at: a.since,
        rank: 1,
        key: `s:${a.attempt}`,
        node: (
          <div class="tl-ev attempt-start">
            ▶{' '}
            {a.opened === 'assign' ? (
              <>
                <ActorName person={start?.person ?? null} client={start?.actor.client} /> assigned {short(a.assignee)}
              </>
            ) : (
              <>
                <ActorName person={a.assignee} client={start?.actor.client} session={start?.actor.session} /> claimed it
              </>
            )}{' '}
            · <a href={`/attempts/${a.attempt}`}>{a.attempt}</a> · {ago(a.since)}
          </div>
        ),
      });
    }
    if (a.past) {
      const past = a.past;
      const end = activity.find((entry) => (entry.op === 'close' || entry.op === 'release' || entry.op === 'reassign' || entry.op === 'reopen') && entry.attempt === past.attempt);
      items.push({
        at: past.ended_at,
        rank: 4,
        key: `e:${past.attempt}`,
        node: (
          <div class="tl-ev attempt-end">
            ■ <ActorName person={past.ended_by || null} client={end?.actor.client} session={end?.actor.session} /> {ENDINGS[past.ended] ?? past.ended} ·{' '}
            <a href={`/attempts/${past.attempt}`}>{past.attempt}</a> · outcome <OutcomeChip outcome={past.outcome} /> · {ago(past.ended_at)}
          </div>
        ),
      });
    }
  }
  for (const entry of activity) {
    const what =
      entry.op === 'create'
        ? 'created it'
        : entry.op === 'update'
          ? entry.fields && entry.fields.length > 0
            ? `changed ${entry.fields.map((field) => FIELD_NAMES[field] ?? field).join(', ')}`
            : 'updated it'
          : entry.op === 'resolve'
            ? `resolved a conflict${entry.fields && entry.fields.length > 0 ? ` (${entry.fields.map((field) => FIELD_NAMES[field] ?? field).join(', ')})` : ''}`
            : entry.op === 'reopen'
              ? 'reopened it'
              : entry.op === 'delete'
                ? 'deleted it'
                : null;
    if (what === null) continue;
    items.push({
      at: entry.at,
      rank: entry.op === 'create' ? 0 : 2,
      key: `a:${entry.commit}`,
      node: (
        <div class="tl-ev field-change">
          • <ActorName person={entry.person} client={entry.actor.client} session={entry.actor.session} /> {what} · {ago(entry.at)}
        </div>
      ),
    });
  }
  items.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.rank - y.rank));
  return (
    <section class="timeline-block">
      <h3>Activity</h3>
      <div class="tl">
        {items.length === 0 ? <div class="tl-ev">No activity yet.</div> : null}
        {items.map((item, k) => (
          <div key={item.key} class={k === items.length - 1 && Date.now() - flash < 2_600 ? 'flash' : undefined}>
            {item.node}
          </div>
        ))}
      </div>
    </section>
  );
}

function CommentCard({ comment }: { comment: ShownComment }) {
  const person = personOf(comment.actor);
  const head = (
    <>
      <ActorName person={person} client={clientOf(comment.actor)} session={str(comment.actor.session)} /> · {ago(comment.at)}
    </>
  );
  if (comment.kind === 'debrief') {
    return (
      <div class="tl-item debrief">
        <div class="tl-head">
          Debrief · {head}
          {comment.attempt ? (
            <>
              {' '}
              · attempt <a href={`/attempts/${comment.attempt}`}>{comment.attempt}</a>
            </>
          ) : null}
        </div>
        <Markdown source={comment.body} />
      </div>
    );
  }
  return (
    <div class="tl-item comment">
      <div class="tl-head">{head}</div>
      <Markdown source={comment.body} />
    </div>
  );
}

function CommentBox({ issue, reload }: { issue: IssueDetail; reload: () => Promise<void> }) {
  const me = useMe();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (draft.trim() === '' || busy) return;
    setBusy(true);
    const ok = await act(() => write('comment', { id: issue.id, body: draft }));
    setBusy(false);
    if (ok) {
      setDraft('');
      await reload();
    }
  };
  return (
    <section class="comment-box">
      <textarea
        class="comment-input"
        rows={3}
        placeholder={`Comment as ${me.email ?? 'you'}. Comments are never edited or deleted.`}
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
      />
      <div class="row">
        <button type="button" class="pri comment-send" disabled={busy || draft.trim() === ''} onClick={() => void send()}>
          Comment
        </button>
      </div>
    </section>
  );
}

// ---------- the side panel ----------

function Section({ title, tag, children }: { title: string; tag?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="sec">
      <div class="k">
        <span>{title}</span>
        {tag}
      </div>
      {children}
    </div>
  );
}

/** A person picker: identities seen on the tracker, or any typed email. */
function PersonField({ people, except }: { people: readonly string[]; except?: string }) {
  const listId = 'people-seen';
  return (
    <label class="field">
      Person (pick one seen on the tracker, or type an email)
      <input name="assignee" type="email" list={listId} autocomplete="off" />
      <datalist id={listId}>
        {people
          .filter((person) => person !== except)
          .map((person) => (
            <option key={person} value={person} />
          ))}
      </datalist>
    </label>
  );
}

const needsPerson = (values: FormValues) => ((values.assignee ?? '').trim() === '' ? 'Pick or type a person.' : null);

function closeDialog(issue: IssueDetail, mine: ListedOpenAttempt | null, reload: () => Promise<void>) {
  openDialog({
    title: `Close ${issue.id}`,
    ok: 'Close',
    body: (
      <>
        <div class="row">
          <label class="row">
            <input type="radio" name="reason" value="done" defaultChecked /> done
          </label>
          <label class="row">
            <input type="radio" name="reason" value="canceled" /> canceled
          </label>
        </div>
        <label class="field">
          Comment (optional)
          <textarea name="comment" rows={2} />
        </label>
        {mine ? (
          <details>
            <summary>Add a debrief (optional for people)</summary>
            {['asked', 'tried', 'failed', 'worked', 'next'].map((field) => (
              <label key={field} class="row debrief-field">
                <span class="mute">{field}</span>
                <input name={`d_${field}`} class="grow" />
              </label>
            ))}
          </details>
        ) : (
          <p class="mute small">No one holds it, so this records an unclaimed close by you.</p>
        )}
      </>
    ),
    run: async (values) => {
      const debriefFields = ['asked', 'tried', 'failed', 'worked', 'next'];
      const debrief = debriefFields.some((field) => (values[`d_${field}`] ?? '').trim() !== '')
        ? Object.fromEntries(debriefFields.map((field) => [field, (values[`d_${field}`] ?? '').trim() || 'none']))
        : undefined;
      await write('close', {
        id: issue.id,
        reason: values.reason === 'canceled' ? 'canceled' : 'done',
        ...(mine ? { attempt: mine.attempt } : {}),
        ...(values.comment?.trim() ? { comment: values.comment.trim() } : {}),
        ...(debrief ? { debrief } : {}),
      });
      toast(`Closed ${issue.id}.`);
      await reload();
    },
  });
}

function SidePanel({ issue, context, reload }: { issue: IssueDetail; context: IssueContext; reload: () => Promise<void> }) {
  const id = issue.id;
  const open = issue.status === 'open';
  const held = issue.open_attempts;
  const othersHold = held.some((a) => !a.held_by_you);
  const blocks = context.rows.filter((row) => row.blocked_by.includes(id));
  const [blocker, setBlocker] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkTitle, setLinkTitle] = useState('');

  const assignee =
    held.length > 0 ? (
      held.map((a) => (
        <div key={a.attempt} class="open-attempt">
          <ActorName person={a.assignee} client={a.clients_seen.find((client) => client !== 'dashboard') ?? (a.clients_seen.includes('dashboard') ? 'dashboard' : null)} />
          <div class="mute small">
            since {ago(a.since)} · last activity {ago(a.last_activity_at)} · <a href={`/attempts/${a.attempt}`}>{a.attempt}</a>
          </div>
          {a.stale ? <span class="chip warn stale">stale: no activity for {duration(Date.now() - Date.parse(a.last_activity_at))}</span> : null}
          <div class="row wrap">
            {a.held_by_you ? (
              <>
                <button type="button" class="close-mine" onClick={() => closeDialog(issue, a, reload)}>
                  Close…
                </button>
                <button
                  type="button"
                  class="release-mine"
                  onClick={() =>
                    openDialog({
                      title: `Release ${id}`,
                      ok: 'Release',
                      body: (
                        <>
                          <p>
                            Gives up your attempt <code>{a.attempt}</code> without closing the issue; its outcome is <b>fail</b>.
                          </p>
                          <label class="field">
                            Comment (optional)
                            <textarea name="comment" rows={2} />
                          </label>
                        </>
                      ),
                      run: async (values) => {
                        await write('release', { id, attempt: a.attempt, ...(values.comment?.trim() ? { comment: values.comment.trim() } : {}) });
                        toast(`Released ${a.attempt}.`);
                        await reload();
                      },
                    })
                  }
                >
                  Release…
                </button>
              </>
            ) : null}
            <button
              type="button"
              class="reassign"
              onClick={() =>
                openDialog({
                  title: `Reassign ${id}`,
                  humanOnly: true,
                  ok: 'Reassign',
                  body: (
                    <>
                      <p>
                        Ends {a.assignee}’s attempt <code>{a.attempt}</code> (outcome fail) and opens a new one for the person you pick.
                      </p>
                      <PersonField people={context.people} except={a.assignee} />
                    </>
                  ),
                  validate: needsPerson,
                  run: async (values) => {
                    await write('reassign', { id, assignee: values.assignee!.trim() });
                    toast(`Reassigned ${id}.`);
                    await reload();
                  },
                })
              }
            >
              Reassign… 🔒
            </button>
            <button type="button" class="abandon" onClick={() => releaseAbandoned(issue, a, reload)}>
              Release as abandoned… 🔒
            </button>
          </div>
        </div>
      ))
    ) : open ? (
      <>
        <div class="mute">Unassigned</div>
        <div class="row wrap">
          <button
            type="button"
            class="take"
            onClick={() =>
              openDialog({
                title: `Take ${id} yourself`,
                ok: 'Claim',
                body: <p>Opens an attempt with you as the worker. Close or release it here when you are done; a debrief is optional for people.</p>,
                run: async () => {
                  await write('claim', { id });
                  toast(`You hold ${id}.`);
                  await reload();
                },
              })
            }
          >
            Take it myself
          </button>
          <button
            type="button"
            class="assign"
            onClick={() =>
              openDialog({
                title: `Assign ${id}`,
                humanOnly: true,
                ok: 'Assign',
                body: (
                  <>
                    <p>Opens an attempt on that person’s behalf; their agent then works it under their identity.</p>
                    <PersonField people={context.people} />
                  </>
                ),
                validate: needsPerson,
                run: async (values) => {
                  await write('assign', { id, assignee: values.assignee!.trim() });
                  toast(`Assigned ${id}.`);
                  await reload();
                },
              })
            }
          >
            Assign… 🔒
          </button>
        </div>
      </>
    ) : (
      <div class="mute">—</div>
    );

  const status = open ? (
    othersHold ? (
      <div>
        <button type="button" class="close-issue" disabled title="Someone else holds it">
          Close…
        </button>
        <p class="mute small">{short(held.find((a) => !a.held_by_you)!.assignee)} holds an open attempt: end theirs first (reassign, or release as abandoned).</p>
      </div>
    ) : held.length === 0 ? (
      <div class="row wrap">
        <button type="button" class="close-issue" onClick={() => closeDialog(issue, null, reload)}>
          Close…
        </button>
      </div>
    ) : (
      <p class="mute small">Close or release your attempt above.</p>
    )
  ) : (
    <div class="row wrap">
      <StateChip facts={stateFacts(issue)} />
      <button
        type="button"
        class="reopen"
        onClick={() =>
          openDialog({
            title: `Reopen ${id}`,
            humanOnly: true,
            ok: 'Reopen',
            body: (
              <>
                <p>Back to open and unassigned, with no attempt. A closing attempt that passed turns to fail.</p>
                <label class="field">
                  Why (required, posted as a comment)
                  <textarea name="comment" rows={3} />
                </label>
              </>
            ),
            validate: (values) => ((values.comment ?? '').trim() === '' ? 'Reopen needs a comment.' : null),
            run: async (values) => {
              await write('reopen', { id, comment: values.comment!.trim() });
              toast(`Reopened ${id}.`);
              await reload();
            },
          })
        }
      >
        Reopen… 🔒
      </button>
    </div>
  );

  const candidates = context.rows.filter((row) => row.id !== id);
  return (
    <>
      <Section title="Assignee" tag={<LockTag />}>
        {assignee}
      </Section>
      <Section title="Status">{status}</Section>
      <Section title="Parent">
        <select
          class="parent-select"
          value={issue.parent ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value;
            void act(() => write('update', { id, parent: value === '' ? null : value })).then(reload);
          }}
        >
          <option value="">none</option>
          {issue.parent && !candidates.some((row) => row.id === issue.parent) ? <option value={issue.parent}>{issue.parent}</option> : null}
          {candidates.map((row) => (
            <option key={row.id} value={row.id}>
              {row.id} {row.title.slice(0, 40)}
            </option>
          ))}
        </select>
      </Section>
      {issue.children.length > 0 ? (
        <Section title={`Sub-issues · ${issue.children.filter((kid) => kid.status !== 'open').length}/${issue.children.length} closed`}>
          {issue.children.map((kid) => (
            <div key={kid.id} class="rel">
              <a href={`/issues/${kid.id}`}>
                <span class="id">{kid.id}</span> {kid.title ?? '(deleted)'}
              </a>{' '}
              <span class="chip small-chip">{kid.status}</span>
            </div>
          ))}
        </Section>
      ) : null}
      <Section title="Blocked by">
        {issue.blockers.map((b) => (
          <div key={b.id} class="row between rel">
            <span>
              <a href={`/issues/${b.id}`}>
                <span class="id">{b.id}</span> {b.title ?? '(gone)'}
              </a>{' '}
              <span class={`chip small-chip ${b.status === 'unknown' ? 'bad' : ''}`}>{b.status}</span>
            </span>
            <button
              type="button"
              class="link blocker-remove"
              title={`remove ${b.id}`}
              onClick={() => void act(() => write('update', { id, blocked_by_remove: [b.id] })).then(reload)}
            >
              ×
            </button>
          </div>
        ))}
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocker) return;
            void act(() => write('update', { id, blocked_by_add: [blocker] })).then(async (ok) => {
              if (ok) setBlocker('');
              await reload();
            });
          }}
        >
          <select class="grow blocker-select" value={blocker} onChange={(event) => setBlocker(event.currentTarget.value)}>
            <option value="">add blocker…</option>
            {candidates
              .filter((row) => !issue.blocked_by.includes(row.id))
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id} {row.title.slice(0, 36)}
                </option>
              ))}
          </select>
          <button type="submit" class="blocker-add">
            Add
          </button>
        </form>
      </Section>
      {blocks.length > 0 ? (
        <Section title="Blocks">
          {blocks.map((row) => (
            <div key={row.id} class="rel">
              <a href={`/issues/${row.id}`}>
                <span class="id">{row.id}</span> {row.title}
              </a>
            </div>
          ))}
        </Section>
      ) : null}
      <Section title="Links">
        {issue.links.map((link) => {
          const host = hostOf(link.target);
          return (
            <div key={link.target} class="rel link-row">
              {host ? (
                <>
                  <a href={link.target} target="_blank" rel="noreferrer noopener">
                    {link.title || link.target}
                  </a>{' '}
                  <span class="md-host">↗ {host}</span>
                </>
              ) : (
                <span title={link.target}>
                  {link.title || link.target} {link.title ? <span class="mute small">({link.target})</span> : null}
                </span>
              )}
            </div>
          );
        })}
        <form
          class="stack link-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = linkTarget.trim();
            if (!target) return;
            void act(() => write('update', { id, links_add: [{ target, ...(linkTitle.trim() ? { title: linkTitle.trim() } : {}) }] })).then(async (ok) => {
              if (ok) {
                setLinkTarget('');
                setLinkTitle('');
              }
              await reload();
            });
          }}
        >
          <input class="link-target" placeholder="URL, repo path or git ref" value={linkTarget} onInput={(event) => setLinkTarget(event.currentTarget.value)} />
          <div class="row">
            <input class="grow link-title" placeholder="title (optional)" value={linkTitle} onInput={(event) => setLinkTitle(event.currentTarget.value)} />
            <button type="submit">Add link</button>
          </div>
        </form>
      </Section>
      <Section title="Past attempts">
        {issue.past_attempts.length === 0 ? <div class="mute">None yet.</div> : null}
        {[...issue.past_attempts].reverse().map((past) => (
          <div key={past.attempt} class="row between rel past-attempt">
            <span>
              <a href={`/attempts/${past.attempt}`} class="id">
                {past.attempt}
              </a>{' '}
              {short(past.assignee || past.ended_by)} <span class="mute small">{ENDINGS[past.ended] ?? past.ended}</span>
            </span>
            <OutcomeChip outcome={past.outcome} />
          </div>
        ))}
      </Section>
      <Section title="Danger" tag={<LockTag />}>
        <button
          type="button"
          class="danger delete-issue"
          onClick={() =>
            openDialog({
              title: `Delete ${id}?`,
              humanOnly: true,
              danger: true,
              ok: 'Delete issue',
              typed: id,
              body: (
                <>
                  <p>
                    Removes the issue record. Its attempts, traces and outcomes stay; the id is never reused and <code>show</code> answers that it was deleted.
                  </p>
                  {issue.children.length > 0 ? <p class="banner warn">It has sub-issues: delete refuses it. Close it as canceled instead.</p> : null}
                  <p class="mute small">Prefer Close → canceled unless the issue should not exist at all.</p>
                </>
              ),
              run: async () => {
                await write('delete', { id });
                toast(`Deleted ${id}.`);
                navigate('/issues');
              },
            })
          }
        >
          Delete issue… 🔒
        </button>
      </Section>
    </>
  );
}
