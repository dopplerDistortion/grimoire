// Pending syncs as an upkeep part (spec §13; §4 Sync; §6 sync-pending
// markers): a tip whose sync died (a killed detached child, a sandbox) goes
// out with the next upkeep pass, as an automatic sync, so the auto-sync
// setting and the backoff still govern it. Seam 1, with a bare remote.
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect } from 'vitest';
import { spawnedAutoSync, type CallContext, type Core } from '../../src/core';
import { runUpkeep } from '../../src/upkeep';
import { coreTest, trackerTip } from '../core/support';
import type { Checkout } from '#harness';

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(`call failed: ${JSON.stringify(settled.error)}`);
  return settled.result;
}

async function remoteTracker(checkout: Checkout): Promise<string | null> {
  const run = await checkout.gitResult(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return run.stdout.split('\t')[0]?.trim() || null;
}

const DEBRIEF = { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' };

/** An attempt-ending write whose detached sync child dies before it syncs: the marker stays. */
async function closeWithDeadChild(makeCore: () => Core, ctx: CallContext): Promise<void> {
  const core = makeCore();
  const { id } = await ok(core.call('create', { title: 'Fix the flaky test' }, ctx));
  const { attempt } = await ok(core.call('claim', { id }, ctx));
  await ok(core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  await core.close();
  await sleep(300);
}

describe('pending syncs', () => {
  coreTest('a tip left sync-pending goes out with the next pass, which clears the marker', async ({ world, grimoire }) => {
    const dead = () => grimoire.makeCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: ['-e', 'process.exit(0)'] }) });
    await closeWithDeadChild(dead, grimoire.ctx);
    expect(await remoteTracker(world.a)).toBeNull();

    const report = await runUpkeep({ root: world.a.dir });

    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pending-sync', status: 'ran', result: expect.objectContaining({ state: 'pushed' }) }));
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    expect((await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).pending_since).toBeNull();
  });

  coreTest('with nothing pending the part opens no tracker and pushes nothing', async ({ world }) => {
    const report = await runUpkeep({ root: world.a.dir });

    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pending-sync', status: 'ran', result: { pending: false } }));
    expect(await remoteTracker(world.a)).toBeNull();
  });

  coreTest('auto-sync off keeps the marker: upkeep never pushes behind the setting', async ({ world, grimoire }) => {
    const dead = () => grimoire.makeCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: ['-e', 'process.exit(0)'] }) });
    const human: CallContext = { ...grimoire.ctx, surface: 'cli', tty: true, client: null, evidence: {} };
    await ok(grimoire.core.call('settings_set', { key: 'auto-sync', value: 'false' }, human));
    await closeWithDeadChild(dead, grimoire.ctx);

    const report = await runUpkeep({ root: world.a.dir });

    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pending-sync', status: 'ran', result: expect.objectContaining({ skipped: 'auto-sync-off' }) }));
    expect(await remoteTracker(world.a)).toBeNull();
    expect((await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).pending_since).not.toBeNull();
  });
});
