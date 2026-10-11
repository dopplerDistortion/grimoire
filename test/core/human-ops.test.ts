// Human-only issue operations and the surface gate (spec §7, §3 Delete, §19):
// assign, reassign, releasing another person's attempt as abandoned, reopen,
// delete and outcome overrides, refused from every agent surface.
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import type { GitWorld } from '#harness';
import {
  agentContext,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  pushTracker,
  suffixQueue,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
} from './support';

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };
const T1 = new Date(T0.getTime() + 60_000);

/** Clone b takes clone a's tracker as its own: from here the two write apart until they fold. */
async function bothClones(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

async function claim(core: Core, ctx: CallContext, id: string): Promise<string> {
  const claimed = await core.call('claim', { id }, ctx);
  if (!claimed.ok) throw new Error(`claim failed: ${JSON.stringify(claimed.error)}`);
  return claimed.result.attempt;
}

/** The dashboard: a human actor with client `dashboard`. */
function dashboard(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'dashboard', client: null, evidence: {} };
}

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

/** Every human-only issue op, with an input it would accept. */
function humanOnlyCalls(id: string, attempt: string): [string, Record<string, unknown>][] {
  return [
    ['assign', { id, assignee: 'carol@example.com' }],
    ['reassign', { id, assignee: 'carol@example.com' }],
    ['reopen', { id, comment: 'not done after all' }],
    ['delete', { id }],
    ['resolve', { id, take: 'kept' }],
    ['outcome_set', { attempt, verdict: 'fail', reason: 'it broke the build' }],
    ['settings_set', { key: 'auto-sync', value: false }],
  ];
}

describe('the human-only gate', () => {
  test('every human-only op from MCP, under an agent marker or without a TTY gives HUMAN_ONLY, the ref unmoved', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Guarded' });
    const attempt = await claim(core, ctx, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);
    const agentSurfaces: CallContext[] = [
      ctx,
      { ...terminal(ctx), evidence: { agentMarkers: ['CLAUDE_CODE_CHILD_SESSION'] } },
      { ...terminal(ctx), evidence: { agentMarkers: ['CODEX_THREAD_ID'] } },
      { ...terminal(ctx), tty: false },
      { ...terminal(ctx), tty: undefined },
      { ...ctx, surface: 'hook' },
      { ...ctx, surface: 'runner', client: { name: 'runner:claude' } },
    ];

    const refused = await expectRefUnmoved(world.a, async () => {
      const outcomes = [];
      for (const surface of agentSurfaces) {
        for (const [op, input] of humanOnlyCalls(id, attempt)) outcomes.push({ op, outcome: await core.call(op, input, surface) });
      }
      return outcomes;
    });

    for (const { op, outcome } of refused) {
      expect(outcome, op).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY', retryable: false, details: {} } });
      const message = outcome.ok ? '' : outcome.error.message;
      // The message never names the agent markers.
      expect(message).not.toMatch(/AI_AGENT|CLAUDE_CODE|CODEX|marker|environment|env/i);
    }
  });

  test('the registry tells the surfaces each op’s policy, and only agent ops are MCP tools', async ({ grimoire }) => {
    const byName = Object.fromEntries(grimoire.core.ops.map((op) => [op.name, op]));

    for (const name of ['assign', 'reassign', 'reopen', 'delete', 'resolve', 'outcome_set', 'settings_set']) {
      expect(byName[name], name).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false });
    }
    expect(byName.settings_get).toMatchObject({ kind: 'read', policy: 'agent', mcp: false });
    for (const name of ['show', 'list', 'labels', 'create', 'update', 'comment', 'claim', 'release', 'close']) {
      expect(byName[name], name).toMatchObject({ policy: 'agent', mcp: true });
    }
  });
});

describe('assign and reassign', () => {
  test('assign opens an attempt on that person’s behalf, recording the human who did it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'For Carol' });

    const assigned = await core.call('assign', { id, assignee: ' carol@example.com ' }, dashboard(ctx));

    expect(assigned).toMatchObject({ ok: true, result: { id, assignee: 'carol@example.com', attempt: expect.stringMatching(/^at-/) } });
    const handle = assigned.ok ? assigned.result.attempt : '';
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { assignee: 'carol@example.com', open_attempts: [{ attempt: handle, assignee: 'carol@example.com', held_by_you: false }] },
    });
    const tip = (await trackerTip(world.a))!;
    const start = await trackerFile(world.a, tip, `attempts/${id[3]}/${id[4]}/${id}/${handle}/start.md`);
    expect(start).toMatch(/^assignee: "carol@example.com"$/m);
    expect(start).toMatch(/^opened: "assign"$/m);
    expect(start).toMatch(/^actor: \{"person":"alice@example.com","kind":"human","client":"dashboard",/m);
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(/^Grimoire-Op: assign$/m);
  });

  test('assign refuses a claimed, closed or invalid target', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const claimed = await createIssue(core, ctx, { title: 'Taken' });
    await claim(core, ctx, claimed);
    const closed = await createIssue(core, ctx, { title: 'Closed' });
    await core.call('close', { id: closed, reason: 'canceled' }, ctx);

    const [taken, done, bad] = await expectRefUnmoved(world.a, async () => [
      await core.call('assign', { id: claimed, assignee: 'carol@example.com' }, terminal(ctx)),
      await core.call('assign', { id: closed, assignee: 'carol@example.com' }, terminal(ctx)),
      await core.call('assign', { id: claimed, assignee: 'not an email' }, terminal(ctx)),
    ]);

    expect(taken).toMatchObject({ ok: false, error: { code: 'ALREADY_CLAIMED' } });
    expect(done).toMatchObject({ ok: false, error: { code: 'NOT_OPEN' } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { assignee: expect.any(String) } } } });
  });

  test('reassign ends the open attempt as reassign (a fail) and opens another for the new assignee, in one commit', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Handover' });
    const first = await claim(core, ctx, id);
    const before = (await trackerTip(world.a))!;

    const reassigned = await core.call('reassign', { id, assignee: 'bob@example.com' }, terminal(ctx));

    expect(reassigned).toMatchObject({
      ok: true,
      result: { id, assignee: 'bob@example.com', ended: first, attempt: expect.stringMatching(/^at-/) },
    });
    const second = reassigned.ok ? reassigned.result.attempt : '';
    expect(second).not.toBe(first);
    expect(await world.a.git(['rev-list', '--count', `${before}..${(await trackerTip(world.a))!}`])).toBe('1');
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: {
        assignee: 'bob@example.com',
        open_attempts: [{ attempt: second, assignee: 'bob@example.com' }],
        past_attempts: [
          {
            attempt: first,
            assignee: 'alice@example.com',
            ended: 'reassign',
            ended_by: 'alice@example.com',
            outcome: { verdict: 'fail', reason: 'reassign', set_by: 'grimoire' },
          },
        ],
      },
    });
  });

  test('with two open attempts after a fold, reassign is refused until one is released as abandoned', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const bob = agentContext(world.b);
    const id = await createIssue(core, alice, { title: 'Claimed twice' });
    await bothClones(world);
    const mine = await claim(core, alice, id);
    const bobs = await claim(bobCore, bob, id);
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('reassign', { id, assignee: 'carol@example.com' }, terminal(alice)),
      await core.call('reassign', { id, assignee: 'carol@example.com', attempt: bobs }, terminal(alice)),
    ]);
    await core.call('release', { id, attempt: bobs, abandoned: true }, terminal(alice));
    const reassigned = await core.call('reassign', { id, assignee: 'carol@example.com' }, terminal(alice));

    expect(refused[0]).toMatchObject({
      ok: false,
      error: {
        code: 'STATE_CONFLICT',
        message: expect.stringContaining('release one as abandoned'),
        details: { conflict: { fields: ['open_attempts'], theirs: { open_attempts: [mine, bobs] }, base: { open_attempts: [] } } },
      },
    });
    // There is no `attempt` input: a reassign ends the one open attempt.
    expect(refused[1]).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { attempt: expect.any(String) } } } });
    expect(reassigned).toMatchObject({ ok: true, result: { ended: mine, assignee: 'carol@example.com' } });
  });

  test('reassign needs an attempt to end', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Nobody’s' });

    const refused = await expectRefUnmoved(world.a, () => core.call('reassign', { id, assignee: 'bob@example.com' }, terminal(ctx)));

    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('releasing another person’s attempt as abandoned', () => {
  test('works from the dashboard and a human terminal, but not from a CLI without a TTY', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const bob = { ...agentContext(world.b), repo: ctx.repo };
    const first = await createIssue(core, ctx, { title: 'Bob’s first' });
    const second = await createIssue(core, ctx, { title: 'Bob’s second' });
    const a1 = await claim(core, bob, first);
    const a2 = await claim(core, bob, second);

    const refused = await expectRefUnmoved(world.a, () =>
      core.call('release', { id: first, attempt: a1, abandoned: true }, { ...terminal(ctx), tty: false }),
    );
    const fromTerminal = await core.call('release', { id: first, attempt: a1, abandoned: true }, terminal(ctx));
    const fromDashboard = await core.call('release', { id: second, attempt: a2, abandoned: true }, dashboard(ctx));

    expect(refused).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE' } });
    expect(fromTerminal).toMatchObject({ ok: true, result: { ended: 'release-abandoned', outcome: 'fail' } });
    expect(fromDashboard).toMatchObject({ ok: true, result: { ended: 'release-abandoned', outcome: 'fail' } });
  });
});

describe('reopen', () => {
  test('needs a comment', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Closed' });
    await core.call('close', { id, reason: 'canceled' }, ctx);

    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('reopen', { id }, terminal(ctx)),
      await core.call('reopen', { id, comment: '  ' }, terminal(ctx)),
    ]);

    for (const outcome of refused) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { comment: expect.any(String) } } } });
    }
  });

  test('opens the issue unassigned, flips the closing pass to fail, and lists what waits for it again', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Epic' });
    const id = await createIssue(core, ctx, { title: 'Done too soon', parent });
    const waiting = await createIssue(core, ctx, { title: 'Waits for it', blocked_by: [id] });
    const closedDependent = await createIssue(core, ctx, { title: 'Closed dependent', blocked_by: [id] });
    await core.call('close', { id: closedDependent, reason: 'canceled' }, ctx);
    const attempt = await claim(core, ctx, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);
    expect(await core.call('show', { ref: waiting }, ctx)).toMatchObject({ ok: true, result: { ready: true } });

    const reopened = await core.call('reopen', { id, comment: 'The fix regressed on Windows.' }, dashboard(ctx));

    expect(reopened).toMatchObject({
      ok: true,
      result: {
        id,
        status: 'open',
        outcome: { attempt, from: 'pass', to: 'fail' },
        reblocked: [
          { id: waiting, title: 'Waits for it', via: 'blocked_by' },
          { id: parent, title: 'Epic', via: 'parent' },
        ],
      },
    });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: {
        status: 'open',
        assignee: null,
        open_attempts: [],
        ready: true,
        past_attempts: [{ attempt, ended: 'done', outcome: { verdict: 'fail', reason: 'reopened', set_by: 'grimoire' } }],
        comments: [
          expect.objectContaining({ kind: 'debrief' }),
          expect.objectContaining({
            body: 'The fix regressed on Windows.',
            actor: expect.objectContaining({ kind: 'human', client: 'dashboard' }),
          }),
        ],
      },
    });
    expect(await core.call('show', { ref: waiting }, ctx)).toMatchObject({ ok: true, result: { ready: false } });
  });

  test('a human’s override is not flipped by a later reopen', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Judged' });
    const attempt = await claim(core, ctx, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);
    await core.call('outcome_set', { attempt, verdict: 'pass', reason: 'verified by hand' }, terminal(ctx));

    const reopened = await core.call('reopen', { id, comment: 'Follow-up work, not a failure.' }, terminal(ctx));

    expect(reopened).toMatchObject({ ok: true, result: { outcome: null } });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { past_attempts: [{ attempt, outcome: { verdict: 'pass', set_by: 'human:alice@example.com' } }] },
    });
  });

  test('an attempt left open on the closed issue by a fold is superseded, so the issue reopens with no attempt', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const bob = agentContext(world.b);
    const id = await createIssue(core, alice, { title: 'Closed here, claimed there' });
    await bothClones(world);
    const mine = await claim(core, alice, id);
    await core.call('close', { id, reason: 'done', attempt: mine, debrief: DEBRIEF }, alice);
    const bobs = await claim(bobCore, bob, id);
    await pushTracker(world.b);
    await fetchTracker(world.a);
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({ ok: true, result: { status: 'done', open_attempts: [{ attempt: bobs }] } });

    const reopened = await core.call('reopen', { id, comment: 'Bob is still on it.' }, terminal(alice));

    expect(reopened).toMatchObject({ ok: true, result: { status: 'open', outcome: { attempt: mine, from: 'pass', to: 'fail' } } });
    const shown = await core.call('show', { ref: id }, alice);
    expect(shown).toMatchObject({ ok: true, result: { status: 'open', assignee: null, open_attempts: [], ready: true } });
    const past = shown.ok ? shown.result.past_attempts : [];
    expect(past).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt: mine, ended: 'done', outcome: expect.objectContaining({ verdict: 'fail', reason: 'reopened' }) }),
        expect.objectContaining({
          attempt: bobs,
          ended: 'superseded',
          ended_by: 'alice@example.com',
          outcome: expect.objectContaining({ verdict: 'none', reason: 'superseded' }),
        }),
      ]),
    );
  });

  test('a status the fold set aside must be resolved before a reopen', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const bob = terminal(agentContext(world.b));
    const id = await createIssue(core, alice, { title: 'Closed two ways' });
    await bothClones(world);
    await core.call('close', { id, reason: 'done' }, terminal(alice));
    await bobCore.call('close', { id, reason: 'canceled' }, bob);
    await pushTracker(world.b);
    await fetchTracker(world.a);
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({ ok: true, result: { conflict: { fields: ['status'] } } });

    const refused = await expectRefUnmoved(world.a, () => core.call('reopen', { id, comment: 'Neither.' }, terminal(alice)));

    expect(refused).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', details: { conflict: { fields: ['status'] } } } });
  });

  test('an open issue can’t be reopened', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Open' });

    const refused = await expectRefUnmoved(world.a, () => core.call('reopen', { id, comment: 'why' }, terminal(ctx)));

    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('delete', () => {
  test('one commit: the record goes, a tombstone stays, dependents lose the blocker (listed), attempts and outcomes stay', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Doomed', body: 'text' });
    await core.call('comment', { id, body: 'a comment' }, ctx);
    const other = await createIssue(core, ctx, { title: 'Other blocker' });
    const blocked = await createIssue(core, ctx, { title: 'Blocked twice', blocked_by: [id, other] });
    const closed = await createIssue(core, ctx, { title: 'Closed, blocked', blocked_by: [id] });
    await core.call('close', { id: closed, reason: 'canceled' }, ctx);
    const attempt = await claim(core, ctx, id);
    await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx);
    const before = (await trackerTip(world.a))!;

    const deleted = await core.call('delete', { id }, terminal(ctx));

    expect(deleted).toEqual({
      ok: true,
      result: {
        id,
        deleted: true,
        blocked_by_stripped: expect.arrayContaining([
          { id: blocked, blocked_by: [other] },
          { id: closed, blocked_by: [] },
        ]),
      },
    });
    expect(deleted.ok && deleted.result.blocked_by_stripped).toHaveLength(2);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--count', `${before}..${tip}`])).toBe('1');
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(/^Grimoire-Op: delete$/m);
    const tree = (await world.a.git(['ls-tree', '-r', '--name-only', tip])).split('\n');
    expect(tree.some((file) => file.startsWith(`issues/${id[3]}/${id[4]}/${id}/`))).toBe(false);
    expect(tree).toEqual(
      expect.arrayContaining([`attempts/${id[3]}/${id[4]}/${id}/${attempt}/end.md`, `outcomes/${id[3]}/${id[4]}/${id}/${attempt}.md`]),
    );
    expect(await trackerFile(world.a, tip, `deleted/${id}.md`)).toBe('---\nby: "alice@example.com"\nat: "2026-10-11T03:15:08.750Z"\n---\n');
    expect(await core.call('show', { ref: blocked }, ctx)).toMatchObject({ ok: true, result: { blocked_by: [other] } });
  });

  test('show answers “deleted”, and writes naming the id say so too', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Doomed' });
    await core.call('delete', { id }, dashboard(ctx));

    const shown = await core.call('show', { ref: id }, ctx);
    const linked = await core.call('show', { ref: `see https://forge.example/x/${id}` }, ctx);
    const write = await core.call('comment', { id, body: 'too late' }, ctx);

    for (const outcome of [shown, linked, write]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: expect.stringContaining('was deleted'),
          details: { ref: id, deleted: { by: 'alice@example.com', at: '2026-10-11T03:15:08.750Z' } },
        },
      });
    }
  });

  test('is refused with any sub-issue, open or closed, or with an open attempt', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Parent' });
    const kid = await createIssue(core, ctx, { title: 'Closed kid', parent });
    await core.call('close', { id: kid, reason: 'done' }, { ...ctx, surface: 'cli', evidence: {} });
    const held = await createIssue(core, ctx, { title: 'Held' });
    const attempt = await claim(core, ctx, held);

    const [withKid, withAttempt] = await expectRefUnmoved(world.a, async () => [
      await core.call('delete', { id: parent }, terminal(ctx)),
      await core.call('delete', { id: held }, terminal(ctx)),
    ]);

    expect(withKid).toMatchObject({ ok: false, error: { code: 'INVALID', details: { sub_issues: [kid] } } });
    expect(withAttempt).toMatchObject({ ok: false, error: { code: 'ATTEMPT_OPEN', details: { attempt } } });
  });

  test('the id is never reissued by create', async ({ grimoire }) => {
    const { ctx } = grimoire;
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('d0med', 'd0med', 'fresh') });
    expect(await createIssue(core, ctx, { title: 'First' })).toBe('gr-d0med');
    expect(await core.call('delete', { id: 'gr-d0med' }, terminal(ctx))).toMatchObject({ ok: true, result: { deleted: true } });

    const next = await core.call('create', { title: 'Second' }, ctx);

    expect(next).toEqual({ ok: true, result: { id: 'gr-fresh', created: true } });
  });
});

describe('outcome overrides', () => {
  test('need a reason, and record the human’s verdict', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Judged' });
    const attempt = await claim(core, ctx, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);

    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('outcome_set', { attempt, verdict: 'fail' }, terminal(ctx)),
      await core.call('outcome_set', { attempt, verdict: 'fail', reason: ' ' }, terminal(ctx)),
    ]);
    const set = await core.call('outcome_set', { attempt, verdict: 'fail', reason: 'tests were skipped' }, dashboard(ctx));

    for (const outcome of refused) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { reason: expect.any(String) } } } });
    }
    expect(set).toEqual({
      ok: true,
      result: {
        attempt,
        issue: id,
        verdict: 'fail',
        reason: 'tests were skipped',
        set_by: 'human:alice@example.com',
        at: '2026-10-11T03:15:08.750Z',
      },
    });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { past_attempts: [{ attempt, outcome: { verdict: 'fail', reason: 'tests were skipped', set_by: 'human:alice@example.com' } }] },
    });
    const tip = (await trackerTip(world.a))!;
    const message = await world.a.git(['log', '-1', '--format=%B', tip]);
    expect(message).toMatch(/^Grimoire-Actor: \{"kind":"human","client":"dashboard",/m);
    // Trailer ops are hyphenated, like skill-edit and wiki-edit (spec §3, Commits).
    expect(message).toMatch(/^Grimoire-Op: outcome-set$/m);
  });

  test('an open attempt has no outcome to override, and an unknown handle is NOT_FOUND', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Working' });
    const attempt = await claim(core, ctx, id);

    const [open, unknown] = await expectRefUnmoved(world.a, async () => [
      await core.call('outcome_set', { attempt, verdict: 'pass', reason: 'r' }, terminal(ctx)),
      await core.call('outcome_set', { attempt: 'at-zzzzzz', verdict: 'pass', reason: 'r' }, terminal(ctx)),
    ]);

    expect(open).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('outcome overrides across clones', () => {
  test('a human’s override beats grimoire’s later verdict in a fold', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const laterCore = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 60_000) });
    const bob = terminal(agentContext(world.b));
    const id = await createIssue(core, alice, { title: 'Judged twice' });
    const attempt = await claim(core, alice, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    // On b, a human rules the attempt "none"; on a, a later reopen flips grimoire's pass to fail.
    expect(await core.call('outcome_set', { attempt, verdict: 'none', reason: 'the task was withdrawn' }, bob)).toMatchObject({ ok: true });
    expect(await laterCore.call('reopen', { id, comment: 'Needs another look.' }, terminal(alice))).toMatchObject({
      ok: true,
      result: { outcome: { attempt, from: 'pass', to: 'fail' } },
    });
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const shown = await core.call('show', { ref: id }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: {
        status: 'open',
        past_attempts: [{ attempt, outcome: { verdict: 'none', reason: 'the task was withdrawn', set_by: 'human:bob@example.com' } }],
      },
    });
  });
});
