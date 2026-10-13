// The Knowledge section (spec §20 Knowledge): what the knowledge layer
// produced, for the reviewer and the person at the machine. Every view reads
// the live store through the core's ops (`knowledge_overview`,
// `proposal_list`/`proposal_show`, `skill_show`, `wiki_list`/`wiki_show`,
// `chore_runs`), never a checkout, and refetches in place on a live update.
//
// - Overview: the tiles (the loop and delivery switches behind the scope
//   dialog, the pending proposal and its age, the backlog, the last compile,
//   the cap n / 8), what is due or why not (nothing here starts a chore), the
//   state counts, this machine's runner card (status only), pickup, the recent
//   decisions with the accept rate and median time, the set-aside pairs with
//   Quarantine and Purge, and the recent chore runs.
// - Chore runs: kind, origin · isolation, outcome with reason codes, pages or
//   proposal touched, when. A refused result's text is viewable only on the
//   machine that keeps it, and never after a secret-scan failure.
// - Proposal, Skills and Wiki have their own modules.
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { read, runner as readRunner, write } from './api';
import { useLiveRefetch } from './data';
import { ago, duration, short } from './format';
import { ProposalScreen } from './proposal';
import { changeStoreSetting, RunnerPanel } from './settings';
import { SkillsScreen } from './skills';
import { purgeTraceByHandle, quarantineDialog } from './trace-actions';
import type { ChoreRunRow, ChoreRunsResult, KnowledgeOverviewResult, RunnerInfo, SetAsidePair } from './types';
import { errorText, openDialog, toast } from './ui';
import { WikiScreen } from './wiki';

export const KNOWLEDGE_VIEWS = [
  ['/knowledge', 'Overview'],
  ['/knowledge/proposals', 'Proposal'],
  ['/knowledge/skills', 'Skills'],
  ['/knowledge/wiki', 'Wiki'],
  ['/knowledge/runs', 'Chore runs'],
] as const;

/** The Knowledge view a path shows, by its second segment. */
export function KnowledgeScreen({ path }: { path: string }) {
  const [, , view, rest] = path.split('/').map((part) => decodeURIComponent(part));
  switch (view) {
    case 'proposals':
      return <ProposalScreen key={rest ?? ''} id={rest ?? null} />;
    case 'skills':
      return <SkillsScreen key={rest ?? ''} name={rest ?? null} />;
    case 'wiki':
      return <WikiScreen slug={rest ?? null} />;
    case 'runs':
      return <ChoreRunsScreen />;
    default:
      return <OverviewScreen />;
  }
}

/** Whether a live change could alter what a knowledge view shows. */
export const knowledgeChanged = (change: { knowledge: boolean; machine: boolean; settings: boolean; attempts: readonly string[] }) =>
  change.knowledge || change.machine || change.settings || change.attempts.length > 0;

/** Loads `load` now and again on every live update that touches knowledge; keeps showing the last value meanwhile. */
export function useKnowledgeRead<T>(load: () => Promise<T>, deps: readonly unknown[] = []): { value: T | null; error: string | null; reload: () => Promise<void> } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setValue(await load());
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  useLiveRefetch(() => void reload(), knowledgeChanged);
  return { value, error, reload };
}

// ---------- Overview ----------

function Tile({ label, value, sub, cls }: { label: string; value: ComponentChildren; sub?: ComponentChildren; cls: string }) {
  return (
    <div class={`tile ${cls}`}>
      <div class="l">{label}</div>
      <div class="v tile-value">{value}</div>
      {sub ? <div class="l">{sub}</div> : null}
    </div>
  );
}

const rate = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

function OverviewScreen() {
  const { value: o, error, reload } = useKnowledgeRead(() => read<KnowledgeOverviewResult>('knowledge_overview'));
  const runner = useKnowledgeRead(() => readRunner<RunnerInfo>());
  if (!o) return <p class="mute">{error ?? 'Loading…'}</p>;
  const refresh = () => void reload();
  return (
    <div class="knowledge overview">
      <h1>Knowledge</h1>
      {error ? <div class="banner bad">{error}</div> : null}
      <div class="tiles knowledge-tiles">
        <Tile
          cls="tile-loop"
          label="Knowledge loop 🔒"
          value={
            <button type="button" class="link toggle-loop" onClick={() => changeStoreSetting('knowledge.loop', o.loop, o.loop === 'on' ? 'paused' : 'on', refresh)}>
              {o.loop}
            </button>
          }
          sub="switch"
        />
        <Tile
          cls="tile-delivery"
          label="Skill delivery 🔒"
          value={
            <button type="button" class="link toggle-delivery" onClick={() => changeStoreSetting('skills.delivery', o.delivery === 'on', o.delivery !== 'on', refresh)}>
              {o.delivery}
            </button>
          }
          sub="switch"
        />
        <Tile
          cls="tile-pending"
          label="Pending proposal"
          value={o.pending ? <a href={`/knowledge/proposals/${o.pending.id}`}>{`${o.pending_count} · ${duration(o.pending.age_hours * 3_600_000)}`}</a> : '0'}
          sub={`limit ${o.pending_limit}`}
        />
        <Tile cls="tile-backlog" label="Backlog" value={`${o.backlog.pairs} pair${o.backlog.pairs === 1 ? '' : 's'}`} sub={`${o.backlog.fails} fail · ${o.backlog.passes} pass · settled`} />
        <Tile cls="tile-compile" label="Last compile" value={o.last_compile ? ago(o.last_compile.at) : 'never'} sub={o.last_compile?.run ?? ''} />
        <Tile cls={`tile-cap${o.cap.over ? ' over' : ''}`} label="Evolved skills" value={`${o.cap.active} / ${o.cap.max}`} sub={o.cap.over ? 'over the cap' : 'active cap'} />
      </div>
      <div class="grid2">
        <div class="stack">
          <PendingCard overview={o} />
          <div class="panel pad small due-panel">
            <h2>What is due, or why not</h2>
            {o.due.paused ? <div class="banner warn">The knowledge loop is paused: no chore becomes due.</div> : null}
            <div class="due-wiki">
              <b>Wiki Maintainer</b>: {o.due['wiki-maintainer'].due ? 'due' : 'not due'}, {o.due['wiki-maintainer'].why}.
            </div>
            <div class="due-proposer">
              <b>Skill Proposer</b>: {o.due['skill-proposer'].due ? 'due' : 'not due'}, {o.due['skill-proposer'].why}.
            </div>
            <div class="mute">Chores are offered to agents already on this machine, per the pickup setting; nothing here starts one.</div>
          </div>
          <div class="panel pad small state-counts">
            <h2>States</h2>
            <div class="row wrap">
              {(
                [
                  ['stale', o.counts.stale],
                  ['lapsed', o.counts.lapsed],
                  ['contested', o.counts.contested],
                  ['forks', o.counts.forks],
                  ['set-aside', o.counts.set_aside],
                  ['quarantined', o.counts.quarantined],
                ] as const
              ).map(([name, n]) => (
                <span key={name} class={`chip count-${name} ${n > 0 ? 'warn' : ''}`}>
                  {name} · {n}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div class="stack">
          <RunnerPanel runner={runner.value} title="Runner (this machine, status only)" />
          <PickupPanel pickup={o.pickup} onChanged={refresh} />
          <div class="panel pad small decisions">
            <h2>Recent decisions</h2>
            {o.decisions.length === 0 ? <div class="mute">None yet.</div> : null}
            {o.decisions.map((d) => (
              <div key={d.id} class="decision">
                <a href={`/knowledge/proposals/${d.id}`} class="id">
                  {d.id}
                </a>{' '}
                {d.action} {d.skill} · <b>{d.status}</b> by {short(d.by)} · {ago(d.decided_at)}
              </div>
            ))}
            <div class="mute decision-rate">
              Accept rate {rate(o.history.accept_rate)} ({o.history.accepted} of {o.history.accepted + o.history.rejected}; baseline {rate(o.history.baseline)}) · median time to decision{' '}
              {o.history.median_hours_to_decision === null ? '—' : duration(o.history.median_hours_to_decision * 3_600_000)}
            </div>
          </div>
        </div>
      </div>
      <h3>Set-aside pairs</h3>
      <SetAsideList pairs={o.set_aside} reload={reload} />
      <h3>Recent chore runs</h3>
      <ChoreRunTable runs={o.runs} />
      <div class="small">
        <a href="/knowledge/runs">All chore runs →</a>
      </div>
    </div>
  );
}

function PendingCard({ overview: o }: { overview: KnowledgeOverviewResult }) {
  const p = o.pending;
  if (!p) {
    return (
      <div class="panel pad pending-card">
        <h2>Pending proposal</h2>
        <p class="mute">None. The Skill Proposer drafts the next one when its evidence minimum is met.</p>
      </div>
    );
  }
  return (
    <div class="panel pad pending-card">
      <div class="row between">
        <h2>Pending proposal</h2>
        <span class="mute small">{duration(p.age_hours * 3_600_000)} old</span>
      </div>
      <div>
        <b>
          {p.action} {p.skill}
        </b>{' '}
        · <span class="id">{p.id}</span>
      </div>
      <div class="row wrap small">
        <span class={`chip ${p.red_flags > 0 ? 'bad' : 'ok'}`}>
          {p.red_flags} red flag{p.red_flags === 1 ? '' : 's'}
        </span>
        <span class="mute">
          {p.traces} traces · {p.pages} pages
        </span>
      </div>
      <a href={`/knowledge/proposals/${p.id}`} class="button pri review">
        Review
      </a>
    </div>
  );
}

function PickupPanel({ pickup, onChanged }: { pickup: string; onChanged: () => void }) {
  return (
    <div class="panel pad small pickup-panel">
      <div class="row">
        <span>Chore pickup</span>
        <select
          name="pickup"
          value={pickup}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value;
            void write('settings_set', { key: 'knowledge.pickup', value }).then(
              () => {
                toast('Saved on this machine only.');
                onChanged();
              },
              (failure: unknown) => toast(errorText(failure)),
            );
          }}
        >
          {['ask', 'auto', 'manual'].map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
        <span class="mute">this machine</span>
      </div>
      <div class="mute">How the session notice offers a due chore: ask (offer at a pause), auto (run it in the background), manual (the fact only).</div>
    </div>
  );
}

export function SetAsideList({ pairs, reload }: { pairs: readonly SetAsidePair[]; reload: () => Promise<void> | void }) {
  if (pairs.length === 0) return <p class="mute set-aside-none">None.</p>;
  return (
    <div class="panel set-aside">
      {pairs.map((pair) => (
        <div key={pair.pair} class="att set-aside-pair">
          <div class="grow">
            <a href={`/attempts/${pair.trace}`} class="id">
              {pair.trace}
            </a>{' '}
            on <a href={`/issues/${pair.issue}`}>{pair.issue}</a> · outcome {pair.outcome} · seen in {pair.strikes} failed compiles: set aside, never offered again
          </div>
          <div class="row">
            <button type="button" class="quarantine" onClick={() => quarantineDialog({ trace: pair.trace }, reload)}>
              Quarantine… 🔒
            </button>
            <button type="button" class="danger purge-trace" onClick={() => void purgeTraceByHandle(pair.trace, reload)}>
              Purge… 🔒
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Chore runs ----------

const OUTCOME_TONES: Readonly<Record<string, string>> = { compiled: 'ok', proposed: 'acc', failed: 'bad', no_action: '', abandoned: 'warn', expired: 'warn', open: 'info' };
const KIND_NAMES: Readonly<Record<string, string>> = { 'wiki-maintainer': 'Wiki Maintainer', 'skill-proposer': 'Skill Proposer' };

function ChoreRunsScreen() {
  const { value, error } = useKnowledgeRead(() => read<ChoreRunsResult>('chore_runs', { limit: 500 }));
  return (
    <div class="knowledge chore-runs">
      <h1>Chore runs</h1>
      <p class="mute small">
        Knowledge chores are offered to agents already on this machine; the dashboard only shows them. Ended runs come from the tracker (every clone); open, expired and
        abandoned runs only from this machine.
      </p>
      {error ? <div class="banner bad">{error}</div> : null}
      {value ? <ChoreRunTable runs={value.runs} /> : <p class="mute">Loading…</p>}
    </div>
  );
}

export function ChoreRunTable({ runs }: { runs: readonly ChoreRunRow[] }) {
  if (runs.length === 0) return <p class="mute no-runs">No chore runs yet.</p>;
  return (
    <div class="panel">
      <table class="chore-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Kind</th>
            <th>Origin · isolation</th>
            <th>Outcome</th>
            <th>Pages / proposal</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} class="chore-run" data-run={run.id}>
              <td class="id">{run.id}</td>
              <td>{KIND_NAMES[run.kind] ?? run.kind}</td>
              <td class="small origin">
                {run.origin} · {run.isolation}
                {run.unverified.client ? <div class="mute">{`${run.unverified.client}${run.unverified.model ? ` · ${run.unverified.model}` : ''} (unverified)`}</div> : null}
              </td>
              <td class="outcome-cell">
                <span class={`chip outcome ${OUTCOME_TONES[run.outcome] ?? ''}`}>{run.outcome}</span>
                {run.reasons.length > 0 ? <div class="small mono reasons">{run.reasons.join(', ')}</div> : null}
              </td>
              <td class="small touched">
                {run.pages.length > 0
                  ? run.pages.map((slug, k) => (
                      <span key={slug}>
                        {k > 0 ? ', ' : ''}
                        <a href={`/knowledge/wiki/${slug}`}>{slug}</a>
                      </span>
                    ))
                  : run.proposal
                    ? <a href={`/knowledge/proposals/${run.proposal}`}>{run.proposal}</a>
                    : '—'}
                <KeptNote run={run} />
              </td>
              <td class="small mute">{ago(run.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The refused results this machine keeps for a run: their text is viewable here only, and never after a secret-scan failure. */
function KeptNote({ run }: { run: ChoreRunRow }) {
  if (run.kept.length === 0) return null;
  const withText = run.kept.filter((kept) => kept.text_kept);
  const secret = run.kept.filter((kept) => !kept.text_kept);
  return (
    <div class="mute kept">
      {withText.length > 0 ? (
        <div>
          invalid result text kept on this machine ·{' '}
          <button type="button" class="link view-kept" onClick={() => void viewKept(run.id)}>
            view
          </button>
        </div>
      ) : null}
      {secret.length > 0 ? (
        <div class="kept-secret">
          secret-scan failure: no text kept (rules {[...new Set(secret.flatMap((kept) => kept.rules))].join(', ') || 'unknown'})
        </div>
      ) : null}
    </div>
  );
}

async function viewKept(run: string): Promise<void> {
  try {
    const { runs } = await read<ChoreRunsResult>('chore_runs', { run });
    const kept = runs[0]?.kept ?? [];
    openDialog({
      title: `Refused results of ${run}`,
      ok: 'Close',
      notice: true,
      body: (
        <>
          <p class="mute small">Kept on this machine only, never committed. Shown as source text.</p>
          {kept.map((entry) => (
            <div key={entry.n} class="kept-entry">
              <div class="small">
                Refusal {entry.n} · {ago(entry.at)} · {entry.reasons.join(', ')}
              </div>
              {entry.text_kept && typeof entry.text === 'string' ? <pre class="src kept-text">{entry.text}</pre> : <div class="mute">No text kept (a secret-scan failure).</div>}
            </div>
          ))}
        </>
      ),
    });
  } catch (error) {
    toast(errorText(error));
  }
}
