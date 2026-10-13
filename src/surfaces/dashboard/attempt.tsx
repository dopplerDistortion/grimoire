// The attempt page, `/attempts/<id>` (spec §20 Attempt page): a person audits
// what an agent did, from the core's `attempt_show`:
//
// - the outcome chip, its history, and 🔒 Override (pass, fail or none, with a
//   required reason);
// - start facts (how it opened, the actor, the delivery switch, the offered
//   versions, wiki-exposed) and end facts (how it ended, by whom, the
//   versions read, commits);
// - the capture status: each bound context (client, session, context) with
//   its excerpt and facts statuses, `facts_complete`, the wiki-exposed basis,
//   and the commits with `via` and any agent skill-edit flag;
// - the sessions: each excerpt collapsed, as inert source text;
// - the knowledge use: the pattern pages and proposals citing it;
// - 🔒 Quarantine (reason required), 🔒 Purge trace (typed id and reason; it
//   warns that pushed history keeps it and lists what cites it), and on an
//   open attempt 🔒 Purge one session record (the excerpt alone, or with its
//   facts).
//
// Excerpts, like every agent-authored text here, render as text nodes: never
// markup.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, read, write } from './api';
import { useLiveRefetch } from './data';
import { ago, short } from './format';
import type { AttemptShowResult, ShownContext, ShownOutcome } from './types';
import { ActorName, errorText, LockTag, openDialog, OutcomeChip, toast } from './ui';

const OPENINGS: Readonly<Record<string, string>> = { claim: 'claimed', assign: 'assigned', 'unclaimed-close': 'closed unclaimed (an instant attempt)' };

const ENDINGS: Readonly<Record<string, string>> = {
  done: 'closed as done',
  canceled: 'closed as canceled',
  release: 'released',
  'release-abandoned': 'released as abandoned',
  reassign: 'reassigned',
  superseded: 'superseded',
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function setBy(outcome: ShownOutcome): string {
  return outcome.set_by.startsWith('human:') ? outcome.set_by.slice(6) : outcome.set_by;
}

export function AttemptScreen({ id }: { id: string }) {
  const [shown, setShown] = useState<AttemptShowResult | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);

  const reload = useCallback(async () => {
    try {
      setShown(await read<AttemptShowResult>('attempt_show', { attempt: id }));
      setMissing(null);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'NOT_FOUND' || error.code === 'INVALID')) {
        setShown(null);
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
    (change) => change.attempts.includes(id) || (shown?.issue ? change.issues.includes(shown.issue.id) : false) || change.knowledge,
  );

  if (missing !== null) {
    return (
      <div class="attempt missing">
        <h1 class="mono">{id}</h1>
        <p class="mute">{missing}</p>
      </div>
    );
  }
  if (!shown) return <p class="mute loading-attempt">Loading {id}…</p>;
  if (shown.state === 'purged') return <PurgedAttempt shown={shown} />;
  return <AttemptView shown={shown} reload={reload} flash={Date.now() - flash < 2_600} />;
}

function PurgedAttempt({ shown }: { shown: AttemptShowResult }) {
  const purged = shown.purged!;
  return (
    <div class="attempt purged-attempt">
      <div class="small mute">Attempt · purged trace</div>
      <h1 class="mono">{shown.attempt}</h1>
      <p class="banner warn">
        Purged by {purged.by} {ago(purged.at)}: {purged.reason}. The tombstone wins every later fold; pushed git history still has the content.
      </p>
      <KnowledgeUse shown={shown} />
    </div>
  );
}

function Panel({ title, children, tag, cls }: { title: string; children: ComponentChildren; tag?: ComponentChildren; cls?: string }) {
  return (
    <section class={`panel pad ${cls ?? ''}`}>
      <div class="row between">
        <h2>{title}</h2>
        {tag}
      </div>
      {children}
    </section>
  );
}

function AttemptView({ shown, reload, flash }: { shown: AttemptShowResult; reload: () => Promise<void>; flash: boolean }) {
  const start = shown.start!;
  const end = shown.end;
  const issue = shown.issue!;
  const wiki = shown.capture.wiki_exposed;
  return (
    <div class={`attempt${flash ? ' flash' : ''}`}>
      <div class="row between wrap">
        <div>
          <div class="small mute">Attempt · {end ? 'sealed trace' : 'open'}</div>
          <h1 class="mono attempt-id">{shown.attempt}</h1>
          <div>
            <a href={`/issues/${issue.id}`}>
              <span class="id">{issue.id}</span> {issue.title ?? '(deleted)'}
            </a>{' '}
            <span class="mute small">{issue.status}</span>
          </div>
        </div>
        <div class="row">
          {shown.quarantine ? <span class="chip warn">quarantined</span> : null}
          {wiki.exposed ? (
            <span class="chip warn" title="A knowledge chore ran in a session or process this attempt bound from">
              wiki-exposed
            </span>
          ) : null}
          {shown.stale ? <span class="chip warn">stale claim</span> : null}
          {shown.set_aside > 0 ? <span class="chip bad">sealed twice: {shown.set_aside} seal set aside</span> : null}
        </div>
      </div>
      {shown.quarantine ? (
        <div class="banner warn">
          Quarantined by {shown.quarantine.by} {ago(shown.quarantine.at)}: {shown.quarantine.reason}
        </div>
      ) : null}

      <div class="grid2">
        <OutcomePanel shown={shown} reload={reload} />
        <Panel title="Start" cls="start-facts">
          <div>
            {start.opened === 'unclaimed-close' ? (
              OPENINGS[start.opened]
            ) : (
              <>
                <ActorName person={str(start.actor.person) ?? start.assignee} client={str(start.actor.client)} session={str(start.actor.session)} /> {OPENINGS[start.opened] ?? start.opened}
                {start.opened === 'assign' ? ` it for ${short(start.assignee)}` : ''}
              </>
            )}{' '}
            · {ago(start.at)}
          </div>
          <div>
            Delivery switch: <b>{start.delivery ?? 'not recorded'}</b> · Offered: <SkillList skills={start.skills_offered} none={start.skills_offered === null ? 'unknown (no checkout of its own)' : 'none'} />
          </div>
          <div>Wiki-exposed at the claim: {start.wiki_exposed ? 'yes' : 'no'}</div>
          {end ? null : <div>Last activity {ago(shown.last_activity_at)}</div>}
        </Panel>
      </div>

      {end ? (
        <Panel title="End" cls="end-facts">
          <div>
            <ActorName person={str(end.ended_by.person)} client={str(end.ended_by.client)} session={str(end.ended_by.session)} /> {ENDINGS[end.ended] ?? end.ended} ·{' '}
            {ago(end.at)} · worker {end.worker_kind}
          </div>
          <div>
            Versions read: <SkillList skills={shown.capture.contexts.flatMap((context) => context.skills_read)} none="none" />
          </div>
          <div>Fields changed: {end.field_changes.length > 0 ? end.field_changes.join(', ') : 'none'}</div>
          <div>Referenced commits: {end.commits.length}</div>
        </Panel>
      ) : null}

      <CapturePanel shown={shown} />
      <Sessions shown={shown} reload={reload} />
      <KnowledgeUse shown={shown} />
      {end ? <Actions shown={shown} reload={reload} /> : null}
    </div>
  );
}

function SkillList({ skills, none }: { skills: readonly unknown[] | null; none: string }) {
  if (!skills || skills.length === 0) return <span class="mute">{none}</span>;
  return (
    <span class="skill-list">
      {skills.map((skill, k) => {
        const s = (skill ?? {}) as Record<string, unknown>;
        const version = str(s.version);
        return (
          <code key={k} class="skill-version">
            {str(s.name) ?? '?'}@{version === null ? 'unknown' : version.slice(0, 12)}
          </code>
        );
      })}
    </span>
  );
}

function OutcomePanel({ shown, reload }: { shown: AttemptShowResult; reload: () => Promise<void> }) {
  const outcome = shown.outcome;
  const earlier = shown.outcome_history.slice(0, -1);
  return (
    <Panel title="Outcome" cls="outcome-panel">
      {outcome ? (
        <>
          <div class="row">
            <OutcomeChip outcome={outcome} />
            <span class="mute outcome-why">
              {outcome.reason} · {setBy(outcome)} · {ago(outcome.at)}
            </span>
          </div>
          {earlier.length > 0 ? (
            <div class="small mute outcome-history">
              Earlier: {earlier.map((h) => `${h.verdict} (${setBy(h)}, ${h.reason}, ${ago(h.at)})`).join(' → ')}
            </div>
          ) : null}
          <div class="row">
            <button type="button" class="override" onClick={() => overrideOutcome(shown, reload)}>
              Override… 🔒
            </button>
            <LockTag />
          </div>
        </>
      ) : (
        <span class="mute">Set when the attempt ends.</span>
      )}
    </Panel>
  );
}

function overrideOutcome(shown: AttemptShowResult, reload: () => Promise<void>) {
  const current = shown.outcome!;
  openDialog({
    title: `Override the outcome of ${shown.attempt}`,
    humanOnly: true,
    ok: 'Override',
    body: (
      <>
        <p>
          Now: <b>{current.verdict}</b> <span class="mute">{current.reason}</span>
        </p>
        <div class="row">
          {['pass', 'fail', 'none'].map((verdict) => (
            <label key={verdict} class="row">
              <input type="radio" name="verdict" value={verdict} defaultChecked={verdict === current.verdict} /> {verdict}
            </label>
          ))}
        </div>
        <label class="field">
          Reason (required, kept with the outcome)
          <textarea name="reason" rows={2} />
        </label>
        <p class="mute small">A human verdict beats every rule. Outcomes feed the knowledge loop and the skill scorecards; the trace itself never changes.</p>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: an override needs one.' : null),
    run: async (values) => {
      await write('outcome_set', { attempt: shown.attempt, verdict: values.verdict ?? current.verdict, reason: values.reason!.trim() });
      toast(`Outcome of ${shown.attempt} set to ${values.verdict}.`);
      await reload();
    },
  });
}

/** A commit fact's flags: an agent's edit of the generated skill copies, or an agent co-author in a human attempt. */
function commitFlags(commit: Readonly<Record<string, unknown>>): string[] {
  const flags: string[] = [];
  if (commit.agent_skill_edit === true) flags.push('agent skill edit');
  if (commit.agent_assisted === true) flags.push('agent-assisted');
  return flags;
}

function CapturePanel({ shown }: { shown: AttemptShowResult }) {
  const { contexts, facts_complete: complete, wiki_exposed: wiki, commits } = shown.capture;
  return (
    <Panel title="Capture status" cls="capture-status">
      <div class="facts-complete">
        facts_complete: <b>{complete ? 'true' : 'false'}</b>
        {complete ? null : <span class="mute small"> · scorecards read this attempt as “read unknown”</span>}
      </div>
      <table class="contexts">
        <thead>
          <tr>
            <th>Client</th>
            <th>Session</th>
            <th>Context</th>
            <th>Excerpt</th>
            <th>Facts</th>
          </tr>
        </thead>
        <tbody>
          {contexts.length === 0 ? (
            <tr>
              <td colSpan={5} class="mute">
                {shown.end ? 'No bound context left a session record.' : 'No session records yet: they are cut when the attempt ends, or swept while idle.'}
              </td>
            </tr>
          ) : null}
          {contexts.map((context) => (
            <tr key={context.key} class="context-row">
              <td>
                {context.client}
                {context.client_version ? <span class="mute small"> {context.client_version}</span> : null}
              </td>
              <td class="mono small">{context.session ?? '—'}</td>
              <td class="mono small">{context.context ?? '—'}</td>
              <td>
                <span class="chip excerpt-status">{context.excerpt.status}</span>
                {context.excerpt.notes.map((note) => (
                  <span key={note} class="chip small-chip">
                    {note}
                  </span>
                ))}
              </td>
              <td>
                <span class="chip facts-status">{context.facts}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="wiki-basis">
        Wiki-exposed: <b>{wiki.exposed ? 'yes' : 'no'}</b> <span class="mute small">· at the claim: {wiki.at_start ? 'yes' : 'no'} · at the seal (the OR of binding writes): {wiki.at_end === null ? 'not sealed yet' : wiki.at_end ? 'yes' : 'no'}</span>
        {wiki.hits.map((hit) => (
          <div key={hit.commit} class="small exposure-hit">
            {hit.op} · basis <b>{hit.basis}</b>
            {hit.client ? ` · ${hit.client}` : ''}
            {hit.session ? ` · ${hit.session}` : ''} · {ago(hit.at)}
          </div>
        ))}
      </div>
      <h3>Commits</h3>
      {commits.length === 0 ? <div class="mute">None.</div> : null}
      {commits.map((commit, k) => (
        <div key={k} class="commit-row small">
          <code>{(str(commit.hash) ?? '').slice(0, 12)}</code> <span class="chip commit-via">via {str(commit.via) ?? '?'}</span> {str(commit.subject) ?? ''}
          {commitFlags(commit).map((flag) => (
            <span key={flag} class="chip warn commit-flag">
              {flag}
            </span>
          ))}
          {typeof commit.added === 'number' ? (
            <span class="mute">
              {' '}
              +{commit.added} −{String(commit.removed ?? 0)}
            </span>
          ) : null}
        </div>
      ))}
    </Panel>
  );
}

function Sessions({ shown, reload }: { shown: AttemptShowResult; reload: () => Promise<void> }) {
  const open = shown.state === 'open';
  return (
    <section class="sessions">
      <h3>Sessions ({shown.capture.contexts.length})</h3>
      {shown.capture.contexts.length === 0 ? <p class="mute">No session records.</p> : null}
      {shown.capture.contexts.map((context) => (
        <div key={context.key} class="panel pad session">
          <div class="row between">
            <span>
              {context.client} · session <code>{context.session ?? 'unknown'}</code> · context <code>{context.context ?? 'unknown'}</code> · excerpt{' '}
              {context.counts.characters.toLocaleString()} chars, {context.counts.kept} of {context.counts.steps} steps
            </span>
            {open && context.facts !== 'purged' ? (
              <button type="button" class="danger purge-session" onClick={() => purgeSession(shown, context, reload)}>
                Purge this session record… 🔒
              </button>
            ) : null}
          </div>
          {context.purge ? (
            <div class="small mute">
              Purged ({context.purge.facts === 'kept' ? 'the excerpt alone; the facts stay' : 'with its facts'}) by {context.purge.by} {ago(context.purge.at)}: {context.purge.reason}
            </div>
          ) : null}
          {context.text !== null ? (
            <details class="excerpt">
              <summary>Excerpt (inert text, redacted when cut)</summary>
              <pre class="src excerpt-text">{context.text}</pre>
            </details>
          ) : (
            <div class="small mute">No excerpt kept ({context.excerpt.status}).</div>
          )}
        </div>
      ))}
    </section>
  );
}

function purgeSession(shown: AttemptShowResult, context: ShownContext, reload: () => Promise<void>) {
  openDialog({
    title: 'Purge one session record',
    humanOnly: true,
    danger: true,
    ok: 'Purge session record',
    typed: shown.attempt,
    body: (
      <>
        <p>
          Removes the record of {context.client} session <code>{context.session ?? 'unknown'}</code> (context <code>{context.context ?? 'unknown'}</code>) from{' '}
          {shown.attempt}. A tombstone stays, and later cuts skip that context. The rest of the attempt stays.
        </p>
        <fieldset class="purge-scope">
          <legend>What goes</legend>
          <label class="row">
            <input type="radio" name="scope" value="excerpt" defaultChecked={context.facts !== 'purged'} /> The excerpt alone (its facts stay on the tombstone)
          </label>
          <label class="row">
            <input type="radio" name="scope" value="facts" /> The excerpt with its facts
          </label>
        </fieldset>
        <p class="banner warn">Unpushed tracker commits are rewritten without it. Pushed git history still keeps it: grimoire never rewrites pushed history.</p>
        <label class="field">
          Reason (required, kept in the tombstone)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a purge needs one.' : null),
    run: async (values) => {
      const result = await write<{ history: { note: string } }>('purge_session', {
        attempt: shown.attempt,
        key: context.key,
        reason: values.reason!.trim(),
        ...(values.scope === 'facts' ? { with_facts: true } : {}),
      });
      toast(`Purged the session record. ${result.history.note}`);
      await reload();
    },
  });
}

function KnowledgeUse({ shown }: { shown: AttemptShowResult }) {
  const { pages, proposals } = shown.knowledge;
  return (
    <section class="knowledge-use">
      <h3>Used by the knowledge layer</h3>
      <div class="small">
        Pattern pages citing it:{' '}
        {pages.length === 0
          ? 'none'
          : pages.map((page, k) => (
              <span key={page.slug}>
                {k > 0 ? ', ' : ''}
                <a href={`/knowledge/wiki/${page.slug}`}>{page.slug}</a> <span class="mute">({page.kind})</span>
              </span>
            ))}{' '}
        · Proposals citing it:{' '}
        {proposals.length === 0
          ? 'none'
          : proposals.map((proposal, k) => (
              <span key={proposal.id}>
                {k > 0 ? ', ' : ''}
                <code>{proposal.id}</code> <span class="mute">({proposal.action} {proposal.skill})</span>
              </span>
            ))}
      </div>
    </section>
  );
}

function Actions({ shown, reload }: { shown: AttemptShowResult; reload: () => Promise<void> }) {
  return (
    <section class="attempt-actions">
      <h3>Actions</h3>
      <div class="row">
        {shown.quarantine ? (
          <button type="button" class="unquarantine" onClick={() => liftQuarantine(shown, reload)}>
            Lift quarantine… 🔒
          </button>
        ) : (
          <button type="button" class="quarantine" onClick={() => quarantineTrace(shown, reload)}>
            Quarantine… 🔒
          </button>
        )}
        <button type="button" class="danger purge-trace" onClick={() => purgeTrace(shown, reload)}>
          Purge trace… 🔒
        </button>
        <LockTag />
      </div>
    </section>
  );
}

function quarantineTrace(shown: AttemptShowResult, reload: () => Promise<void>) {
  openDialog({
    title: `Quarantine trace ${shown.attempt}`,
    humanOnly: true,
    ok: 'Quarantine',
    body: (
      <>
        <p>Keeps this trace out of knowledge chores and out of any skill proposal’s evidence. Nothing is purged and the wiki is not rolled back.</p>
        <label class="field">
          Reason (required)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a quarantine needs one.' : null),
    run: async (values) => {
      await write('quarantine', { trace: shown.attempt, reason: values.reason!.trim() });
      toast(`Quarantined ${shown.attempt}.`);
      await reload();
    },
  });
}

function liftQuarantine(shown: AttemptShowResult, reload: () => Promise<void>) {
  openDialog({
    title: `Lift the quarantine on ${shown.attempt}`,
    humanOnly: true,
    ok: 'Lift quarantine',
    body: (
      <>
        <p>The trace counts as evidence again and is served to knowledge chores.</p>
        <label class="field">
          Reason (optional)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    run: async (values) => {
      await write('unquarantine', { trace: shown.attempt, ...((values.reason ?? '').trim() ? { reason: values.reason!.trim() } : {}) });
      toast(`Lifted the quarantine on ${shown.attempt}.`);
      await reload();
    },
  });
}

function purgeTrace(shown: AttemptShowResult, reload: () => Promise<void>) {
  const { pages, proposals } = shown.knowledge;
  openDialog({
    title: `Purge trace ${shown.attempt}?`,
    humanOnly: true,
    danger: true,
    ok: 'Purge trace',
    typed: shown.attempt,
    body: (
      <>
        <p>
          Removes the trace and its outcome from the tracker’s tip in one commit, and leaves a tombstone that wins every later fold. Unpushed tracker commits are
          rewritten without it.
        </p>
        <p class="banner warn purge-history">Pushed git history still keeps it: grimoire never rewrites pushed history, so the remote and every clone that fetched it keep the content.</p>
        {pages.length > 0 || proposals.length > 0 ? (
          <div class="banner warn purge-citing">
            Cited by {pages.length > 0 ? `pattern pages ${pages.map((page) => page.slug).join(', ')}` : ''}
            {pages.length > 0 && proposals.length > 0 ? ' and ' : ''}
            {proposals.length > 0 ? `proposals ${proposals.map((proposal) => proposal.id).join(', ')}` : ''}. They stay as written and show this source as purged.
          </div>
        ) : (
          <p class="mute small purge-citing">No pattern page or proposal cites it.</p>
        )}
        <label class="field">
          Reason (required, kept in the tombstone)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a purge needs one.' : null),
    run: async (values) => {
      const result = await write<{ history: { note: string } }>('purge_trace', { attempt: shown.attempt, reason: values.reason!.trim() });
      toast(`Purged ${shown.attempt}. ${result.history.note}`);
      await reload();
    },
  });
}
