// The proposal screen (spec §20 Knowledge, Proposal screen; §18 Review and
// decisions), from the core's `proposal_show`, in this order:
//
//  1. a sticky decision bar: each red flag to acknowledge (the live evidence
//     flag included), then 🔒 Accept and Accept-then-edit (disabled until
//     every red flag is acknowledged), Reject (a reason code; `suspicious`
//     offers quarantine, checked by default), Dismiss, Reconsider, Purge
//     (the typed id);
//  2. grimoire's checks and the risk flags, with token origins;
//  3. the description diff; 4. the body diff;
//  5. the cited traces: outcome at drafting and now, wiki-exposed, quarantined
//     and purged markers, the versions read;
//  6. the cited pages, with changed-since markers;
//  7. the scorecard (patches); 8. the ledger history;
//  9. the full result, collapsed; 10. the LLM rationale, labelled unverified.
//
// The decided-history table sits below. Proposals, diffs and skill text render
// as source text, never markup.
import { useState } from 'preact/hooks';
import { read, write } from './api';
import { ago, duration, short } from './format';
import { useKnowledgeRead } from './knowledge';
import { navigate } from './router';
import { ScorecardTable } from './skills';
import type { ProposalListResult, ProposalShowResult } from './types';
import { LockTag, openDialog, SourceDiff, toast, Version } from './ui';

/** The reject reason codes (spec §18), as `proposal_reject` takes them. */
const REJECT_REASONS = [
  'incorrect',
  'too-vague',
  'one-off',
  'duplicates-existing-guidance',
  'contradicts-instructions',
  'trigger-too-broad',
  'too-long',
  'suspicious',
  'not-worth-it',
  'other',
] as const;

const STATUS_TONES: Readonly<Record<string, string>> = { pending: 'acc', accepted: 'ok', rejected: 'bad', lapsed: 'warn', stale: 'warn', dismissed: '', undone: 'warn', contested: 'bad', superseded: '' };

/** The proposal `id`, or with none the oldest pending one (else the decided history alone). */
export function ProposalScreen({ id }: { id: string | null }) {
  const list = useKnowledgeRead(() => read<ProposalListResult>('proposal_list'));
  const shownId = id ?? list.value?.pending[0] ?? null;
  const shown = useKnowledgeRead(async () => (shownId === null ? null : read<ProposalShowResult>('proposal_show', { id: shownId })), [shownId]);
  const reload = async () => {
    await Promise.all([list.reload(), shown.reload()]);
  };
  const p = shown.value;
  return (
    <div class="knowledge proposal-screen">
      {shownId === null ? (
        <>
          <h1>Skill proposals</h1>
          <p class="mute no-pending">{list.value ? 'Nothing pending.' : (list.error ?? 'Loading…')}</p>
        </>
      ) : p ? (
        <Proposal p={p} pendingCount={list.value?.pending.length ?? 0} pendingLimit={list.value?.pending_limit ?? 1} reload={reload} />
      ) : (
        <p class="mute">{shown.error ?? 'Loading…'}</p>
      )}
      {list.value ? <DecidedHistory list={list.value} reload={reload} /> : null}
    </div>
  );
}

function Proposal({ p, pendingCount, pendingLimit, reload }: { p: ProposalShowResult; pendingCount: number; pendingLimit: number; reload: () => Promise<void> }) {
  return (
    <>
      <div class="row between">
        <div>
          <div class="small mute">
            Skill proposal · drafted {ago(p.at)}
            {p.age_hours !== null ? ` · ${p.decision ? 'decided after' : 'waiting'} ${duration(p.age_hours * 3_600_000)}` : ''}
          </div>
          <h1>
            {p.action} <span class="mono">{p.skill}</span> <span class="id">{p.id}</span>
          </h1>
        </div>
        <span class={`chip proposal-status ${STATUS_TONES[p.status] ?? ''}`}>
          {p.status}
          {p.status === 'pending' ? ` · ${pendingCount} of ${pendingLimit} pending` : ''}
        </span>
      </div>
      <DecisionBar key={`${p.id}:${p.status}:${p.red_flags.map((f) => f.flag).join(',')}`} p={p} reload={reload} />

      <h3>Grimoire’s checks</h3>
      <div class="grid2">
        <div class="panel pad small checks">
          {p.checks === null ? (
            <div class="mute">Checks run again only while a proposal is pending.</div>
          ) : p.checks.passed ? (
            <div class="row check-row">
              <span class="chip ok">✓</span>The checks pass again as at accept.
            </div>
          ) : (
            p.checks.reasons.map((reason) => (
              <div key={reason} class="row check-row check-failed">
                <span class="chip bad">✗</span>
                <code>{reason}</code>
              </div>
            ))
          )}
          {p.checks && !p.checks.passed && Object.keys(p.checks.problems).length > 0 ? (
            <div class="problems">
              {Object.entries(p.checks.problems).map(([field, problem]) => (
                <div key={field} class="small">
                  <code>{field}</code>: {problem}
                </div>
              ))}
            </div>
          ) : null}
          <div class={`row evidence-row ${p.evidence.meets ? '' : 'evidence-short'}`}>
            <span class={`chip ${p.evidence.meets ? 'ok' : 'bad'}`}>{p.evidence.meets ? '✓' : '✗'}</span>
            Evidence now: {p.evidence.traces} traces from {p.evidence.issues} issues, {p.evidence.fails} failing, {p.evidence.pages} pages
            {p.evidence.meets ? ' (meets the minimum)' : ' (below the minimum)'}
          </div>
        </div>
        <div class="panel pad small risk-flags">
          <div class="b">Risk flags</div>
          {p.red_flags.filter((flag) => flag.live).map((flag) => (
            <div key={flag.flag} class="flag red live-flag">
              <b>red · now</b> <span>{flag.detail}</span>
            </div>
          ))}
          {p.risk_flags.map((flag) => (
            <div key={flag.flag} class={`flag ${flag.severity}`}>
              <b>{flag.severity}</b> <code>{flag.flag}</code> <span>{flag.detail}</span>
            </div>
          ))}
          {p.risk_flags.length === 0 && p.red_flags.length === 0 ? <div class="mute">None.</div> : null}
          {p.tokens.length > 0 ? (
            <>
              <div class="b token-head">Token origin</div>
              {p.tokens.map((token) => (
                <div key={token.token} class={`flag ${token.origin} token`}>
                  <b>{token.origin}</b> <code>{token.token}</code> <span class="mute">
                    {token.kind}, found in {token.found}
                  </span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>

      <h3>Description change (shown first: it decides when agents load the skill)</h3>
      <SourceDiff lines={p.description_diff} />
      <h3>Body change</h3>
      <SourceDiff lines={p.body_diff} context={3} />

      <h3>Cited traces</h3>
      <div class="panel">
        <table class="cited-traces">
          <thead>
            <tr>
              <th>Trace</th>
              <th>Issue</th>
              <th>Outcome at drafting → now</th>
              <th>Markers</th>
              <th>{p.skill} versions read</th>
            </tr>
          </thead>
          <tbody>
            {p.traces.map((t) => (
              <tr key={t.trace} class="cited-trace" data-trace={t.trace}>
                <td>{t.purged ? <span class="id">{t.trace}</span> : <a href={`/attempts/${t.trace}`} class="id">{t.trace}</a>}</td>
                <td>
                  <a href={`/issues/${t.issue}`}>{t.issue}</a>
                </td>
                <td class="outcomes">
                  {t.outcome_at_drafting}
                  {t.outcome_now !== t.outcome_at_drafting ? (
                    <>
                      {' '}
                      → <b>{t.outcome_now ?? 'gone'}</b> <span class="chip warn">changed</span>
                    </>
                  ) : null}
                </td>
                <td class="markers">
                  {t.wiki_exposed ? <span class="chip warn">wiki-exposed</span> : null}
                  {t.quarantined ? <span class="chip warn">quarantined</span> : null}
                  {t.purged ? <span class="chip bad purged">purged</span> : null}
                  {!t.counts ? <span class="chip">not counted</span> : null}
                </td>
                <td class="small">{t.versions_read.length === 0 ? <span class="mute">none</span> : t.versions_read.map((v, k) => <span key={k}>{k > 0 ? ' ' : ''}{v === null ? 'unknown' : <Version id={v} />}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Cited pages</h3>
      <div class="panel pad small cited-pages">
        {p.pages.length === 0 ? <span class="mute">None.</span> : null}
        {p.pages.map((page) => (
          <div key={page.slug} class="cited-page">
            {page.gone ? <span>{page.slug}</span> : <a href={`/knowledge/wiki/${page.slug}`}>{page.slug}</a>}{' '}
            {page.gone ? <span class="chip bad">gone</span> : page.changed_since === null ? <span class="chip">can’t tell</span> : page.changed_since ? <span class="chip warn">changed since drafting</span> : <span class="chip">unchanged</span>}
            {page.quarantined ? <span class="chip warn">quarantined</span> : null}
          </div>
        ))}
      </div>

      {p.action === 'patch' ? (
        <>
          <h3>Scorecard of {p.skill} at its base (watch-only)</h3>
          {p.scorecard ? <ScorecardTable cards={[p.scorecard]} current={p.base} /> : <p class="mute">No scorecard for the base version.</p>}
        </>
      ) : null}

      <h3>Ledger history for {p.skill}</h3>
      <div class="panel pad small ledger">
        {p.ledger.length === 0 ? <span class="mute">No history: this name is new.</span> : null}
        {p.ledger.map((record) => (
          <div key={record.record} class="ledger-row">
            {ago(record.at)} · {record.kind}
            {record.proposal ? ` (${record.proposal})` : ''} {record.from ? <Version id={record.from} /> : null}
            {record.to && record.to !== record.from ? (
              <>
                {' '}
                → <Version id={record.to} />
              </>
            ) : null}{' '}
            · {short(record.by)}
            {record.reason ? <span class="mute"> · {record.reason}</span> : null}
          </div>
        ))}
      </div>

      <h3>Full result</h3>
      <details class="full-result">
        <summary>SKILL.md as proposed (inert text)</summary>
        <pre class="src result-text">{p.result.text}</pre>
        {p.result.ops.length > 0 ? <pre class="src result-ops">{JSON.stringify(p.result.ops, null, 2)}</pre> : null}
      </details>

      <h3>The drafting agent’s rationale: unverified</h3>
      <div class="unverified rationale">
        {p.claims.rationale ? <pre class="src">{p.claims.rationale}</pre> : null}
        {(p.claims.failures ?? []).map((failure) => (
          <div key={failure.trace} class="small">
            <code>{failure.trace}</code>: {failure.line}
          </div>
        ))}
        {p.claims.expected_signal ? <div class="small">Expected signal: {p.claims.expected_signal}</div> : null}
        {p.claims.provenance ? <div class="small">Provenance: {p.claims.provenance}</div> : null}
        <div class="small mute">
          Reported by {p.claims.client ?? 'an unnamed client'}
          {p.claims.model ? ` · ${p.claims.model}` : ''} (unverified)
        </div>
      </div>
    </>
  );
}

/** The sticky decision bar: every red flag must be acknowledged before Accept enables. */
function DecisionBar({ p, reload }: { p: ProposalShowResult; reload: () => Promise<void> }) {
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const pending = p.status === 'pending';
  const missing = p.red_flags.filter((flag) => !acked.has(flag.flag));
  const blocked = missing.length > 0;
  return (
    <div class="decbar">
      {pending ? (
        <div class="stack red-flags">
          {p.red_flags.length === 0 ? <span class="small mute">No red flags.</span> : null}
          {p.red_flags.map((flag) => (
            <label key={flag.flag} class="row small red-flag">
              <input
                type="checkbox"
                name="ack"
                value={flag.flag}
                checked={acked.has(flag.flag)}
                onChange={(event) => {
                  const next = new Set(acked);
                  if ((event.target as HTMLInputElement).checked) next.add(flag.flag);
                  else next.delete(flag.flag);
                  setAcked(next);
                }}
              />
              I have read the red flag{flag.live ? ' (computed now)' : ''}: {flag.detail}
            </label>
          ))}
        </div>
      ) : p.decision ? (
        <div class="small decided">
          {p.decision.kind} by {short(p.decision.by)} {ago(p.decision.at)}
          {p.decision.reason ? ` · ${p.decision.reason}` : ''}
          {p.decision.note ? ` · ${p.decision.note}` : ''}
          {p.decision.acks && p.decision.acks.length > 0 ? <span class="acks"> · acknowledged {p.decision.acks.join(', ')}</span> : null}
        </div>
      ) : (
        <div class="small mute">{p.status}{p.since ? ` since ${ago(p.since)}` : ''}</div>
      )}
      <div class="row wrap actions">
        {pending ? (
          <>
            <button type="button" class="pri accept" disabled={blocked} title={blocked ? 'Acknowledge each red flag first' : undefined} onClick={() => accept(p, [...acked], false, reload)}>
              Accept 🔒
            </button>
            <button type="button" class="accept-edit" disabled={blocked} title={blocked ? 'Acknowledge each red flag first' : undefined} onClick={() => accept(p, [...acked], true, reload)}>
              Accept, then edit 🔒
            </button>
            <button type="button" class="danger reject" onClick={() => reject(p, reload)}>
              Reject… 🔒
            </button>
            <button type="button" class="dismiss" onClick={() => decide(p, 'dismiss', reload)}>
              Dismiss… 🔒
            </button>
          </>
        ) : null}
        {p.status === 'dismissed' ? (
          <button type="button" class="reconsider" onClick={() => decide(p, 'reconsider', reload)}>
            Reconsider… 🔒
          </button>
        ) : null}
        <button type="button" class="danger purge-proposal" onClick={() => purge(p.id)}>
          Purge… 🔒
        </button>
        <LockTag />
      </div>
    </div>
  );
}

function accept(p: ProposalShowResult, ack: string[], thenEdit: boolean, reload: () => Promise<void>) {
  openDialog({
    title: `Accept ${p.id}?`,
    humanOnly: true,
    ok: thenEdit ? 'Accept, then edit' : 'Accept',
    body: (
      <>
        <p>
          Makes the proposed text the current version of <b>{p.skill}</b>, served to every agent on the next refresh. The checks run again first: if they fail now, it
          lapses and nothing is accepted.
        </p>
        {ack.length > 0 ? <p class="small acked">Acknowledging: {ack.join(', ')}</p> : null}
      </>
    ),
    run: async () => {
      const result = await write<{ status: string; reasons?: string[]; edit?: string; version?: string }>('proposal_accept', { id: p.id, ack, ...(thenEdit ? { then_edit: true } : {}) });
      await reload();
      if (result.status === 'lapsed') {
        toast(`${p.id} lapsed: ${(result.reasons ?? []).join(', ')}. Nothing was accepted, and the slot is free.`);
        return;
      }
      toast(`Accepted ${p.id}: ${p.skill} is now ${result.version?.slice(0, 10) ?? 'updated'}.`);
      if (thenEdit && result.edit) {
        setTimeout(
          () =>
            openDialog({
              title: `Edit ${p.skill}`,
              ok: 'OK',
              notice: true,
              body: (
                <>
                  <p>Skill text is edited in a terminal (the dashboard doesn’t edit it). Run:</p>
                  <pre class="command edit-command">{result.edit}</pre>
                </>
              ),
            }),
          0,
        );
      }
    },
  });
}

/** The reject form: a reason code; `other` needs words; `suspicious` offers quarantine of what it cites, checked by default. */
function RejectFields() {
  const [reason, setReason] = useState<string>('incorrect');
  const [quarantine, setQuarantine] = useState(true);
  return (
    <>
      <label class="field">
        Reason
        <select name="reason" value={reason} onChange={(event) => setReason((event.target as HTMLSelectElement).value)}>
          {REJECT_REASONS.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </label>
      {reason === 'suspicious' ? (
        <label class="row small">
          <input type="checkbox" name="quarantine" value="yes" checked={quarantine} onChange={(event) => setQuarantine((event.target as HTMLInputElement).checked)} /> Quarantine
          the cited traces and pages too
        </label>
      ) : null}
      <label class="field">
        {reason === 'other' ? 'In your words (required)' : 'Note (optional, with other only)'}
        <textarea name="text" rows={2} disabled={reason !== 'other'} />
      </label>
    </>
  );
}

function reject(p: ProposalShowResult, reload: () => Promise<void>) {
  openDialog({
    title: `Reject ${p.id}?`,
    humanOnly: true,
    danger: true,
    ok: 'Reject',
    body: (
      <>
        <p>
          Records the rejection in the skill ledger. The next Skill Proposer run reads it{' '}
          {p.action === 'create' ? '' : `(with ${p.skill}'s other rejections)`} so the same change isn’t proposed again.
        </p>
        <RejectFields />
      </>
    ),
    validate: (values) => (values.reason === 'other' && (values.text ?? '').trim() === '' ? 'Say why: a reject with other needs a reason in your words.' : null),
    run: async (values) => {
      const input: Record<string, unknown> = { id: p.id, reason: values.reason };
      if (values.reason === 'other') input.text = values.text!.trim();
      if (values.reason === 'suspicious') input.quarantine = values.quarantine === 'yes';
      await write('proposal_reject', input);
      toast(`Rejected ${p.id} (${values.reason}).`);
      await reload();
    },
  });
}

function decide(p: { id: string }, verb: 'dismiss' | 'reconsider', reload: () => Promise<void>) {
  openDialog({
    title: verb === 'dismiss' ? `Dismiss ${p.id}?` : `Reconsider ${p.id}?`,
    humanOnly: true,
    ok: verb === 'dismiss' ? 'Dismiss' : 'Reconsider',
    body:
      verb === 'dismiss' ? (
        <p>Sets it aside without a verdict: it frees the pending slot, and Reconsider brings it back while the slot is free.</p>
      ) : (
        <p>Brings the dismissed proposal back to pending (it needs the pending slot free).</p>
      ),
    run: async () => {
      await write(verb === 'dismiss' ? 'proposal_dismiss' : 'proposal_reconsider', { id: p.id });
      toast(verb === 'dismiss' ? `Dismissed ${p.id}.` : `${p.id} is pending again.`);
      await reload();
    },
  });
}

function purge(id: string) {
  openDialog({
    title: `Purge ${id}?`,
    humanOnly: true,
    danger: true,
    ok: 'Purge proposal',
    typed: id,
    body: (
      <>
        <p>Removes the proposal’s record from the tracker’s tip and leaves a tombstone. Decisions already recorded stay in the skill ledger.</p>
        <p class="banner warn purge-history">Pushed git history still keeps it: grimoire never rewrites pushed history.</p>
        <label class="field">
          Reason (required, kept in the tombstone)
          <textarea name="reason" rows={2} />
        </label>
      </>
    ),
    validate: (values) => ((values.reason ?? '').trim() === '' ? 'Give a reason: a purge needs one.' : null),
    run: async (values) => {
      await write('proposal_purge', { id, reason: values.reason!.trim() });
      toast(`Purged ${id}.`);
      navigate('/knowledge/proposals');
    },
  });
}

function DecidedHistory({ list, reload }: { list: ProposalListResult; reload: () => Promise<void> }) {
  const decided = list.proposals.filter((row) => row.status !== 'pending').sort((x, y) => ((x.decided_at ?? x.at) < (y.decided_at ?? y.at) ? 1 : -1));
  return (
    <>
      <h3>Decided proposals</h3>
      <div class="mute small history-rate">
        Accept rate {list.history.accept_rate === null ? '—' : `${Math.round(list.history.accept_rate * 100)}%`} (baseline {Math.round(list.history.baseline * 100)}%) · median
        time to decision {list.history.median_hours_to_decision === null ? '—' : duration(list.history.median_hours_to_decision * 3_600_000)}
      </div>
      <div class="panel">
        <table class="decided-history">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Skill</th>
              <th>Status</th>
              <th>Drafted</th>
              <th>Time to decide</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {decided.length === 0 ? (
              <tr>
                <td colSpan={6} class="mute">
                  None yet.
                </td>
              </tr>
            ) : null}
            {decided.map((row) => (
              <tr key={row.id} class="decided-row">
                <td>
                  <a href={`/knowledge/proposals/${row.id}`} class="id">
                    {row.id}
                  </a>
                </td>
                <td>
                  {row.action} {row.skill}
                </td>
                <td>
                  <span class={`chip ${STATUS_TONES[row.status] ?? ''}`}>{row.status}</span>
                </td>
                <td class="small mute">{ago(row.at)}</td>
                <td class="small">{row.decided_at && row.age_hours !== null ? duration(row.age_hours * 3_600_000) : '—'}</td>
                <td>
                  {row.status === 'dismissed' ? (
                    <button type="button" class="reconsider" onClick={() => decide(row, 'reconsider', reload)}>
                      Reconsider… 🔒
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
