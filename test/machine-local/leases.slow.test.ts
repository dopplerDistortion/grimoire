// Machine-local leases against the clock: a second acquirer of a held lease is
// told so at once. In the serial `slow` project (npm run test:slow); the rest is
// in leases.test.ts.
import { describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import { locateMachineLocalStore, type MachineLocalStore } from '../../src/machine-local';

async function storeOf(dir: string): Promise<MachineLocalStore> {
  const store = await locateMachineLocalStore(dir);
  if (!store) throw new Error(`no store at ${dir}`);
  return store;
}
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
});
