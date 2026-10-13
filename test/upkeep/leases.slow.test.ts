// Upkeep's leases against the clock (spec §13 How it runs): a part whose lease
// is held is skipped at once, never waited for. In the serial `slow` project
// (npm run test:slow); the rest is in leases.test.ts.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { MachineLocalStore } from '../../src/machine-local';
import { partLeaseName, runUpkeep, worktreeLeaseName, type PartRun, type UpkeepReport } from '../../src/upkeep';
import { installed } from './support';

/** Each part's status in one pass, by name: parts later releases add don't change what a test asserts. */
function byPart(report: UpkeepReport): Record<string, PartRun['status']> {
  return Object.fromEntries(report.runs.map((run) => [run.part, run.status]));
}
describe('leases and throttles', () => {
  gitTest('a held lease skips its part, even when forced, and never waits', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const store = new MachineLocalStore(path.join(root, '.git'));
    // `init` or `doctor --fix` holds this worktree, and another process prunes.
    const worktree = await store.leases.acquire(await worktreeLeaseName(root), { ttlMs: 60_000 });
    const prune = await store.leases.acquire(partLeaseName('prune-copies'), { ttlMs: 60_000 });

    const started = Date.now();
    const report = await runUpkeep({ root, force: true });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(byPart(report)).toMatchObject({ 'pending-sync': 'ran', 'prune-copies': 'held', 'pointer-refresh': 'held' });
    for (const lease of [worktree, prune]) if (lease.status === 'acquired') await lease.lease.release();
    expect(byPart(await runUpkeep({ root }))).toMatchObject({ 'pending-sync': 'throttled', 'prune-copies': 'ran', 'pointer-refresh': 'ran' });
  });
});
