import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import { locateMachineLocalStore, type MachineLocalStore } from '../../src/machine-local';
import { buildChild, startChild, type ChildBundle } from './child-process';

async function storeOf(dir: string): Promise<MachineLocalStore> {
  const store = await locateMachineLocalStore(dir);
  if (!store) throw new Error(`no store at ${dir}`);
  return store;
}

let child: ChildBundle;
beforeAll(async () => {
  child = await buildChild();
});
afterAll(() => child?.cleanup());

describe('leases', () => {
  test('acquiring a free lease succeeds; a second acquirer is told it is held, at once', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.leases.acquire('upkeep-sweep', { ttlMs: 60_000 });
    expect(first.status).toBe('acquired');

    const started = Date.now();
    const second = await store.leases.acquire('upkeep-sweep', { ttlMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(second.status).toBe('held');
    if (second.status !== 'held' || first.status !== 'acquired') return;
    expect(second.holder.owner).toBe(first.lease.holder.owner);
    expect(second.holder.pid).toBe(process.pid);

    // Another worktree of the clone sees the same lease.
    const feature = await world.a.addWorktree('feature');
    const fromWorktree = await storeOf(feature.dir);
    expect((await fromWorktree.leases.acquire('upkeep-sweep', { ttlMs: 1_000 })).status).toBe(
      'held',
    );
    expect((await store.leases.inspect('upkeep-sweep')).status).toBe('held');
  });

  test('a released lease is free again', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.leases.acquire('sync', { ttlMs: 60_000 });
    if (first.status !== 'acquired') throw new Error('expected to acquire');
    await first.lease.release();

    expect((await store.leases.inspect('sync')).status).toBe('free');
    expect((await store.leases.acquire('sync', { ttlMs: 60_000 })).status).toBe('acquired');
  });

  test('an expired lease can be taken over, and its old holder learns it lost it', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.leases.acquire('sweep', { ttlMs: 50 });
    if (first.status !== 'acquired') throw new Error('expected to acquire');
    await sleep(120);

    expect((await store.leases.inspect('sweep')).status).toBe('expired');
    const second = await store.leases.acquire('sweep', { ttlMs: 60_000 });
    expect(second.status).toBe('acquired');
    expect(await first.lease.renew(60_000)).toBe(false);
    expect((await store.leases.acquire('sweep', { ttlMs: 60_000 })).status).toBe('held');

    // The old holder's release doesn't free the new holder's lease.
    await first.lease.release();
    expect((await store.leases.inspect('sweep')).status).toBe('held');
  });

  test('renewing keeps a lease past its first expiry', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.leases.acquire('fairness', { ttlMs: 150 });
    if (first.status !== 'acquired') throw new Error('expected to acquire');
    await sleep(80);
    expect(await first.lease.renew(5_000)).toBe(true);
    await sleep(120);

    expect((await store.leases.acquire('fairness', { ttlMs: 1_000 })).status).toBe('held');
  });

  test('a lease whose holder process is gone is free before its expiry', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const holder = await startChild(child, {
      action: 'hold-lease',
      from: world.a.dir,
      name: 'sweep',
      ttlMs: 600_000,
    });
    expect(holder.firstLine).toMatchObject({ status: 'acquired' });
    expect((await store.leases.acquire('sweep', { ttlMs: 1_000 })).status).toBe('held');

    await holder.kill();

    expect((await store.leases.acquire('sweep', { ttlMs: 1_000 })).status).toBe('acquired');
  });

  test('lease names with any characters are kept apart', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const a = await store.leases.acquire(`worktree:${world.a.dir}`, { ttlMs: 60_000 });
    const b = await store.leases.acquire(`worktree:${world.a.dir.toUpperCase()}x`, {
      ttlMs: 60_000,
    });
    expect(a.status).toBe('acquired');
    expect(b.status).toBe('acquired');
    if (a.status === 'acquired') expect(a.lease.holder.name).toBe(`worktree:${world.a.dir}`);
  });

  test('N processes racing for one free lease produce exactly one holder', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await race(world.a.dir, 'race-free', 12, async (results) => {
      expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'held')).toHaveLength(11);
      const winner = results.find((r) => r.status === 'acquired')!;
      for (const r of results) expect(r.owner).toBe(winner.owner);
      const now = await store.leases.inspect('race-free');
      expect(now.status === 'held' && now.holder.owner).toBe(winner.owner);
    });
  });

  test('N processes racing to take over one expired lease produce exactly one holder', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const old = await store.leases.acquire('race-expired', { ttlMs: 1 });
    if (old.status !== 'acquired') throw new Error('expected to acquire');
    await sleep(20);

    await race(world.a.dir, 'race-expired', 12, async (results) => {
      expect(results.filter((r) => r.status === 'acquired')).toHaveLength(1);
      const winner = results.find((r) => r.status === 'acquired')!;
      const now = await store.leases.inspect('race-expired');
      expect(now.status === 'held' && now.holder.owner).toBe(winner.owner);
    });
  });
});

interface RaceResult {
  status: 'acquired' | 'held';
  owner: string;
}

/** Starts n processes that each try once, at the same instant; they stay alive during `check`. */
async function race(
  from: string,
  name: string,
  n: number,
  check: (results: RaceResult[]) => Promise<void>,
): Promise<void> {
  const goAt = Date.now() + 3_000;
  const settled = await Promise.allSettled(
    Array.from({ length: n }, () =>
      startChild(child, { action: 'race-lease', from, name, ttlMs: 600_000, goAt }),
    ),
  );
  const children = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  try {
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
    await check(children.map((c) => c.firstLine as RaceResult));
  } finally {
    await Promise.all(children.map((c) => c.kill()));
  }
}
