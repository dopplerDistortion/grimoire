import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import { locateMachineLocalStore, type MachineLocalStore } from '../../src/machine-local';
import { buildChild, runChild, startChild, type ChildBundle } from './child-process';

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

describe('locks', () => {
  test('a held lock is reported held, with its holder data; it is free once released', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.locks.acquire('start', { data: { port: 4319, nonce: 'n1' } });
    if (first.status !== 'acquired') throw new Error('expected to acquire');

    const second = await store.locks.acquire('start');
    expect(second.status).toBe('held');
    const state = await store.locks.inspect('start');
    expect(state.status).toBe('held');
    if (state.status === 'held') {
      expect(state.holder).toMatchObject({ pid: process.pid, data: { port: 4319, nonce: 'n1' } });
    }

    await first.lock.release();
    expect((await store.locks.inspect('start')).status).toBe('free');
  });

  test('acquire waits up to waitMs for the holder to let go', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.locks.acquire('install');
    if (first.status !== 'acquired') throw new Error('expected to acquire');
    setTimeout(() => void first.lock.release(), 150);

    expect((await store.locks.acquire('install', { waitMs: 0 })).status).toBe('held');
    expect((await store.locks.acquire('install', { waitMs: 5_000 })).status).toBe('acquired');
  });

  test('withLock runs the function under the lock and releases it after, even on a throw', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const seen = await store.locks.withLock('install', async () => {
      return (await store.locks.inspect('install')).status;
    });
    expect(seen).toBe('held');
    await expect(
      store.locks.withLock('install', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await store.locks.inspect('install')).status).toBe('free');

    const holder = await store.locks.acquire('install');
    await expect(store.locks.withLock('install', async () => 1, { waitMs: 50 })).rejects.toThrow(
      /held/,
    );
    if (holder.status === 'acquired') await holder.lock.release();
  });

  test('a lock whose holder process is gone is stale and is taken over', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const holder = await startChild(child, { action: 'hold-lock', from: world.a.dir, name: 'start' });
    expect(holder.firstLine).toMatchObject({ status: 'acquired' });
    expect((await store.locks.acquire('start')).status).toBe('held');

    await holder.kill();

    expect((await store.locks.inspect('start')).status).toBe('stale');
    expect((await store.locks.acquire('start')).status).toBe('acquired');
  });

  test('a lock with a ttl lapses without the holder dying', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await store.locks.acquire('fairness', { ttlMs: 50 });
    await sleep(100);
    expect((await store.locks.acquire('fairness')).status).toBe('acquired');
  });

  test('read-modify-write updates from N processes are never lost', async ({ world }) => {
    const feature = await world.a.addWorktree('feature');
    const n = 6;
    const times = 5;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        runChild(child, {
          action: 'count',
          from: i % 2 === 0 ? world.a.dir : feature.dir,
          kind: 'runner-counters',
          key: 'spawns',
          times,
        }),
      ),
    );
    const store = await storeOf(world.a.dir);
    expect(await store.coordination.read('runner-counters', 'spawns')).toBe(n * times);
  });
});
