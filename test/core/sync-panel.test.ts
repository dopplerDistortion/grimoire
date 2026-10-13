// What the dashboard's sync panel and footer chip read (spec §20 Settings,
// Shell; §4 Sync), seam 1: `sync_status` says where the local tracker stands
// against the remote's as last fetched (in sync, ahead, behind or diverged,
// with the counts) and, for the last failure, the fix in words.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { agentContext, coreTest as test, fetchTracker, pushTracker } from './support';
import { closeOne, ok, REJECTING_HOOK, syncingCore } from './sync-support';

describe('sync_status: the local tracker against the remote’s', () => {
  test('unpublished, then in sync, ahead, behind and diverged, with the counts', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const bob = agentContext(world.b);
    const status = async (who = ctx) => (await ok(core.call('sync_status', {}, who))).position!;

    const unpublished = await status();
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const inSync = await status();
    await ok(core.call('create', { title: 'One' }, ctx));
    await ok(core.call('create', { title: 'Two' }, ctx));
    const ahead = await status();
    await pushTracker(world.a);
    await fetchTracker(world.a);
    // Bob's clone has only the remote-tracking ref: behind, by every commit.
    await fetchTracker(world.b);
    const behind = await status(bob);
    await ok(core.call('create', { title: 'Bob’s' }, bob));
    await pushTracker(world.b);
    await ok(core.call('create', { title: 'Alice’s' }, ctx));
    await fetchTracker(world.a);
    const diverged = await status();

    expect(unpublished).toMatchObject({ state: 'unpublished', remote_tip: null, ahead: null, behind: null });
    expect(unpublished.local).toMatch(/^[0-9a-f]{40}$/);
    expect(inSync).toMatchObject({ state: 'in-sync', ahead: 0, behind: 0 });
    expect(inSync.local).toBe(inSync.remote_tip);
    expect(ahead).toMatchObject({ state: 'ahead', ahead: 2, behind: 0 });
    expect(behind).toMatchObject({ state: 'behind', local: null, ahead: 0, behind: 3 });
    expect(diverged).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
  });

  test('a rejected push comes with the remote’s message and the fix; settled, both are gone', async ({ world, grimoire }) => {
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), REJECTING_HOOK, { mode: 0o755 });
    const core = syncingCore(grimoire);
    await closeOne(core, grimoire.ctx);
    await core.close();

    const rejected = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));

    expect(rejected.failure).toMatchObject({ class: 'rejected' });
    expect(rejected.failure!.message).toContain('GH013');
    expect(rejected.fix).toBe(
      'origin refuses pushes to grimoire/tracker (a branch protection rule, a ruleset or a server hook): let this clone push the grimoire/tracker branch, or pick another remote with grimoire.remote, then Sync now.',
    );
    expect(rejected.position).toMatchObject({ state: 'unpublished' });
  });
});
