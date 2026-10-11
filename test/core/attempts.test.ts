import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { runCommand } from '#harness';
import { createScanner } from '../../src/scanner';
import { MachineLocalStore } from '../../src/machine-local';
import type { CallContext, Core } from '../../src/core';
import {
  agentContext,
  bundleCallProcess,
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  issuePath,
  T0,
  trackerFile,
  trackerTip,
} from './support';

const HANDLE = /^at-[0-9a-hjkmnp-tv-z]{6}$/;

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

/** An issue record as another writer would commit it. */
function rawIssue(id: string, fields: { seq: number; status?: string; parent?: string | null; title?: string }): string {
  return [
    '---',
    `id: "${id}"`,
    `seq: ${fields.seq}`,
    `title: ${JSON.stringify(fields.title ?? 'Raw')}`,
    `status: "${fields.status ?? 'open'}"`,
    'labels: []',
    `parent: ${JSON.stringify(fields.parent ?? null)}`,
    'blocked_by: []',
    'links: []',
    'created_at: "2026-01-01T00:00:00.000Z"',
    'created_by: "carol@example.com"',
    'updated_at: "2026-01-01T00:00:00.000Z"',
    '---',
    '',
  ].join('\n');
}

/** The sharded attempt directory (spec §3 Layout). */
function attemptPath(issue: string, attempt: string): string {
  return `attempts/${issue[3]}/${issue[4]}/${issue}/${attempt}`;
}

describe('claim', () => {
  test('opens an attempt in one commit: start.md, and issue-at-start.md as the same blob as the issue', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Work me', body: 'Body\n' });
    const before = await trackerTip(world.a);

    const claimed = await core.call('claim', { id }, ctx);

    expect(claimed).toEqual({
      ok: true,
      result: { id, attempt: expect.stringMatching(HANDLE), since: T0.toISOString() },
    });
    const attempt = claimed.ok ? claimed.result.attempt : '';
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${before}`);
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(
      new RegExp(`^grimoire: claim ${id}\\n\\n[^]*Grimoire-Op: claim\\nGrimoire-Issue: ${id}\\nGrimoire-Attempt: ${attempt}\\n`),
    );
    const dir = attemptPath(id, attempt);
    expect(await world.a.git(['ls-tree', '--name-only', `${tip}:${dir}`])).toBe('issue-at-start.md\nstart.md');
    expect(await world.a.git(['rev-parse', `${tip}:${dir}/issue-at-start.md`])).toBe(
      await world.a.git(['rev-parse', `${tip}:${issuePath(id)}`]),
    );
    const start = await trackerFile(world.a, tip, `${dir}/start.md`);
    expect(start).toMatch(/^assignee: "alice@example.com"$/m);
    expect(start).toMatch(/^opened: "claim"$/m);
    expect(start).toMatch(new RegExp(`^at: "${T0.toISOString()}"$`, 'm'));
    expect(start).toMatch(new RegExp(`^start_commit: "${before}"$`, 'm'));
    expect(start).toMatch(/^actor: \{"person":"alice@example.com","kind":"agent","client":"claude-code",/m);
  });

  test('an issue with an open attempt refuses every claim, yours included, with ALREADY_CLAIMED and the attempt', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Taken' });
    const attempt = await claim(core, ctx, id);
    const bobCtx = agentContext(world.b);
    const bob = { ...bobCtx, repo: ctx.repo, client: { name: 'codex-mcp-client' } };

    const mine = await expectRefUnmoved(world.a, () => core.call('claim', { id }, { ...ctx, nonce: 'nonce-2' }));
    const theirs = await expectRefUnmoved(world.a, () => core.call('claim', { id }, bob));

    const open = {
      attempt,
      assignee: 'alice@example.com',
      since: T0.toISOString(),
      last_activity_at: T0.toISOString(),
      clients_seen: ['claude-code'],
    };
    expect(mine).toEqual({
      ok: false,
      error: {
        code: 'ALREADY_CLAIMED',
        message: expect.stringContaining(attempt),
        retryable: false,
        details: { open_attempts: [{ ...open, held_by_you: true }] },
      },
    });
    expect(theirs).toMatchObject({
      ok: false,
      error: { code: 'ALREADY_CLAIMED', details: { open_attempts: [{ ...open, held_by_you: false }] } },
    });
  });

  test('only an open issue with no open sub-issue can be claimed; blockers are not checked', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const blocker = await createIssue(core, ctx, { title: 'Blocker' });
    const parent = await createIssue(core, ctx, { title: 'Parent', blocked_by: [blocker] });
    await createIssue(core, ctx, { title: 'Child', parent });
    const closed = 'gr-c105e';
    await commitToTracker(world.a, { [issuePath(closed)]: rawIssue(closed, { seq: 9, status: 'done' }) });

    const onParent = await expectRefUnmoved(world.a, () => core.call('claim', { id: parent }, ctx));
    const onClosed = await expectRefUnmoved(world.a, () => core.call('claim', { id: closed }, ctx));
    const onBlocked = await core.call('claim', { id: blocker }, ctx);

    expect(onParent).toMatchObject({ ok: false, error: { code: 'HAS_OPEN_CHILDREN', retryable: false } });
    expect(onClosed).toMatchObject({ ok: false, error: { code: 'NOT_OPEN', retryable: false } });
    expect(onBlocked).toMatchObject({ ok: true });
    const blocked = await createIssue(core, ctx, { title: 'Blocked', blocked_by: [parent] });
    expect(await core.call('claim', { id: blocked }, ctx)).toMatchObject({ ok: true });
  });
});

describe('claims across processes', () => {
  let caller: { script: string; cleanup: () => Promise<void> };
  beforeAll(async () => {
    caller = await bundleCallProcess();
  });
  afterAll(async () => {
    await caller.cleanup();
  });

  test('two processes of the same person claim at once: exactly one gets a handle, the other ALREADY_CLAIMED held by you', async ({
    world,
    grimoire,
  }) => {
    for (let round = 0; round < 3; round++) {
      const id = await createIssue(grimoire.core, grimoire.ctx, { title: `Race ${round}` });
      const calls = JSON.stringify([['claim', { id }]]);

      const runs = await Promise.all(
        [0, 1].map(() => runCommand(process.execPath, [caller.script, world.a.dir, 'ann', calls], { timeoutMs: 60_000 })),
      );

      for (const run of runs) expect(run.stderr).toBe('');
      const outcomes = runs.flatMap((run) => JSON.parse(run.stdout) as { ok: boolean; result?: { attempt: string } }[]);
      const won = outcomes.filter((o) => o.ok);
      expect(won).toHaveLength(1);
      expect(outcomes.find((o) => !o.ok)).toMatchObject({
        ok: false,
        error: {
          code: 'ALREADY_CLAIMED',
          details: { open_attempts: [{ attempt: won[0]!.result!.attempt, assignee: 'ann@example.com', held_by_you: true }] },
        },
      });
      const shown = await grimoire.core.call('show', { ref: id }, grimoire.ctx);
      expect(shown).toMatchObject({ ok: true, result: { open_attempts: [{ attempt: won[0]!.result!.attempt }] } });
    }
  }, 120_000);
});

const DEBRIEF = {
  asked: 'Fix the login redirect',
  tried: 'Patched the router guard',
  failed: 'none',
  worked: 'Reordering the middleware',
  next: 'Add a test for the logout path',
};

function commentsDir(id: string): string {
  return issuePath(id).replace(/issue\.md$/, 'comments');
}

describe('close', () => {
  test('close {done, attempt, comment, debrief, parent_patch} is one commit: parent patched, pass, assignee cleared, last_assignee set', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Map', body: '## Tasks\n- [ ] child\n' });
    const id = await createIssue(core, ctx, { title: 'Child', parent });
    const attempt = await claim(core, ctx, id);
    const before = await trackerTip(world.a);

    const closed = await core.call(
      'close',
      {
        id,
        reason: 'done',
        attempt,
        comment: 'Merged in abc123',
        debrief: DEBRIEF,
        parent_patch: [{ op: 'replace', anchor: '- [ ] child', text: '- [x] child' }],
      },
      ctx,
    );

    expect(closed).toEqual({ ok: true, result: { id, attempt, ended: 'done', outcome: 'pass' } });
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${before}`);
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(
      new RegExp(`^grimoire: close ${id}\n\n[^]*Grimoire-Op: close\nGrimoire-Issue: ${id}\nGrimoire-Attempt: ${attempt}\n`),
    );
    expect(await trackerFile(world.a, tip, issuePath(parent))).toMatch(/\n---\n## Tasks\n- \[x\] child\n$/);
    expect(await trackerFile(world.a, tip, issuePath(id))).toMatch(/^status: "done"$/m);

    const names = (await world.a.git(['ls-tree', '--name-only', `${tip}:${commentsDir(id)}`])).split('\n');
    expect(names).toHaveLength(2);
    const [comment, debrief] = await Promise.all(names.map((n) => trackerFile(world.a, tip, `${commentsDir(id)}/${n}`)));
    expect(comment).toMatch(/^kind: "comment"$/m);
    expect(comment).toMatch(new RegExp(`^attempt: "${attempt}"$`, 'm'));
    expect(comment!.endsWith('\n---\nMerged in abc123')).toBe(true);
    expect(debrief).toMatch(/^kind: "debrief"$/m);
    expect(debrief).toMatch(new RegExp(`^attempt: "${attempt}"$`, 'm'));
    expect(debrief!.split('\n---\n')[1]).toBe(
      '## Asked\nFix the login redirect\n\n## Tried\nPatched the router guard\n\n## Failed\nnone\n\n' +
        '## Worked\nReordering the middleware\n\n## Next\nAdd a test for the logout path\n',
    );

    const dir = attemptPath(id, attempt);
    const end = await trackerFile(world.a, tip, `${dir}/end.md`);
    expect(end).toMatch(/^ended: "done"$/m);
    expect(end).toMatch(/^ended_by: \{"person":"alice@example.com","kind":"agent",/m);
    expect(end).toMatch(new RegExp(`^debrief: "${names[1]!.replace(/\.md$/, '')}"$`, 'm'));
    expect(end).toMatch(/^worker_kind: "agent"$/m);
    expect(end).toMatch(/^field_changes: \["status"\]$/m);
    const outcome = await trackerFile(world.a, tip, `outcomes/${id[3]}/${id[4]}/${id}/${attempt}.md`);
    expect(outcome).toBe(
      `---\nverdict: "pass"\nreason: "done"\nset_by: "grimoire"\nat: "${T0.toISOString()}"\n---\n`,
    );
    // The trace keeps the comments made during the attempt: the same blobs.
    for (const name of names) {
      expect(await world.a.git(['rev-parse', `${tip}:${dir}/activity/${name}`])).toBe(
        await world.a.git(['rev-parse', `${tip}:${commentsDir(id)}/${name}`]),
      );
    }

    const shown = await core.call('show', { ref: id }, ctx);
    expect(shown).toMatchObject({
      ok: true,
      result: {
        status: 'done',
        assignee: null,
        open_attempts: [],
        last_assignee: 'alice@example.com',
        past_attempts: [
          {
            attempt,
            assignee: 'alice@example.com',
            opened: 'claim',
            since: T0.toISOString(),
            ended: 'done',
            ended_at: T0.toISOString(),
            ended_by: 'alice@example.com',
            worker_kind: 'agent',
            outcome: { verdict: 'pass', set_by: 'grimoire', at: T0.toISOString() },
            debrief: names[1]!.replace(/\.md$/, ''),
          },
        ],
      },
    });
  });
});

/** A CLI context with no agent marker: a human actor. */
function humanContext(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {} };
}

async function debriefOf(world: { a: import('#harness').Clone }, id: string): Promise<string> {
  const tip = (await trackerTip(world.a))!;
  const names = (await world.a.git(['ls-tree', '--name-only', `${tip}:${commentsDir(id)}`])).split('\n');
  for (const name of names) {
    const file = await trackerFile(world.a, tip, `${commentsDir(id)}/${name}`);
    if (/^kind: "debrief"$/m.test(file)) return file.split('\n---\n')[1]!;
  }
  throw new Error(`no debrief on ${id}`);
}

describe('debriefs', () => {
  test('an agent closing as done, claimed or not, or releasing, without a debrief gets DEBRIEF_REQUIRED', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const claimed = await createIssue(core, ctx, { title: 'Claimed' });
    const attempt = await claim(core, ctx, claimed);
    const unclaimed = await createIssue(core, ctx, { title: 'Unclaimed' });

    const outcomes = await expectRefUnmoved(world.a, async () => [
      await core.call('close', { id: claimed, reason: 'done', attempt }, ctx),
      await core.call('close', { id: unclaimed, reason: 'done' }, ctx),
      await core.call('release', { id: claimed, attempt }, ctx),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'DEBRIEF_REQUIRED', retryable: false } });
    }
  });

  test('a debrief is optional for a canceled close and for humans', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const canceled = await createIssue(core, ctx, { title: 'Duplicate' });
    const byHuman = await createIssue(core, ctx, { title: 'By hand' });

    expect(await core.call('close', { id: canceled, reason: 'canceled', comment: 'Duplicate of another' }, ctx)).toMatchObject({
      ok: true,
      result: { ended: 'canceled', outcome: 'none' },
    });
    expect(await core.call('close', { id: byHuman, reason: 'done' }, humanContext(ctx))).toMatchObject({
      ok: true,
      result: { ended: 'done', outcome: 'pass' },
    });
  });

  test('every debrief field must hold text, and all five at most 4,000 characters', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Strict' });
    const attempt = await claim(core, ctx, id);

    const [empty, blank, missing, long] = await expectRefUnmoved(world.a, async () => [
      await core.call('close', { id, reason: 'done', attempt, debrief: { ...DEBRIEF, failed: '' } }, ctx),
      await core.call('close', { id, reason: 'done', attempt, debrief: { ...DEBRIEF, next: ' \n' } }, ctx),
      await core.call('close', { id, reason: 'done', attempt, debrief: { asked: 'x', tried: 'y' } }, ctx),
      await core.call(
        'close',
        { id, reason: 'done', attempt, debrief: { ...DEBRIEF, tried: 'a'.repeat(1000), worked: 'b'.repeat(3000) } },
        ctx,
      ),
    ]);

    expect(empty).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { 'debrief.failed': expect.any(String) } } } });
    expect(blank).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { 'debrief.next': expect.any(String) } } } });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { 'debrief.failed': 'is required', 'debrief.worked': 'is required' } } },
    });
    expect(long).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { debrief: expect.stringContaining('4,000') } } } });
    const exactly = { asked: 'a'.repeat(3996), tried: 'b', failed: 'c', worked: 'd', next: 'e' };
    expect(await core.call('close', { id, reason: 'done', attempt, debrief: exactly }, ctx)).toMatchObject({ ok: true });
  });

  test('a secret in a debrief is stored as its rule marker', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Leaky' });
    const attempt = await claim(core, ctx, id);
    const token = 'ghp_R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u';

    const closed = await core.call(
      'close',
      { id, reason: 'done', attempt, debrief: { ...DEBRIEF, tried: `export GH=${token} then pushed` } },
      ctx,
    );

    expect(closed).toMatchObject({ ok: true });
    const debrief = await debriefOf(world, id);
    expect(debrief).toContain('## Tried\nexport GH=[REDACTED:github-pat] then pushed\n');
    expect(debrief).not.toContain(token);
  });

  test('a debrief field the scanner cannot scan is dropped, and the close still lands', async ({ world, grimoire }) => {
    const core = grimoire.makeCore({ scanner: createScanner([]) });
    const id = await createIssue(core, grimoire.ctx, { title: 'Unscannable' });
    const attempt = await claim(core, grimoire.ctx, id);

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, grimoire.ctx);

    expect(closed).toMatchObject({ ok: true, result: { outcome: 'pass' } });
    const debrief = await debriefOf(world, id);
    expect(debrief).not.toContain(DEBRIEF.asked);
    expect(debrief).toContain('## Asked\n[dropped: the secret scanner could not run]\n');
  });
});

describe('release', () => {
  test('a release with a debrief ends the attempt as a fail and frees the issue for the next claim', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Too hard' });
    const attempt = await claim(core, ctx, id);

    const released = await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx);

    expect(released).toEqual({ ok: true, result: { id, attempt, ended: 'release', outcome: 'fail' } });
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(
      new RegExp(`Grimoire-Op: release\nGrimoire-Issue: ${id}\nGrimoire-Attempt: ${attempt}\n`),
    );
    expect(await trackerFile(world.a, tip, issuePath(id))).toMatch(/^status: "open"$/m);
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { assignee: null, open_attempts: [], ready: true, last_assignee: 'alice@example.com' },
    });
    expect(await core.call('claim', { id }, ctx)).toMatchObject({ ok: true });
  });

  test('release {abandoned} on your own person’s attempt needs no debrief, binds nothing, and gives a fail', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Dead session' });
    const attempt = await claim(core, ctx, id);
    const otherSession = { ...ctx, evidence: { session: 'sess-2', context: 'main' }, nonce: 'nonce-2' };

    const released = await core.call('release', { id, attempt, abandoned: true }, otherSession);

    expect(released).toEqual({ ok: true, result: { id, attempt, ended: 'release-abandoned', outcome: 'fail' } });
    const tip = (await trackerTip(world.a))!;
    const message = await world.a.git(['log', '-1', '--format=%B', tip]);
    expect(message).toMatch(/Grimoire-Op: release\n/);
    expect(message).not.toMatch(/Grimoire-Attempt:/);
    expect(await trackerFile(world.a, tip, `${attemptPath(id, attempt)}/end.md`)).toMatch(/^ended: "release-abandoned"$/m);
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { past_attempts: [{ attempt, ended: 'release-abandoned', outcome: { verdict: 'fail' } }] },
    });
  });

  test('an abandoned release takes no debrief', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Dead session' });
    const attempt = await claim(core, ctx, id);

    const released = await expectRefUnmoved(world.a, () =>
      core.call('release', { id, attempt, abandoned: true, debrief: DEBRIEF }, ctx),
    );

    expect(released).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { debrief: expect.any(String) } } } });
  });

  test('from an agent surface, another person’s attempt gives NOT_ASSIGNEE; a human may release it as abandoned', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Bob’s' });
    const bob = { ...agentContext(world.b), repo: ctx.repo };
    const attempt = await claim(core, bob, id);

    const attempts = await expectRefUnmoved(world.a, async () => [
      await core.call('release', { id, attempt, abandoned: true }, ctx),
      await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx),
      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx),
      await core.call('release', { id, attempt }, humanContext(ctx)),
    ]);
    for (const outcome of attempts) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE', retryable: false } });
    }

    const dashboard: CallContext = { ...ctx, surface: 'dashboard', client: null, evidence: {} };
    const released = await core.call('release', { id, attempt, abandoned: true }, dashboard);
    expect(released).toMatchObject({ ok: true, result: { ended: 'release-abandoned', outcome: 'fail' } });
    const end = await trackerFile(world.a, (await trackerTip(world.a))!, `${attemptPath(id, attempt)}/end.md`);
    expect(end).toMatch(/^ended_by: \{"person":"alice@example.com","kind":"human","client":"dashboard",/m);
  });
});

async function commitsWithOp(world: { a: import('#harness').Clone }, op: string): Promise<number> {
  const log = await world.a.git(['log', '--format=%B%x00', (await trackerTip(world.a))!]);
  return log.split('\0').filter((message) => message.includes(`\nGrimoire-Op: ${op}\n`)).length;
}

describe('naming the open handle', () => {
  test('closing a claimed issue without naming the open handle gives ATTEMPT_OPEN with the handle, yours or not', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const mine = await createIssue(core, ctx, { title: 'Mine' });
    const myAttempt = await claim(core, ctx, mine);
    const theirs = await createIssue(core, ctx, { title: 'Theirs' });
    const theirAttempt = await claim(core, { ...agentContext(world.b), repo: ctx.repo }, theirs);

    const [onMine, onTheirs] = await expectRefUnmoved(world.a, async () => [
      await core.call('close', { id: mine, reason: 'done', debrief: DEBRIEF }, ctx),
      await core.call('close', { id: theirs, reason: 'canceled' }, humanContext(ctx)),
    ]);

    expect(onMine).toMatchObject({ ok: false, error: { code: 'ATTEMPT_OPEN', details: { attempt: myAttempt } } });
    expect(onTheirs).toMatchObject({ ok: false, error: { code: 'ATTEMPT_OPEN', details: { attempt: theirAttempt } } });
  });

  test('ending an earlier, ended handle while you hold a newer one gives ATTEMPT_OPEN', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Twice' });
    const first = await claim(core, ctx, id);
    await core.call('release', { id, attempt: first, debrief: DEBRIEF }, ctx);
    const second = await claim(core, ctx, id);

    const closed = await expectRefUnmoved(world.a, () =>
      core.call('close', { id, reason: 'done', attempt: first, debrief: DEBRIEF }, ctx),
    );

    expect(closed).toMatchObject({ ok: false, error: { code: 'ATTEMPT_OPEN', details: { attempt: second } } });
  });

  test('a handle that names no attempt on the issue gives NOT_ASSIGNEE, a malformed one INVALID', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'One' });
    const other = await createIssue(core, ctx, { title: 'Two' });
    const attempt = await claim(core, ctx, other);

    const [elsewhere, unknown, malformed] = await expectRefUnmoved(world.a, async () => [
      await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx),
      await core.call('release', { id, attempt: 'at-zzzzzz', debrief: DEBRIEF }, ctx),
      await core.call('release', { id, attempt: 'gr-12345', debrief: DEBRIEF }, ctx),
    ]);

    expect(elsewhere).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE' } });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE' } });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { attempt: expect.any(String) } } } });
  });
});

describe('unclaimed close', () => {
  test('opens and seals an instant attempt in one commit, and a retry by the same person and reason replays', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Quick fix' });
    const before = await trackerTip(world.a);

    const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx);

    expect(closed).toEqual({
      ok: true,
      result: { id, attempt: expect.stringMatching(HANDLE), ended: 'done', outcome: 'pass' },
    });
    const attempt = closed.ok ? closed.result.attempt : '';
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${before}`);
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(new RegExp(`Grimoire-Attempt: ${attempt}\\n`));
    const dir = attemptPath(id, attempt);
    expect(await trackerFile(world.a, tip, `${dir}/start.md`)).toMatch(/^opened: "unclaimed-close"$/m);
    expect(await trackerFile(world.a, tip, `${dir}/end.md`)).toMatch(/^ended: "done"$/m);
    // The issue as it stood when the attempt opened: still open.
    expect(await trackerFile(world.a, tip, `${dir}/issue-at-start.md`)).toMatch(/^status: "open"$/m);
    expect(await trackerFile(world.a, tip, issuePath(id))).toMatch(/^status: "done"$/m);

    const retried = await expectRefUnmoved(world.a, () => core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx));

    expect(retried).toEqual({ ok: true, result: { id, attempt, ended: 'done', outcome: 'pass', replayed: true } });
    expect(await commitsWithOp(world, 'close')).toBe(1);
  });

  test('a retry by another person, or with another reason, gives NOT_OPEN', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Closed once' });
    await core.call('close', { id, reason: 'canceled' }, ctx);
    const bob = { ...agentContext(world.b), repo: ctx.repo };

    const [otherPerson, otherReason] = await expectRefUnmoved(world.a, async () => [
      await core.call('close', { id, reason: 'canceled' }, bob),
      await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx),
    ]);

    expect(otherPerson).toMatchObject({ ok: false, error: { code: 'NOT_OPEN' } });
    expect(otherReason).toMatchObject({ ok: false, error: { code: 'NOT_OPEN' } });
  });

  test('a close without a handle on an issue a claimed attempt closed gives NOT_OPEN', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Claimed then closed' });
    const attempt = await claim(core, ctx, id);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);

    const retried = await expectRefUnmoved(world.a, () => core.call('close', { id, reason: 'done', debrief: DEBRIEF }, ctx));

    expect(retried).toMatchObject({ ok: false, error: { code: 'NOT_OPEN' } });
  });
});

describe('replays', () => {
  test('replaying an ending call on (attempt, reason) gives replayed: true, and exactly one commit exists', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Map', body: '- [ ] a\n- [ ] b\n' });
    const closing = await createIssue(core, ctx, { title: 'A', parent });
    const releasing = await createIssue(core, ctx, { title: 'B', parent });
    const closeAttempt = await claim(core, ctx, closing);
    const releaseAttempt = await claim(core, ctx, releasing);
    const closeCall = {
      id: closing,
      reason: 'done',
      attempt: closeAttempt,
      comment: 'Done',
      debrief: DEBRIEF,
      parent_patch: [{ op: 'replace', anchor: '- [ ] a', text: '- [x] a' }],
    };
    const releaseCall = { id: releasing, attempt: releaseAttempt, debrief: DEBRIEF };
    await core.call('close', closeCall, ctx);
    await core.call('release', releaseCall, ctx);

    const [closedAgain, releasedAgain] = await expectRefUnmoved(world.a, async () => [
      await core.call('close', closeCall, ctx),
      await core.call('release', releaseCall, ctx),
    ]);

    expect(closedAgain).toEqual({
      ok: true,
      result: { id: closing, attempt: closeAttempt, ended: 'done', outcome: 'pass', replayed: true },
    });
    expect(releasedAgain).toEqual({
      ok: true,
      result: { id: releasing, attempt: releaseAttempt, ended: 'release', outcome: 'fail', replayed: true },
    });
    expect(await commitsWithOp(world, 'close')).toBe(1);
    expect(await commitsWithOp(world, 'release')).toBe(1);
  });

  test('ending an ended attempt another way gives NOT_ASSIGNEE: nobody holds it any more', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Released' });
    const attempt = await claim(core, ctx, id);
    await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx);

    const closed = await expectRefUnmoved(world.a, () =>
      core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx),
    );

    expect(closed).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE' } });
  });
});

describe('reads', () => {
  test('ready and list exclude claimed issues; rows carry the assignee and the open attempts', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const taken = await createIssue(core, ctx, { title: 'Taken' });
    const free = await createIssue(core, ctx, { title: 'Free' });
    const attempt = await claim(core, ctx, taken);
    const ids = async (input: Record<string, unknown>) => {
      const listed = await core.call('list', input, ctx);
      if (!listed.ok) throw new Error(JSON.stringify(listed.error));
      return listed.result.rows.map((row) => row.id);
    };

    expect(await ids({ ready: true })).toEqual([free]);
    expect(await ids({ view: 'ready' })).toEqual([free]);
    expect(await ids({ view: 'claimed' })).toEqual([taken]);
    expect(await ids({ assignee: 'me' })).toEqual([taken]);
    expect(await ids({ assignee: 'alice@example.com' })).toEqual([taken]);
    expect(await ids({ assignee: 'none' })).toEqual([free]);
    expect(await ids({ assignee: world.b.identity.email })).toEqual([]);
    const listed = await core.call('list', { view: 'claimed' }, ctx);
    expect(listed).toMatchObject({
      ok: true,
      result: {
        rows: [
          {
            id: taken,
            assignee: 'alice@example.com',
            ready: false,
            open_attempts: [
              {
                attempt,
                assignee: 'alice@example.com',
                since: T0.toISOString(),
                last_activity_at: T0.toISOString(),
                clients_seen: ['claude-code'],
                held_by_you: true,
                stale: false,
              },
            ],
          },
        ],
      },
    });
  });

  test('an open attempt with no activity past the machine’s stale threshold (default 24h) is stale', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Forgotten' });
    await claim(core, ctx, id);
    const later = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 25 * 3600_000) });

    expect(await later.call('list', { view: 'stale' }, ctx)).toMatchObject({ ok: true, result: { rows: [{ id }] } });
    expect(await later.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { open_attempts: [{ stale: true }] },
    });
    expect(await core.call('list', { view: 'stale' }, ctx)).toMatchObject({ ok: true, result: { rows: [] } });

    await new MachineLocalStore(path.join(world.a.dir, '.git')).records.write('machine-settings', 'dashboard.stale_after', '48h');

    expect(await later.call('list', { view: 'stale' }, ctx)).toMatchObject({ ok: true, result: { rows: [] } });
  });

  test('last activity follows the writes on the issue; clients seen are those of the writes that named the handle', async ({
    grimoire,
  }) => {
    const { ctx } = grimoire;
    let now = T0.getTime();
    const core = grimoire.makeCore({ clock: () => new Date(now) });
    const id = await createIssue(core, ctx, { title: 'Busy' });
    const attempt = await claim(core, ctx, id);
    const codex: CallContext = { ...ctx, client: { name: 'codex-mcp-client' }, nonce: 'nonce-codex' };
    const dashboard: CallContext = { ...ctx, surface: 'dashboard', client: null, evidence: {} };

    now += 60_000;
    expect(await core.call('comment', { id, body: 'Working on it', attempt }, codex)).toMatchObject({ ok: true });
    now += 60_000;
    expect(await core.call('update', { id, labels_add: ['wip'] }, dashboard)).toMatchObject({ ok: true });

    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: {
        open_attempts: [
          {
            attempt,
            last_activity_at: new Date(T0.getTime() + 120_000).toISOString(),
            clients_seen: ['claude-code', 'codex-mcp-client'],
          },
        ],
      },
    });
  });
});

describe('naming a handle on update and comment', () => {
  test('a write naming your open handle binds: it carries the Grimoire-Attempt trailer, and a comment records the handle', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Bound' });
    const attempt = await claim(core, ctx, id);

    const commented = await core.call('comment', { id, body: 'Progress', attempt }, ctx);
    const commentCommit = (await trackerTip(world.a))!;
    const updated = await core.call('update', { id, labels_add: ['wip'], attempt }, ctx);
    const updateCommit = (await trackerTip(world.a))!;

    expect(commented).toMatchObject({ ok: true, result: { attempt } });
    expect(updated).toMatchObject({ ok: true });
    for (const [commit, op] of [
      [commentCommit, 'comment'],
      [updateCommit, 'update'],
    ] as const) {
      expect(await world.a.git(['log', '-1', '--format=%B', commit])).toMatch(
        new RegExp(`Grimoire-Op: ${op}\\nGrimoire-Issue: ${id}\\nGrimoire-Attempt: ${attempt}\\n`),
      );
    }
    const name = commented.ok ? commented.result.id : '';
    expect(await trackerFile(world.a, updateCommit, `${commentsDir(id)}/${name}.md`)).toMatch(
      new RegExp(`^attempt: "${attempt}"$`, 'm'),
    );
  });

  test('writes that name no handle never carry the trailer, even on a claimed issue', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Unbound' });
    await claim(core, ctx, id);

    await core.call('comment', { id, body: 'Drive-by' }, ctx);
    const commentCommit = (await trackerTip(world.a))!;
    await core.call('update', { id, title: 'Renamed' }, ctx);

    for (const commit of [commentCommit, (await trackerTip(world.a))!]) {
      expect(await world.a.git(['log', '-1', '--format=%B', commit])).not.toMatch(/Grimoire-Attempt:/);
    }
  });

  test('naming a handle your person doesn’t hold gives NOT_ASSIGNEE', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Held by Bob' });
    const bobs = await claim(core, { ...agentContext(world.b), repo: ctx.repo }, id);
    const other = await createIssue(core, ctx, { title: 'Mine' });
    const mine = await claim(core, ctx, other);
    const ended = await createIssue(core, ctx, { title: 'Ended' });
    const old = await claim(core, ctx, ended);
    await core.call('release', { id: ended, attempt: old, debrief: DEBRIEF }, ctx);

    const outcomes = await expectRefUnmoved(world.a, async () => [
      await core.call('comment', { id, body: 'Hi', attempt: bobs }, ctx),
      await core.call('update', { id, title: 'Mine now', attempt: bobs }, ctx),
      await core.call('comment', { id, body: 'Wrong issue', attempt: mine }, ctx),
      await core.call('update', { id: ended, title: 'Late', attempt: old }, ctx),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE', retryable: false } });
    }
  });

  test('a close seals the field changes made during the attempt, and the worker kind of its binding writes', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const human = humanContext(ctx);
    const id = await createIssue(core, ctx, { title: 'By hand, then' });
    const attempt = await claim(core, human, id);
    await core.call('update', { id, title: 'Retitled', attempt }, human);
    // Another person's agent naming nothing changes neither the binding nor the worker kind.
    await core.call('update', { id, labels_add: ['seen'] }, { ...agentContext(world.b), repo: ctx.repo });

    const closed = await core.call('close', { id, reason: 'done', attempt }, human);

    expect(closed).toMatchObject({ ok: true });
    const end = await trackerFile(world.a, (await trackerTip(world.a))!, `${attemptPath(id, attempt)}/end.md`);
    expect(end).toMatch(/^worker_kind: "human"$/m);
    expect(end).toMatch(/^field_changes: \["labels","status","title"\]$/m);

    const agentWorked = await createIssue(core, ctx, { title: 'Agent helped' });
    const second = await claim(core, human, agentWorked);
    await core.call('comment', { id: agentWorked, body: 'On it', attempt: second }, ctx);
    await core.call('close', { id: agentWorked, reason: 'done', attempt: second }, human);
    const secondEnd = await trackerFile(world.a, (await trackerTip(world.a))!, `${attemptPath(agentWorked, second)}/end.md`);
    expect(secondEnd).toMatch(/^worker_kind: "agent"$/m);
  });
});

describe('claim replays', () => {
  test('a claim retried with its idempotency key replays the handle and makes no commit; another issue gives IDEMPOTENCY_MISMATCH', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Retry me' });
    const other = await createIssue(core, ctx, { title: 'Not this one' });
    const first = await core.call('claim', { id, idempotency_key: 'claim-1' }, ctx);

    const [again, elsewhere] = await expectRefUnmoved(world.a, async () => [
      await core.call('claim', { id, idempotency_key: 'claim-1' }, ctx),
      await core.call('claim', { id: other, idempotency_key: 'claim-1' }, ctx),
    ]);

    expect(first).toMatchObject({ ok: true, result: { attempt: expect.stringMatching(HANDLE) } });
    const attempt = first.ok ? first.result.attempt : '';
    expect(again).toEqual({ ok: true, result: { id, attempt, since: T0.toISOString(), replayed: true } });
    expect(elsewhere).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_MISMATCH' } });
    expect(await commitsWithOp(world, 'claim')).toBe(1);
  });
});

describe('parent_patch', () => {
  test('an anchor that misses, or an issue without a parent, fails the whole close', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Map', body: '- [ ] a\n' });
    const child = await createIssue(core, ctx, { title: 'A', parent });
    const orphan = await createIssue(core, ctx, { title: 'Orphan' });
    const attempt = await claim(core, ctx, child);
    const orphanAttempt = await claim(core, ctx, orphan);
    const patch = (anchor: string) => [{ op: 'replace', anchor, text: '- [x] a' }];

    const [missed, noParent] = await expectRefUnmoved(world.a, async () => [
      await core.call('close', { id: child, reason: 'done', attempt, debrief: DEBRIEF, parent_patch: patch('- [ ] b') }, ctx),
      await core.call(
        'close',
        { id: orphan, reason: 'done', attempt: orphanAttempt, debrief: DEBRIEF, parent_patch: patch('- [ ] a') },
        ctx,
      ),
    ]);

    expect(missed).toMatchObject({ ok: false, error: { code: 'ANCHOR_NOT_FOUND', details: { op: 0 } } });
    expect(noParent).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { parent_patch: expect.any(String) } } } });
  });

  test('a parent patch already in place is reported as a no-op, and the close still lands', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const parent = await createIssue(core, ctx, { title: 'Map', body: '- [x] a\n' });
    const child = await createIssue(core, ctx, { title: 'A', parent });
    const attempt = await claim(core, ctx, child);

    const closed = await core.call(
      'close',
      { id: child, reason: 'done', attempt, debrief: DEBRIEF, parent_patch: [{ op: 'append', text: '- [x] a\n' }] },
      ctx,
    );

    expect(closed).toMatchObject({
      ok: true,
      result: { outcome: 'pass', parent_noops: [{ field: 'parent_patch[0]', reason: 'text already present' }] },
    });
  });
});

describe('superseded', () => {
  test('ending your own handle on an issue another writer already closed seals it superseded, with outcome none', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = 'gr-5ap3r';
    await commitToTracker(world.a, { [issuePath(id)]: rawIssue(id, { seq: 1 }) });
    const attempt = await claim(core, ctx, id);
    // Another clone closed it; the fold brought the record in with the attempt still open.
    await commitToTracker(world.a, { [issuePath(id)]: rawIssue(id, { seq: 1, status: 'canceled' }) });

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx);
    const retried = await expectRefUnmoved(world.a, () =>
      core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx),
    );

    expect(closed).toEqual({ ok: true, result: { id, attempt, ended: 'superseded', outcome: 'none' } });
    expect(retried).toEqual({ ok: true, result: { id, attempt, ended: 'superseded', outcome: 'none', replayed: true } });
    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, issuePath(id))).toMatch(/^status: "canceled"$/m);
    expect(await trackerFile(world.a, tip, `${attemptPath(id, attempt)}/end.md`)).toMatch(/^ended: "superseded"$/m);
  });
});
