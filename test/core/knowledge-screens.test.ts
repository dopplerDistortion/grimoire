// The reads behind the dashboard's Knowledge screens (spec §20 Knowledge,
// Attention; §16 due-ness, set-aside pairs and chore-run records; §17; §18):
// `knowledge_overview`, `chore_runs`, the knowledge items of `attention`, and
// what `skill_show` adds for the Skills list and detail. Seam 1: the core
// against real git in temp repos.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { MachineLocalStore } from '../../src/machine-local';
import { Clock, commitChoreRun, compileRecord, dashboard, putPage, terminal, workPair } from './chore-support';
import { ok, PAGE, patchResult, proposer, SKILL, submit } from './proposer-support';
import { coreTest as test, T0 } from './support';

describe('knowledge_overview', () => {
  test('the tiles, what is due, the pending proposal with its red-flag and cited-trace counts, the recent decisions and chore runs; a purge raises the live red flag', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const human = dashboard(grimoire.ctx);

    const pending = ok(await p.core.call('knowledge_overview', {}, human));
    ok(await p.core.call('purge_trace', { attempt: p.fails[0], reason: 'held a customer name' }, terminal(grimoire.ctx)));
    ok(await p.core.call('purge_trace', { attempt: p.fails[1], reason: 'held a customer name' }, terminal(grimoire.ctx)));
    const flagged = ok(await p.core.call('knowledge_overview', {}, human));
    p.clock.advance(3);
    ok(await p.core.call('proposal_accept', { id: proposal, ack: ['evidence'] }, human));
    const decided = ok(await p.core.call('knowledge_overview', {}, human));

    expect(pending).toMatchObject({
      loop: 'on',
      delivery: 'on',
      pickup: 'ask',
      pending: { id: proposal, skill: SKILL, action: 'patch', age_hours: 0, red_flags: 0, traces: 4, pages: 1 },
      pending_count: 1,
      pending_limit: 1,
      backlog: { pairs: 0, fails: 0, passes: 0 },
      last_compile: { run: 'cr-0000000001' },
      cap: { active: 1, max: 8, over: false },
      due: { paused: false, next: null, 'wiki-maintainer': { due: false }, 'skill-proposer': { due: false } },
      counts: { stale: 0, lapsed: 0, contested: 0, forks: 0, set_aside: 0, quarantined: 0 },
      history: { decided: 0, accept_rate: null },
      decisions: [],
      set_aside: [],
    });
    expect(pending.due['skill-proposer'].why).toMatch(/pending/);
    expect(pending.runs.map((run) => [run.kind, run.outcome, run.origin, run.isolation])).toEqual([
      ['skill-proposer', 'proposed', 'session', 'claude-chore-agent'],
      ['wiki-maintainer', 'compiled', 'session', 'claude-chore-agent'],
    ]);
    expect(pending.runs[0]).toMatchObject({ proposal, where: 'tracker' });
    expect(pending.runs[1]).toMatchObject({ id: 'cr-0000000001', pages: [PAGE] });
    expect(flagged.pending).toMatchObject({ id: proposal, red_flags: 1 });
    expect(decided).toMatchObject({
      pending: null,
      pending_count: 0,
      history: { decided: 1, accepted: 1, accept_rate: 1, median_hours_to_decision: 3 },
      decisions: [{ id: proposal, skill: SKILL, action: 'patch', status: 'accepted', by: grimoire.ctx.person.email, hours: 3 }],
    });
  });

  test('a pair struck by two failed compiles is set aside: listed with its trace and strikes, counted, and an attention item; quarantining the trace takes it out and counts it', async ({
    world,
    grimoire,
  }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const human = dashboard(grimoire.ctx);
    const trace = await workPair(core, grimoire.ctx, 'fail', 'Port clash');
    clock.advance(25);
    const failed = (id: string) => ({
      ...compileRecord(id, clock.now().toISOString(), []),
      result: 'failed',
      consumption: [],
      reasons: ['page_too_long'],
      pairs: [`${trace}@fail`],
    });
    await commitChoreRun(world.a, world.a, failed('cr-0000000001'));
    await commitChoreRun(world.a, world.a, failed('cr-0000000002'));

    const overview = ok(await core.call('knowledge_overview', {}, human));
    const attention = ok(await core.call('attention', {}, human));
    ok(await core.call('quarantine', { trace, reason: 'it trips the compile' }, human));
    const after = ok(await core.call('knowledge_overview', {}, human));

    expect(overview.set_aside).toEqual([{ pair: `${trace}@fail`, trace, issue: expect.stringMatching(/^gr-/), outcome: 'fail', strikes: 2, ended_at: T0.toISOString() }]);
    expect(overview.counts.set_aside).toBe(1);
    expect(overview.runs.map((run) => [run.id, run.outcome, run.reasons])).toEqual([
      ['cr-0000000002', 'failed', ['page_too_long']],
      ['cr-0000000001', 'failed', ['page_too_long']],
    ]);
    expect(attention.items).toEqual([{ kind: 'set_aside', pair: `${trace}@fail`, trace, issue: overview.set_aside[0]!.issue, outcome: 'fail', strikes: 2 }]);
    expect(after.set_aside).toEqual([]);
    expect(after.counts).toMatchObject({ set_aside: 0, quarantined: 1 });
  });

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    expect(await grimoire.core.call('knowledge_overview', {}, grimoire.ctx)).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
  });
});

// Used by later slices.
void path;
void MachineLocalStore;
void putPage;
