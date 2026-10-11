import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { agentContext, coreTest as test, expectRefUnmoved, trackerTip } from './support';

describe('error envelope: an error means nothing changed', () => {
  test.for([
    ['a missing title', {}, { title: 'is required' }],
    ['a blank title', { title: '   ' }, { title: 'must not be empty' }],
    ['a two-line title', { title: 'one\ntwo' }, { title: 'must be one line' }],
    ['a field nobody knows', { title: 'ok', priority: 1 }, { priority: 'is not a known field' }],
    ['a label that is not a string', { title: 'ok', labels: ['fine', 3] }, { 'labels[1]': 'must be a string' }],
    ['a body that is not valid Unicode', { title: 'ok', body: 'broken \uD800 text' }, { body: 'must be valid Unicode text' }],
  ] as const)('create with %s gives INVALID with field errors', async ([, input, fields], { world, grimoire }) => {
    const outcome = await expectRefUnmoved(world.a, () => grimoire.core.call('create', input, grimoire.ctx));

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'INVALID', message: expect.any(String), retryable: false, details: { fields } },
    });
  });

  test('a write without a git user.email gives NO_GIT_IDENTITY', async ({ world, grimoire }) => {
    const ctx = { ...grimoire.ctx, person: { name: 'Alice Example', email: null } };

    const outcome = await expectRefUnmoved(world.a, () => grimoire.core.call('create', { title: 'x' }, ctx));

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'NO_GIT_IDENTITY',
        message: expect.any(String),
        retryable: false,
        details: { name: 'Alice Example', email: null },
      },
    });
  });

  test('reads work without a git identity', async ({ grimoire }) => {
    const ctx = { ...grimoire.ctx, person: { name: null, email: null } };

    expect(await grimoire.core.call('labels', {}, ctx)).toEqual({ ok: true, result: { labels: [] } });
  });

  test('an unknown operation gives INVALID', async ({ grimoire }) => {
    const outcome = await grimoire.core.call('frobnicate', {}, grimoire.ctx);

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', retryable: false } });
  });

  test('without a tracker, reads and writes give NOT_SYNCED, never an empty answer', async ({ world, grimoire }) => {
    const ctx = agentContext(world.b);

    const read = await grimoire.core.call('labels', {}, ctx);
    const write = await grimoire.core.call('create', { title: 'x' }, ctx);

    expect(read).toMatchObject({ ok: false, error: { code: 'NOT_SYNCED', details: { remedy: expect.any(String) } } });
    expect(write).toMatchObject({ ok: false, error: { code: 'NOT_SYNCED' } });
    expect(await trackerTip(world.b)).toBeNull();
  });

  test('outside any git repository, calls give NO_REPO with the resolved root', async ({ grimoire }) => {
    const dir = await makeTempDir('grimoire-norepo-');
    try {
      const ctx = { ...grimoire.ctx, repo: { root: dir, pin: null } };

      const outcome = await grimoire.core.call('show', { ref: 'gr-zzzzz' }, ctx);

      expect(outcome).toMatchObject({ ok: false, error: { code: 'NO_REPO', details: { root: dir } } });
    } finally {
      await removeDir(dir);
    }
  });

  test('a directory inside a checkout is not a host repo root: NO_REPO, never the enclosing repo', async ({
    world,
    grimoire,
  }) => {
    const sub = path.join(world.a.dir, 'sub');
    await mkdir(sub);
    const ctx = { ...grimoire.ctx, repo: { root: sub, pin: null } };

    const outcome = await grimoire.core.call('labels', {}, ctx);

    expect(outcome).toMatchObject({ ok: false, error: { code: 'NO_REPO', details: { root: sub } } });
  });
});
