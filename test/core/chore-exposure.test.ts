// Seam 1 (spec §16 Admission: exposure, Failures and replays: lease; §14
// Wiki-exposed; §8 Chore contexts): a chore that runs outside an isolated
// context marks its session (a Codex root thread) or its server process (an
// unidentified caller), and every attempt that session or process opens or
// later binds to is flagged wiki-exposed: in `start.md` at the claim, and on
// `Grimoire-Actor` with its basis afterwards. A context holding an open chore
// run never claims or writes issues, and a run's lease lapses after 60 minutes
// without a chore call.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { Checkout } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { Clock, codexRoot, codexSubagent, DEBRIEF, genericCall, terminal, workPair } from './chore-support';
import { coreTest as test, T0, trackerFile, TRACKER_REF, type Grimoire } from './support';

async function dueCore(grimoire: Grimoire): Promise<{ core: Core; clock: Clock }> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now });
  await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
  await workPair(core, grimoire.ctx, 'fail');
  clock.advance(25);
  return { core, clock };
}

/** Runs a chore in `ctx` and abandons it: the context is free to work issues again, but stays marked. */
async function runChore(core: Core, ctx: CallContext): Promise<void> {
  const started = await core.call('chore_start', {}, ctx);
  if (!started.ok) throw new Error(`chore_start failed: ${JSON.stringify(started.error)}`);
  const abandoned = await core.call('chore_abandon', { run: started.result.run, reason: 'done reading' }, ctx);
  expect(abandoned).toMatchObject({ ok: true, result: { abandoned: true, summary: expect.stringMatching(/^grimoire chores: .*abandoned; nothing consumed$/) } });
}

async function newIssue(core: Core, ctx: CallContext, title: string): Promise<string> {
  const created = await core.call('create', { title }, ctx);
  if (!created.ok) throw new Error('create failed');
  return created.result.id;
}

async function tipActor(checkout: Checkout): Promise<Record<string, string>> {
  const value = await checkout.git(['log', '-1', '--format=%(trailers:key=Grimoire-Actor,valueonly,unfold)', TRACKER_REF]);
  return JSON.parse(value) as Record<string, string>;
}

async function attemptFile(checkout: Checkout, issue: string, attempt: string, file: string): Promise<string> {
  const tip = await checkout.git(['rev-parse', TRACKER_REF]);
  return trackerFile(checkout, tip, `attempts/${issue[3]}/${issue[4]}/${issue}/${attempt}/${file}`);
}

describe('wiki exposure', () => {
  test('a chore in a Codex root thread marks the session: a later claim records wiki-exposed in start.md, and later binding writes carry the basis', async ({
    world,
    grimoire,
  }) => {
    const { core } = await dueCore(grimoire);
    const root = codexRoot(grimoire.ctx);
    await runChore(core, root);

    const id = await newIssue(core, grimoire.ctx, 'Work after a chore');
    const claimed = await core.call('claim', { id }, root);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const { attempt } = claimed.result;
    expect(await attemptFile(world.a, id, attempt, 'start.md')).toMatch(/^wiki_exposed: true$/m);
    expect(await tipActor(world.a)).toMatchObject({ session: '01a12946-7d23-7f93-b8c8-aa18d1bca5ef', chore_exposure: 'session' });

    // Another server process of the same session (a new thread's MCP server) binds too: the session is marked.
    await core.call('comment', { id, attempt, body: 'progress' }, codexRoot(grimoire.ctx, 'nonce-later'));
    expect(await tipActor(world.a)).toMatchObject({ chore_exposure: 'session', nonce: 'nonce-later' });

    await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, root);
    expect(await attemptFile(world.a, id, attempt, 'end.md')).toMatch(/^wiki_exposed: true$/m);
  });

  test('an attempt opened before the chore is flagged at its end by a later binding write from the marked session', async ({ world, grimoire }) => {
    const { core } = await dueCore(grimoire);
    const id = await newIssue(core, grimoire.ctx, 'Work before a chore');
    // Claimed from Claude Code's main context: the Codex session is tied to nothing.
    const claimed = await core.call('claim', { id }, grimoire.ctx);
    if (!claimed.ok) throw new Error('claim failed');
    const { attempt } = claimed.result;
    expect(await attemptFile(world.a, id, attempt, 'start.md')).toMatch(/^wiki_exposed: false$/m);

    const root = codexRoot(grimoire.ctx);
    await runChore(core, root);
    // A write from the unmarked Claude session carries nothing; one from the marked Codex session binds with its basis.
    await core.call('comment', { id, attempt, body: 'from Claude' }, grimoire.ctx);
    expect((await tipActor(world.a)).chore_exposure).toBeUndefined();
    await core.call('comment', { id, attempt, body: 'from Codex' }, root);
    expect(await tipActor(world.a)).toMatchObject({ chore_exposure: 'session' });

    await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, grimoire.ctx);
    expect(await attemptFile(world.a, id, attempt, 'start.md')).toMatch(/^wiki_exposed: false$/m);
    expect(await attemptFile(world.a, id, attempt, 'end.md')).toMatch(/^wiki_exposed: true$/m);
  });

  test('an unidentified caller’s chore marks its server process: a claim from that process is wiki-exposed, one from another is not', async ({
    world,
    grimoire,
  }) => {
    const { core } = await dueCore(grimoire);
    const marked = genericCall(grimoire.ctx, 'nonce-marked');
    await runChore(core, marked);

    const first = await newIssue(core, grimoire.ctx, 'From the marked process');
    const claimed = await core.call('claim', { id: first }, marked);
    if (!claimed.ok) throw new Error('claim failed');
    expect(await attemptFile(world.a, first, claimed.result.attempt, 'start.md')).toMatch(/^wiki_exposed: true$/m);
    expect(await tipActor(world.a)).toMatchObject({ nonce: 'nonce-marked', chore_exposure: 'process' });

    const second = await newIssue(core, grimoire.ctx, 'From another process');
    const other = await core.call('claim', { id: second }, genericCall(grimoire.ctx, 'nonce-clean'));
    if (!other.ok) throw new Error('claim failed');
    expect(await attemptFile(world.a, second, other.result.attempt, 'start.md')).toMatch(/^wiki_exposed: false$/m);
  });
});

describe('chore contexts and the lease', () => {
  test('a claim or issue write from a context holding an open chore run gives NOT_ISOLATED; reads still work', async ({ world, grimoire }) => {
    const { core } = await dueCore(grimoire);
    const subagent = codexSubagent(grimoire.ctx);
    const id = await newIssue(core, grimoire.ctx, 'Someone’s issue');
    const started = await core.call('chore_start', {}, subagent);
    expect(started.ok).toBe(true);

    const before = await world.a.git(['rev-parse', TRACKER_REF]);
    for (const [op, input] of [
      ['claim', { id }],
      ['create', { title: 'From a chore' }],
      ['comment', { id, body: 'From a chore' }],
      ['update', { id, labels_add: ['chore'] }],
      ['close', { id, reason: 'canceled' }],
    ] as const) {
      expect(await core.call(op, input, subagent), op).toMatchObject({ ok: false, error: { code: 'NOT_ISOLATED' } });
    }
    expect(await world.a.git(['rev-parse', TRACKER_REF])).toBe(before);
    expect(await core.call('show', { ref: id }, subagent)).toMatchObject({ ok: true });
    // Another context is unaffected.
    expect(await core.call('claim', { id }, grimoire.ctx)).toMatchObject({ ok: true });
  });

  test('an expired lease makes the chore due again; the expired run is superseded once a newer one starts', async ({ grimoire }) => {
    const { core, clock } = await dueCore(grimoire);
    const subagent = codexSubagent(grimoire.ctx);
    const first = await core.call('chore_start', {}, subagent);
    if (!first.ok) throw new Error('chore_start failed');

    // In progress on this machine: not due for anyone else.
    const generic = genericCall(grimoire.ctx);
    expect(await core.call('chore_start', {}, generic)).toMatchObject({
      ok: false,
      error: { code: 'NOT_DUE', details: { kinds: { 'wiki-maintainer': expect.stringMatching(/in progress/) } } },
    });
    // A chore call renews the lease.
    clock.advance(0.9);
    expect(await core.call('chore_read', { run: first.result.run }, subagent)).toMatchObject({ ok: true });
    clock.advance(0.9);
    expect(await core.call('chore_start', {}, generic)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });

    // An hour with no chore call: the lease lapsed, nothing was consumed, and the chore is due again.
    clock.advance(0.2);
    const second = await core.call('chore_start', {}, generic);
    expect(second).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', pairs: first.result.pairs } });

    expect(await core.call('chore_read', { run: first.result.run }, subagent)).toMatchObject({ ok: false, error: { code: 'RUN_SUPERSEDED' } });
    // The expired run's context is a chore context no longer.
    const id = await newIssue(core, grimoire.ctx, 'Free again');
    expect(await core.call('claim', { id }, subagent)).toMatchObject({ ok: true });
  });

  test('only the context that started a run may page or abandon it', async ({ grimoire }) => {
    const { core } = await dueCore(grimoire);
    const subagent = codexSubagent(grimoire.ctx);
    const started = await core.call('chore_start', {}, subagent);
    if (!started.ok) throw new Error('chore_start failed');
    expect(await core.call('chore_read', { run: started.result.run }, grimoire.ctx)).toMatchObject({ ok: false, error: { code: 'NOT_ISOLATED' } });
    expect(await core.call('chore_abandon', { run: started.result.run, reason: 'x' }, codexRoot(grimoire.ctx))).toMatchObject({
      ok: false,
      error: { code: 'NOT_ISOLATED' },
    });
    expect(await core.call('chore_read', { run: 'cr-zzzzzzzzzz' }, subagent)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('an atomic chore_start', () => {
  test('a start whose exposure mark fails leaves no run behind, and a claim racing a start from the same session never lands beside a run', async ({ world, grimoire }) => {
    const { core } = await dueCore(grimoire);
    const root = codexRoot(grimoire.ctx);
    // A file where the exposure marks' folder goes: marking the session fails.
    const marks = path.join(world.a.dir, '.git', 'grimoire', 'records', 'chore-exposure');
    await mkdir(path.dirname(marks), { recursive: true });
    await writeFile(marks, 'in the way');
    const failed = await core.call('chore_start', {}, root).catch(() => ({ ok: false as const }));
    expect(failed.ok).toBe(false);
    await rm(marks);

    // Nothing of the start holds: the session is no chore context, and the chore is still due.
    const id = await newIssue(core, grimoire.ctx, 'After a failed start');
    const claimed = await core.call('claim', { id }, root);
    if (!claimed.ok) throw new Error(`claim failed: ${JSON.stringify(claimed.error)}`);
    expect(await attemptFile(world.a, id, claimed.result.attempt, 'start.md')).toMatch(/^wiki_exposed: false$/m);
    await core.call('close', { id, attempt: claimed.result.attempt, reason: 'done', debrief: DEBRIEF }, root);

    // A claim and a start from one session at once: exactly one of them holds.
    const raced = await newIssue(core, grimoire.ctx, 'Raced');
    const [started, claim] = await Promise.all([core.call('chore_start', {}, root), core.call('claim', { id: raced }, codexRoot(grimoire.ctx, 'nonce-race'))]);
    expect([started.ok, claim.ok].filter(Boolean)).toHaveLength(1);
    expect(started.ok ? claim : started).toMatchObject({ ok: false, error: { code: 'NOT_ISOLATED' } });
  });
});

describe('run-record updates', () => {
  test('a chore_read racing chore_abandon never reopens the abandoned run', async ({ grimoire }) => {
    const { core } = await dueCore(grimoire);
    const subagent = codexSubagent(grimoire.ctx);
    const started = await core.call('chore_start', {}, subagent);
    if (!started.ok) throw new Error('chore_start failed');
    const run = started.result.run;

    const [, abandoned] = await Promise.all([core.call('chore_read', { run }, subagent), core.call('chore_abandon', { run, reason: 'stop' }, subagent)]);
    expect(abandoned).toMatchObject({ ok: true, result: { abandoned: true } });

    // Abandoned is terminal: the run stays ended, and its context is free.
    expect(await core.call('chore_read', { run }, subagent)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { state: 'abandoned' } } });
    expect(await core.call('chore_abandon', { run, reason: 'again' }, subagent)).toMatchObject({ ok: true, result: { replayed: true } });
    const id = await newIssue(core, grimoire.ctx, 'After the abandon');
    expect(await core.call('claim', { id }, subagent)).toMatchObject({ ok: true });
  });
});
