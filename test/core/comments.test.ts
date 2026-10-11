import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { coreTest as test, expectRefUnmoved, issuePath, trackerFile, trackerTip } from './support';

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

function commentsDir(id: string): string {
  return issuePath(id).replace(/issue\.md$/, 'comments');
}

const COMMENT_NAME = /^20261011T031508750Z-0-[0-9a-hjkmnp-tv-z]{4}$/;

describe('comment', () => {
  test('a comment is one commit adding one write-once file; the issue record and its revision are untouched', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Discuss', body: 'Body\n' });
    const before = await trackerTip(world.a);
    const shownBefore = await core.call('show', { ref: id }, ctx);
    const body = 'Looks good.\r\n\n  — Alice  \n';

    const commented = await core.call('comment', { id, body }, ctx);

    expect(commented).toEqual({
      ok: true,
      result: {
        id: expect.stringMatching(COMMENT_NAME),
        issue: id,
        at: '2026-10-11T03:15:08.750Z',
        kind: 'comment',
        actor: {
          person: 'alice@example.com',
          kind: 'agent',
          client: 'claude-code',
          session: 'sess-1',
          context: 'main',
          call: 'call-1',
          nonce: 'nonce-1',
        },
        body,
      },
    });
    const commentId = commented.ok ? commented.result.id : '';
    const after = await trackerTip(world.a);
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', after!])).toBe(`${after} ${before}`);
    expect(await world.a.git(['diff-tree', '-r', '--name-status', before!, after!])).toBe(
      `A\t${commentsDir(id)}/${commentId}.md`,
    );
    expect(await world.a.git(['log', '-1', '--format=%B', after!])).toMatch(
      new RegExp(`^grimoire: comment ${id}\\n\\n[^]*Grimoire-Op: comment\\nGrimoire-Issue: ${id}\\n`),
    );
    expect(await trackerFile(world.a, after!, `${commentsDir(id)}/${commentId}.md`)).toBe(
      [
        '---',
        'actor: {"person":"alice@example.com","kind":"agent","client":"claude-code","session":"sess-1","context":"main","call":"call-1","nonce":"nonce-1"}',
        'at: "2026-10-11T03:15:08.750Z"',
        'kind: "comment"',
        '---',
        body,
      ].join('\n'),
    );
    const shownAfter = await core.call('show', { ref: id }, ctx);
    expect(shownAfter.ok && shownAfter.result.revision).toBe(shownBefore.ok && shownBefore.result.revision);
  });

  test('comments on one issue get strictly increasing times even when the clock stands still', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Discuss' });

    const first = await core.call('comment', { id, body: 'first' }, ctx);
    const second = await core.call('comment', { id, body: 'second' }, ctx);
    const third = await core.call('comment', { id, body: 'third' }, ctx);

    expect([first, second, third].map((c) => (c.ok ? c.result.at : c.error.code))).toEqual([
      '2026-10-11T03:15:08.750Z',
      '2026-10-11T03:15:08.751Z',
      '2026-10-11T03:15:08.752Z',
    ]);
  });

  test('an idempotency key replays the stored comment without writing; reused for another body it gives IDEMPOTENCY_MISMATCH', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Discuss' });
    const first = await core.call('comment', { id, body: 'Once', idempotency_key: 'k-1' }, ctx);
    const tip = await trackerTip(world.a);

    const replay = await core.call('comment', { id, body: 'Once', idempotency_key: 'k-1' }, ctx);
    const mismatch = await core.call('comment', { id, body: 'Twice', idempotency_key: 'k-1' }, ctx);

    expect(first).toMatchObject({ ok: true, result: { body: 'Once' } });
    expect(replay).toEqual({ ok: true, result: { ...(first.ok ? first.result : {}), replayed: true } });
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_MISMATCH' } });
    expect(await trackerTip(world.a)).toBe(tip);
    const commentId = first.ok ? first.result.id : '';
    const file = await trackerFile(world.a, tip!, `${commentsDir(id)}/${commentId}.md`);
    expect(file).toContain(`key: "${createHash('sha256').update('k-1').digest('hex')}"\n`);
  });

  test.for([
    ['an unknown issue', 'NOT_FOUND', { id: 'gr-zzzzz', body: 'x' }],
    ['a blank body', 'INVALID', { id: 'gr-zzzzz', body: '  \n' }],
    ['a short id', 'INVALID', { id: 'gr-zz', body: 'x' }],
  ] as const)('%s gives %s and writes nothing', async ([, code, input], { world, grimoire }) => {
    const outcome = await expectRefUnmoved(world.a, () => grimoire.core.call('comment', input, grimoire.ctx));

    expect(outcome).toMatchObject({ ok: false, error: { code } });
  });

  test('a comment over ~24 KB is stored whole; its result and show stay under budget, cut well-formed with truncated', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Discuss' });
    const body = 'A long log line with “quotes” and \\ backslashes.\n'.repeat(1_000);

    const commented = await core.call('comment', { id, body }, ctx);
    const shown = await core.call('show', { ref: id }, ctx);

    expect(commented).toMatchObject({ ok: true, result: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(commented), 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(body.startsWith(commented.ok ? commented.result.body : 'x')).toBe(true);
    expect(shown).toMatchObject({ ok: true, result: { truncated: true, comments: [{ id: commented.ok ? commented.result.id : '' }] } });
    expect(Buffer.byteLength(JSON.stringify(shown), 'utf8')).toBeLessThanOrEqual(24 * 1024);
    const file = await trackerFile(world.a, (await trackerTip(world.a))!, `${commentsDir(id)}/${commented.ok ? commented.result.id : ''}.md`);
    expect(file.endsWith(`---\n${body}`)).toBe(true);
  });

  test('later writes never rewrite a comment: its blob stays byte for byte, and no op edits comments', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Discuss' });
    const commented = await core.call('comment', { id, body: 'Keep me' }, ctx);
    const path = `${commentsDir(id)}/${commented.ok ? commented.result.id : ''}.md`;
    const blobBefore = await world.a.git(['rev-parse', `${await trackerTip(world.a)}:${path}`]);

    await core.call('update', { id, title: 'Renamed', labels_add: ['x'] }, ctx);
    await core.call('comment', { id, body: 'Another' }, ctx);

    expect(await world.a.git(['rev-parse', `${await trackerTip(world.a)}:${path}`])).toBe(blobBefore);
    expect(core.ops.map((op) => op.name).filter((name) => /comment/.test(name))).toEqual(['comment']);
  });
});

describe('comments across processes', () => {
  let bundleDir = '';
  let child = '';

  beforeAll(async () => {
    bundleDir = await makeTempDir('grimoire-caller-');
    child = path.join(bundleDir, 'call-process.mjs');
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL('./call-process.ts', import.meta.url))],
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      define: { __GRIMOIRE_VERSION__: JSON.stringify('0.0.0-test') },
      logLevel: 'silent',
    });
  });
  afterAll(async () => {
    await removeDir(bundleDir);
  });

  test('concurrent comments from two processes all persist, in commit order, each file added once and never edited', async ({
    world,
    grimoire,
  }) => {
    const id = await createIssue(grimoire.core, grimoire.ctx, { title: 'Busy thread' });
    const COUNT = 8;
    const callsFor = (who: string) =>
      JSON.stringify(Array.from({ length: COUNT }, (_, i) => ['comment', { id, body: `${who} ${i}` }]));

    const runs = await Promise.all(
      ['ann', 'ben'].map((who) => runCommand(process.execPath, [child, world.a.dir, who, callsFor(who)], { timeoutMs: 60_000 })),
    );

    for (const run of runs) expect(run.stderr).toBe('');
    const outcomes = runs.flatMap((run) => JSON.parse(run.stdout) as { ok: boolean }[]);
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    const tip = (await trackerTip(world.a))!;
    const history = await world.a.git(['log', '--reverse', '--format=', '--name-status', tip, '--', commentsDir(id)]);
    const added = history.split('\n').filter(Boolean);
    expect(added).toHaveLength(2 * COUNT);
    expect(added.every((line) => line.startsWith('A\t'))).toBe(true);
    const inCommitOrder = added.map((line) => line.slice(2));
    expect([...inCommitOrder].sort()).toEqual(inCommitOrder);
    const bodies = await Promise.all(
      inCommitOrder.map(async (file) => (await trackerFile(world.a, tip, file)).split('\n---\n')[1]),
    );
    for (const who of ['ann', 'ben']) {
      expect(bodies.filter((b) => b!.startsWith(who))).toEqual(Array.from({ length: COUNT }, (_, i) => `${who} ${i}`));
    }
  }, 120_000);
});
