// Seam 1 (spec Testing Decisions; §16 Due-ness): chores are offered while due,
// never queued, and due-ness is recomputed from the tracker on every ask. Input
// pairs are settled (trace, current outcome) pairs, pass or fail; the Wiki
// Maintainer is due at 5 uncompiled pairs with a fail, and an outcome flip
// makes a compiled pair uncompiled again. Every threshold is a store setting,
// and the loop pause stops new due-ness.
import { describe, expect } from 'vitest';
import type { Core } from '../../src/core';
import { choreAgent, Clock, commitChoreRun, compileRecord, dashboard, putPage, terminal, workPair } from './chore-support';
import { coreTest as test, T0 } from './support';

async function startChore(core: Core, ctx: Parameters<Core['call']>[2], input: Record<string, unknown> = {}) {
  return core.call('chore_start', input, ctx);
}

describe('the Wiki Maintainer’s due-ness', () => {
  test('with 5 settled pairs including a fail, the Wiki Maintainer is due, with a batch newest first of at most 3 passes', async ({ grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const passes: string[] = [];
    for (let i = 0; i < 4; i++) {
      passes.push(await workPair(core, grimoire.ctx, 'pass', `Pass ${i}`));
      clock.advance(1);
    }
    const fail = await workPair(core, grimoire.ctx, 'fail', 'The fail');
    const chores = await choreAgent(grimoire.ctx);

    // Not settled yet: the attempts ended less than 24 hours ago.
    clock.advance(23);
    const early = await startChore(core, chores);
    expect(early).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });

    clock.advance(2);
    const started = await startChore(core, chores);

    expect(started).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', origin: 'session', isolation: 'claude-chore-agent' } });
    if (!started.ok) return;
    expect(started.result.pairs).toEqual([
      { pair: `${fail}@fail`, trace: fail, outcome: 'fail' },
      { pair: `${passes[3]}@pass`, trace: passes[3], outcome: 'pass' },
      { pair: `${passes[2]}@pass`, trace: passes[2], outcome: 'pass' },
      { pair: `${passes[1]}@pass`, trace: passes[1], outcome: 'pass' },
    ]);
    expect(started.result.run).toMatch(/^cr-[0-9a-hjkmnp-tv-z]{10}$/);
    expect(started.result.pages).toBeGreaterThanOrEqual(1);
  });

  test('4 settled pairs, or 5 with no fail, are not enough; a human-set outcome is settled at once', async ({ grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    for (let i = 0; i < 5; i++) await workPair(core, grimoire.ctx, 'pass', `Pass ${i}`);
    const chores = await choreAgent(grimoire.ctx);
    clock.advance(25);
    expect(await startChore(core, chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE', details: { why: expect.any(String) } } });

    // A fail made just now isn't settled; a human setting its outcome settles it.
    const fail = await workPair(core, grimoire.ctx, 'fail', 'Fresh fail');
    expect(await startChore(core, chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
    await core.call('outcome_set', { attempt: fail, verdict: 'fail', reason: 'confirmed by a person' }, dashboard(grimoire.ctx));
    expect(await startChore(core, chores)).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer' } });
  });

  test('every threshold is a store setting: compile_pairs 1 makes a single settled fail due', async ({ grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    await workPair(core, grimoire.ctx, 'fail');
    clock.advance(25);
    const chores = await choreAgent(grimoire.ctx);
    expect(await startChore(core, chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });

    await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
    expect(await startChore(core, chores)).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer' } });
  });

  test('one uncompiled fail becomes due 7 days after the last compile', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const old = await workPair(core, grimoire.ctx, 'pass', 'Old work');
    clock.advance(25);
    await commitChoreRun(world.a, world.a, compileRecord('cr-0000000001', clock.now().toISOString(), [[old, 'pass']]));
    await workPair(core, grimoire.ctx, 'fail');
    const chores = await choreAgent(grimoire.ctx);
    clock.advance(6 * 24);
    expect(await startChore(core, chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
    clock.advance(25);
    expect(await startChore(core, chores)).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', pairs: [expect.objectContaining({ outcome: 'fail' })] } });
  });

  test('with the loop paused, nothing is due, not even on a manual run', async ({ grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    for (let i = 0; i < 4; i++) await workPair(core, grimoire.ctx, 'pass', `Pass ${i}`);
    await workPair(core, grimoire.ctx, 'fail');
    clock.advance(25);
    const chores = await choreAgent(grimoire.ctx);

    const paused = await core.call('settings_set', { key: 'knowledge.loop', value: 'paused' }, terminal(grimoire.ctx));
    expect(paused).toMatchObject({ ok: true, result: { changed: true } });

    expect(await startChore(core, chores)).toMatchObject({
      ok: false,
      error: { code: 'NOT_DUE', details: { why: 'the knowledge loop is paused' } },
    });
    expect(await startChore(core, chores, { manual: true })).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });

    await core.call('settings_set', { key: 'knowledge.loop', value: 'on' }, terminal(grimoire.ctx));
    expect(await startChore(core, chores)).toMatchObject({ ok: true });
  });

  test('a compiled pair is no longer due; an outcome flip makes it uncompiled again, with its flip context', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const traces: [string, string][] = [];
    for (let i = 0; i < 4; i++) traces.push([await workPair(core, grimoire.ctx, 'pass', `Pass ${i}`), 'pass']);
    traces.push([await workPair(core, grimoire.ctx, 'fail'), 'fail']);
    clock.advance(25);
    await commitChoreRun(world.a, world.a, compileRecord('cr-0000000001', clock.now().toISOString(), traces));
    const chores = await choreAgent(grimoire.ctx);

    expect(await startChore(core, chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
    expect(await startChore(core, chores, { kind: 'wiki-maintainer', manual: true })).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });

    // A person overrules one pass: the pair (trace, fail) was never compiled.
    const flipped = traces[1]![0];
    await core.call('outcome_set', { attempt: flipped, verdict: 'fail', reason: 'it broke the build' }, dashboard(grimoire.ctx));
    const started = await startChore(core, chores, { kind: 'wiki-maintainer', manual: true });

    expect(started).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', origin: 'manual', pairs: [{ pair: `${flipped}@fail`, trace: flipped, outcome: 'fail' }] } });
    if (!started.ok) return;
    const read = await core.call('chore_read', { run: started.result.run }, chores);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const trace = read.result.items.find((item) => item.item === `trace:${flipped}`);
    expect(trace).toMatchObject({ outcome: 'fail', flip: { from: 'pass', to: 'fail', compiled_in: 'cr-0000000001', reason: 'it broke the build' } });
  });

  test('a pair seen in 2 failed compile runs is set aside and no longer offered', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
    const fail = await workPair(core, grimoire.ctx, 'fail');
    clock.advance(25);
    const chores = await choreAgent(grimoire.ctx);
    const failed = (id: string) => ({ ...compileRecord(id, clock.now().toISOString(), []), result: 'failed', reasons: ['page-too-long'], pairs: [`${fail}@fail`] });

    await commitChoreRun(world.a, world.a, failed('cr-0000000001'));
    const first = await startChore(core, chores);
    expect(first).toMatchObject({ ok: true, result: { pairs: [expect.objectContaining({ trace: fail })] } });
    if (first.ok) await core.call('chore_abandon', { run: first.result.run, reason: 'stopping' }, chores);

    await commitChoreRun(world.a, world.a, failed('cr-0000000002'));
    expect(await startChore(core, chores)).toMatchObject({
      ok: false,
      error: { code: 'NOT_DUE', details: { kinds: { 'wiki-maintainer': 'no uncompiled settled traces' } } },
    });
  });
});

describe('order: a compile first, then the Skill Proposer it made due', () => {
  test('the Skill Proposer is due once unconsumed compiles hold 2 fails; after a compile it goes next, and a proposer run consumes them', async ({
    world,
    grimoire,
  }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
    const fails = [await workPair(core, grimoire.ctx, 'fail', 'First'), await workPair(core, grimoire.ctx, 'fail', 'Second')];
    clock.advance(25);
    const chores = await choreAgent(grimoire.ctx);

    // Nothing compiled yet: the compile comes first.
    const first = await startChore(core, chores);
    expect(first).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer' } });
    if (first.ok) await core.call('chore_abandon', { run: first.result.run, reason: 'later' }, chores);

    const version = await putPage(world.a, world.a, 'flaky-ports', fails);
    await commitChoreRun(world.a, world.a, compileRecord('cr-0000000001', clock.now().toISOString(), fails.map((t) => [t, 'fail'] as const), { 'flaky-ports': version }));
    const third = await workPair(core, grimoire.ctx, 'fail', 'Third');
    clock.advance(25);

    // Both are due now (one uncompiled fail; two fails in an unconsumed compile): the proposal goes after the compile.
    const proposer = await startChore(core, chores);
    expect(proposer).toMatchObject({ ok: true, result: { kind: 'skill-proposer', pairs: [] } });
    if (!proposer.ok) return;
    expect(proposer.result.manifest).toEqual(expect.arrayContaining(['outcomes', 'wiki-index', `trace:${fails[0]}`, `trace:${fails[1]}`, 'handwritten']));
    expect(proposer.result.manifest).not.toContain(`trace:${third}`);
    const page = await core.call('chore_read', { run: proposer.result.run, item: 'page:flaky-ports' }, chores);
    expect(page).toMatchObject({ ok: true, result: { items: [{ item: 'page:flaky-ports', sources: [...fails].sort() }] } });
    await core.call('chore_abandon', { run: proposer.result.run, reason: 'later' }, chores);

    // A proposer run that ended consumed the compile: the Skill Proposer isn't due, and the compile is next.
    await commitChoreRun(world.a, world.a, {
      ...compileRecord('cr-0000000002', clock.now().toISOString(), []),
      kind: 'skill-proposer',
      result: 'no_action',
      consumed: ['cr-0000000001'],
    });
    expect(await startChore(core, chores, { kind: 'skill-proposer' })).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
    expect(await startChore(core, chores)).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', pairs: [expect.objectContaining({ trace: third })] } });
  });
});
