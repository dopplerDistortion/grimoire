// Seam 1: `attempt_show` (spec §20 Attempt page, dashboard read ops; §14
// Statuses; §19 Outcomes; §3 Delete and purge): one attempt as a person audits
// it: the outcome with its history, the start and end facts, the capture
// status of every bound context with its excerpt as text, `facts_complete`,
// the wiki-exposed basis, the commits with `via`, and the pages and proposals
// that cite it. A purged trace shows its tombstone and nothing else.
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { CLAUDE_AGENT, claudeCall, created, DEBRIEF, MAIN_CALL, sessionRecords, SUBAGENT_CALL, test as captureTest } from './capture-support';
import { Clock, codexRoot, CODEX_ROOT_SESSION, putPage, terminal, workPair } from './chore-support';
import { coreTest as test, T0, type Grimoire } from './support';
import { ok } from './sync-support';

const dashboard = (ctx: CallContext): CallContext => ({ ...ctx, surface: 'dashboard', client: null, evidence: {} });

describe('attempt_show', () => {
  captureTest('an ended attempt: start and end facts, each bound context’s statuses and excerpt text, facts_complete, and the outcome with its history', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Show gr-5');
    const { attempt } = await ok(core.call('claim', { id }, claudeCall(grimoire.ctx, MAIN_CALL)));
    capture.at('2026-10-11T03:27:20.300Z');
    await ok(core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT)));
    capture.at('2026-10-11T03:27:30.000Z');
    await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_not_flushed')));
    capture.at('2026-10-11T03:30:00.000Z');
    await ok(core.call('outcome_set', { attempt, verdict: 'fail', reason: 'the fix broke the build' }, dashboard(grimoire.ctx)));
    await putPage(world.a, world.a, 'flaky-show', [attempt]);
    const records = await sessionRecords(world.a, id, attempt);

    const shown = await ok(core.call('attempt_show', { attempt }, dashboard(grimoire.ctx)));

    const email = world.a.identity.email;
    expect(shown).toMatchObject({
      attempt,
      state: 'ended',
      purged: null,
      issue: { id, title: 'Show gr-5', status: 'done' },
      start: { assignee: email, opened: 'claim', actor: { person: email, kind: 'agent', client: 'claude-code' }, wiki_exposed: false },
      end: { ended: 'done', ended_by: { person: email, kind: 'agent' }, worker_kind: 'agent', wiki_exposed: false, field_changes: ['labels', 'status'] },
      outcome: { verdict: 'fail', reason: 'the fix broke the build', set_by: `human:${email}` },
      quarantine: null,
      knowledge: { pages: [{ slug: 'flaky-show', title: 'Page flaky-show', kind: 'failure' }], proposals: [] },
    });
    // The history, oldest first: grimoire's verdict at the close, then the human's override.
    expect(shown.outcome_history.map((entry) => [entry.verdict, entry.set_by])).toEqual([
      ['pass', 'grimoire'],
      ['fail', `human:${email}`],
    ]);
    expect(shown.capture.facts_complete).toBe(true);
    expect(shown.capture.contexts.map((context) => [context.context, context.client, context.excerpt.status, context.facts]).sort()).toEqual([
      [CLAUDE_AGENT, 'claude-code', 'cut', 'scanned'],
      ['main', 'claude-code', 'cut', 'scanned'],
    ]);
    // Each context's excerpt, as the record holds it: inert text for the page to show as source.
    for (const record of records) {
      const context = shown.capture.contexts.find((entry) => entry.key === record.name.replace(/\.md$/, ''))!;
      expect(context.text).toBe(record.body);
    }
    expect(shown.capture.wiki_exposed).toEqual({ exposed: false, at_start: false, at_end: false, hits: [] });
    expect(shown.capture.commits).toEqual([]);
    expect(shown.last_activity_at).toBeNull();
  });

  test('an open attempt: no end and no outcome yet, its last activity and stale flag', async ({ grimoire }) => {
    const { ctx } = grimoire;
    const id = (await ok(grimoire.core.call('create', { title: 'Open one' }, ctx))).id;
    const { attempt } = await ok(grimoire.core.call('claim', { id }, ctx));
    const later = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 25 * 3_600_000) });

    const shown = await ok(later.call('attempt_show', { attempt }, dashboard(ctx)));

    expect(shown).toMatchObject({ attempt, state: 'open', end: null, outcome: null, outcome_history: [], last_activity_at: T0.toISOString(), stale: true });
    expect(shown.capture).toEqual({ contexts: [], facts_complete: false, wiki_exposed: { exposed: false, at_start: false, at_end: null, hits: [] }, commits: [] });
  });

  test('a session that ran a chore: the wiki-exposed basis names the claim and each binding write with its basis', async ({ grimoire }) => {
    const { core, clock } = await dueCore(grimoire);
    const root = codexRoot(grimoire.ctx);
    const started = await ok(core.call('chore_start', {}, root));
    await ok(core.call('chore_abandon', { run: started.run, reason: 'done reading' }, root));
    const id = (await ok(core.call('create', { title: 'Work after a chore' }, grimoire.ctx))).id;
    const { attempt } = await ok(core.call('claim', { id }, root));
    clock.advance(0.01);
    await ok(core.call('comment', { id, attempt, body: 'progress' }, codexRoot(grimoire.ctx, 'nonce-later')));

    const shown = await ok(core.call('attempt_show', { attempt }, dashboard(grimoire.ctx)));

    expect(shown.capture.wiki_exposed).toMatchObject({
      exposed: true,
      at_start: true,
      at_end: null,
      hits: [
        { op: 'claim', basis: 'session', session: CODEX_ROOT_SESSION },
        { op: 'comment', basis: 'session', session: CODEX_ROOT_SESSION },
      ],
    });
  });

  test('a purged trace shows its tombstone; quarantine shows the mark; an unknown handle is NOT_FOUND', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const quarantined = await workPair(core, ctx, 'fail', 'Quarantined');
    const purged = await workPair(core, ctx, 'pass', 'Purged');
    await ok(core.call('quarantine', { trace: quarantined, reason: 'misleading' }, dashboard(ctx)));
    await ok(core.call('purge_trace', { attempt: purged, reason: 'a secret' }, dashboard(ctx)));

    const marked = await ok(core.call('attempt_show', { attempt: quarantined }, dashboard(ctx)));
    const gone = await ok(core.call('attempt_show', { attempt: purged }, dashboard(ctx)));
    const unknown = await core.call('attempt_show', { attempt: 'at-zzzzzz' }, dashboard(ctx));

    expect(marked.quarantine).toMatchObject({ by: grimoire.ctx.person.email, reason: 'misleading' });
    expect(gone).toMatchObject({ attempt: purged, state: 'purged', purged: { by: grimoire.ctx.person.email, reason: 'a secret' }, start: null, end: null, issue: null });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    const refused = await grimoire.core.call('attempt_show', { attempt: 'at-zzzzzz' }, grimoire.ctx);
    expect(refused).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
  });
});

/** A core whose Wiki Maintainer is due: one settled pair, a day on. */
async function dueCore(grimoire: Grimoire): Promise<{ core: Core; clock: Clock }> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now });
  await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
  await workPair(core, grimoire.ctx, 'fail');
  clock.advance(25);
  return { core, clock };
}
