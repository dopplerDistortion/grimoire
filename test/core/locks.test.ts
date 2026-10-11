import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { coreTest as test, expectRefUnmoved, trackerTip } from './support';

const ago = (ms: number) => new Date(Date.now() - ms);

describe('ref locks and the fairness lock', () => {
  test('a tracker ref lock older than 30 s gives BUSY with details.stale_lock at once', async ({
    world,
    grimoire,
  }) => {
    const lock = path.join(world.a.dir, '.git', 'refs', 'grimoire', 'tracker.lock');
    await writeFile(lock, '');
    await utimes(lock, ago(45_000), ago(45_000));
    const started = Date.now();

    const outcome = await expectRefUnmoved(world.a, () =>
      grimoire.core.call('create', { title: 'Blocked' }, grimoire.ctx),
    );

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'BUSY',
        message: expect.any(String),
        retryable: true,
        details: { stale_lock: { path: lock, age_ms: expect.any(Number) } },
      },
    });
    expect(!outcome.ok && (outcome.error.details.stale_lock as { age_ms: number }).age_ms).toBeGreaterThan(30_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a fresh ref lock is retried, and the write lands once it is gone', async ({ world, grimoire }) => {
    const lock = path.join(world.a.dir, '.git', 'refs', 'grimoire', 'tracker.lock');
    await writeFile(lock, '');
    const before = await trackerTip(world.a);
    setTimeout(() => void rm(lock), 700);

    const outcome = await grimoire.core.call('create', { title: 'Patient' }, grimoire.ctx);

    expect(outcome).toMatchObject({ ok: true, result: { created: true } });
    expect(await world.a.git(['rev-parse', `${await trackerTip(world.a)}^`])).toBe(before);
  });

  test('a fresh ref lock held past the write budget gives BUSY without stale_lock', async ({ world, grimoire }) => {
    const lock = path.join(world.a.dir, '.git', 'refs', 'grimoire', 'tracker.lock');
    await writeFile(lock, '');
    const core = grimoire.makeCore({ writeBudgetMs: 800 });

    const outcome = await expectRefUnmoved(world.a, () => core.call('create', { title: 'Too slow' }, grimoire.ctx));

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'BUSY', message: expect.any(String), retryable: true, details: {} },
    });
    await rm(lock);
  });

  test('a fairness lock held by a live writer delays writes; past the budget they get BUSY', async ({
    world,
    grimoire,
  }) => {
    const fairness = path.join(world.a.dir, '.git', 'grimoire', 'locks', 'tracker-write.lock');
    await mkdir(path.dirname(fairness), { recursive: true });
    await writeFile(fairness, JSON.stringify({ token: 'other', pid: 1, at: new Date().toISOString() }));
    const core = grimoire.makeCore({ writeBudgetMs: 800 });

    const outcome = await expectRefUnmoved(world.a, () => core.call('create', { title: 'Waiting' }, grimoire.ctx));

    expect(outcome).toMatchObject({ ok: false, error: { code: 'BUSY', retryable: true, details: {} } });
  });

  test('an abandoned fairness lock (no heartbeat) is taken over', async ({ world, grimoire }) => {
    const fairness = path.join(world.a.dir, '.git', 'grimoire', 'locks', 'tracker-write.lock');
    await mkdir(path.dirname(fairness), { recursive: true });
    await writeFile(fairness, JSON.stringify({ token: 'dead', pid: 1, at: ago(60_000).toISOString() }));
    await utimes(fairness, ago(60_000), ago(60_000));

    const outcome = await grimoire.core.call('create', { title: 'Taking over' }, grimoire.ctx);

    expect(outcome).toMatchObject({ ok: true, result: { created: true } });
  });
});
