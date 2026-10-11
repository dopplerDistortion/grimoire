// Copy pruning as an upkeep part (spec §13; §11 Version copies, pruning):
// copies pinned by no registered worktree and used by no live process go
// through pkg/.trash/, the newest previous one stays, and so does the copy
// the pruning process itself runs. Seam 1.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { INSTALL_LOCK, installCopy, listCopies } from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';
import { runUpkeep } from '../../src/upkeep';
import { reportingPackage } from '../installer/support';
import { pin } from './support';

async function installAll(store: MachineLocalStore, parent: string, versions: string[]): Promise<void> {
  for (const version of versions) await installCopy(store, version, { dir: await reportingPackage(parent, version), integrity: null });
}

describe('copy pruning', () => {
  gitTest('removes copies nothing pins or runs through pkg/.trash/, keeping the newest previous one and the running one', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['0.9.0', '1.0.0', '1.5.0', '2.0.0', '3.0.0', '4.0.0']);
    const linked = await world.a.addWorktree('old-branch');
    await pin(world.a.dir, '2.0.0');
    await pin(linked.dir, '1.0.0');
    const live = await store.processes.register({ role: 'mcp', client: null, worktree: world.a.dir, pin: '4.0.0', pathSource: null });

    const report = await runUpkeep({ root: world.a.dir, version: '3.0.0' });
    await live.unregister();

    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'prune-copies', status: 'ran', result: expect.objectContaining({ removed: ['0.9.0'] }) }));
    expect((await listCopies(store)).map((copy) => copy.version)).toEqual(['1.0.0', '1.5.0', '2.0.0', '3.0.0', '4.0.0']);
    expect(await readdir(path.join(store.dir, 'pkg', '.trash'))).toEqual([]);
  });

  gitTest('an install holding the lock leaves pruning to a later pass, without waiting for it', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['0.9.0', '1.0.0', '2.0.0']);
    await pin(world.a.dir, '2.0.0');
    const held = await store.locks.acquire(INSTALL_LOCK);
    expect(held.status).toBe('acquired');

    const started = Date.now();
    const report = await runUpkeep({ root: world.a.dir, version: '2.0.0' });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'prune-copies', status: 'skipped', why: 'install' }));
    expect((await listCopies(store)).map((copy) => copy.version)).toEqual(['0.9.0', '1.0.0', '2.0.0']);

    // Not throttled: the next pass prunes once the install is done.
    if (held.status === 'acquired') await held.lock.release();
    const later = await runUpkeep({ root: world.a.dir, version: '2.0.0' });
    expect(later.runs).toContainEqual(expect.objectContaining({ part: 'prune-copies', status: 'ran', result: expect.objectContaining({ removed: ['0.9.0'] }) }));
  });
});
