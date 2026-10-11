import { createHash } from 'node:crypto';
import { describe, expect } from 'vitest';
import { coreTest as test, expectRefUnmoved, trackerTip } from './support';

describe('create with an idempotency key', () => {
  test('a replay with the same key gives the same id with created: false, and makes no commit', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const input = { title: 'Retry me', body: 'first', idempotency_key: 'k-1' };
    const first = await core.call('create', input, ctx);
    const tip = await trackerTip(world.a);

    const replay = await core.call('create', { ...input, body: 'a different body' }, ctx);

    expect(first).toEqual({ ok: true, result: { id: expect.any(String), created: true } });
    expect(replay).toEqual({ ok: true, result: { id: first.ok && first.result.id, created: false } });
    expect(await trackerTip(world.a)).toBe(tip);
  });

  test('the key is honoured by another core process on the same clone', async ({ world, grimoire }) => {
    const first = await grimoire.core.call('create', { title: 'Once', idempotency_key: 'shared' }, grimoire.ctx);
    const other = grimoire.makeCore();

    const replay = await expectRefUnmoved(world.a, () =>
      other.call('create', { title: 'Once', idempotency_key: 'shared' }, grimoire.ctx),
    );

    expect(replay).toEqual({ ok: true, result: { id: first.ok && first.result.id, created: false } });
  });

  test('the same key with a different title gives IDEMPOTENCY_MISMATCH and changes nothing', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await core.call('create', { title: 'Original', idempotency_key: 'k-2' }, ctx);

    const mismatch = await expectRefUnmoved(world.a, () =>
      core.call('create', { title: 'Something else', idempotency_key: 'k-2' }, ctx),
    );

    expect(mismatch).toEqual({
      ok: false,
      error: { code: 'IDEMPOTENCY_MISMATCH', message: expect.any(String), retryable: false, details: {} },
    });
  });

  test('the same key with a different parent gives IDEMPOTENCY_MISMATCH', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const parent = await core.call('create', { title: 'Parent' }, ctx);
    const parentId = parent.ok ? parent.result.id : '';
    await core.call('create', { title: 'Child', idempotency_key: 'k-3' }, ctx);

    const mismatch = await expectRefUnmoved(world.a, () =>
      core.call('create', { title: 'Child', parent: parentId, idempotency_key: 'k-3' }, ctx),
    );

    expect(mismatch.ok ? null : mismatch.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  test('a key is stored under keys/<yyyy-mm>/<h2>/<sha256>.json', async ({ world, grimoire }) => {
    await grimoire.core.call('create', { title: 'Keyed', idempotency_key: 'k-4' }, grimoire.ctx);
    const tip = await trackerTip(world.a);

    const files = await world.a.git(['ls-tree', '-r', '--name-only', tip!, 'keys']);

    // sha256("k-4")
    const hash = createHash('sha256').update('k-4').digest('hex');
    expect(files).toBe(`keys/2026-10/${hash.slice(0, 2)}/${hash}.json`);
  });

  test('keys expire after 30 days, and writes prune month directories whose keys all expired', async ({
    world,
    grimoire,
  }) => {
    const at = (iso: string) => grimoire.makeCore({ clock: () => new Date(iso) });
    const first = await at('2026-10-11T00:00:00.000Z').call('create', { title: 'Old', idempotency_key: 'k-5' }, grimoire.ctx);

    // 29 days later the key still replays.
    const replay = await at('2026-11-09T00:00:00.000Z').call('create', { title: 'Old', idempotency_key: 'k-5' }, grimoire.ctx);
    // 31 days later it is gone: the same call creates a new issue, and October's keys are pruned.
    const later = await at('2026-12-02T00:00:00.000Z').call('create', { title: 'Old', idempotency_key: 'k-5' }, grimoire.ctx);

    expect(replay).toEqual({ ok: true, result: { id: first.ok && first.result.id, created: false } });
    expect(later).toMatchObject({ ok: true, result: { created: true } });
    expect(later.ok && first.ok && later.result.id !== first.result.id).toBe(true);
    const months = await world.a.git(['ls-tree', '--name-only', `${await trackerTip(world.a)}:keys`]);
    expect(months).toBe('2026-12');
  });

  test('distinct keys create distinct issues', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const a = await core.call('create', { title: 'Same title', idempotency_key: 'one' }, ctx);
    const b = await core.call('create', { title: 'Same title', idempotency_key: 'two' }, ctx);

    expect(a.ok && b.ok && a.result.id !== b.result.id).toBe(true);
  });
});
