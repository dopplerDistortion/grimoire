// Sync with a bare remote (spec §4 Sync, §6, §3 Refs; Testing Decisions seam 1):
// the automatic fetch → fold → push after attempt-ending writes, the explicit
// `sync` op, sync-pending markers and the sync status.
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { createCore, type CallContext } from '../../src/core';
import { agentContext, commitToTracker, coreTest as test, initializeTracker, pushTracker, T0, trackerTip } from './support';
import { git } from '#harness';
import { REJECTING_HOOK, DEBRIEF, ok, closeOne, remoteTracker, syncingCore, until, cloneWith, errorOf, nameRoot, rootOf } from './sync-support';

describe('automatic sync', () => {
  test('a close in clone a is pushed in the background; in clone b a plain git fetch is enough for show and list', async ({
    world,
    grimoire,
  }) => {
    // Client hooks never run for grimoire's push.
    await writeFile(path.join(world.a.dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const core = syncingCore(grimoire);
    const id = await closeOne(core, grimoire.ctx);
    await core.close();

    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    await world.b.git(['fetch', '--quiet']);
    const bob = agentContext(world.b);
    const shown = await ok(grimoire.core.call('show', { ref: id }, bob));
    const listed = await ok(grimoire.core.call('list', { status: 'done' }, bob));
    expect(shown.status).toBe('done');
    expect(listed.rows.map((row) => row.id)).toEqual([id]);
  });

  test('a core built with default options syncs in-process, as `grimoire mcp` does: a release is pushed in the background too', async ({
    world,
    grimoire,
  }) => {
    const core = createCore({ clock: () => T0 });
    try {
      const { id } = await ok(core.call('create', { title: 'Let go' }, grimoire.ctx));
      const { attempt } = await ok(core.call('claim', { id }, grimoire.ctx));
      await ok(core.call('release', { id, attempt, debrief: DEBRIEF }, grimoire.ctx));
    } finally {
      await core.close();
    }

    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
  });

  test('every write that ends an attempt syncs, the human-only ones too: a reassign from the dashboard is pushed', async ({
    world,
    grimoire,
  }) => {
    const core = syncingCore(grimoire);
    const { id } = await ok(core.call('create', { title: 'Hand it over' }, grimoire.ctx));
    await ok(core.call('claim', { id }, grimoire.ctx));
    await core.close();
    expect(await remoteTracker(world.a)).toBeNull();

    const dashboard: CallContext = { ...grimoire.ctx, surface: 'dashboard', client: null, evidence: {} };
    const human = syncingCore(grimoire);
    await ok(human.call('reassign', { id, assignee: 'bob@example.com' }, dashboard));
    await human.close();
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
  });

  test('a push a pre-receive hook rejects is recorded as rejected with the remote’s message; the marker stays until a later sync pushes', async ({
    world,
    grimoire,
  }) => {
    const hook = path.join(world.remote, 'hooks', 'pre-receive');
    await writeFile(hook, REJECTING_HOOK, { mode: 0o755 });
    const core = syncingCore(grimoire);
    await closeOne(core, grimoire.ctx);
    await core.close();

    const rejected = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(rejected.failure).toMatchObject({ class: 'rejected', client: 'claude-code', surface: 'mcp' });
    expect(rejected.failure?.message).toContain('GH013: Repository rule violations found for refs/heads/grimoire/tracker.');
    expect(rejected.pending_since).not.toBeNull();
    expect(await remoteTracker(world.a)).toBeNull();

    await rm(hook);
    const synced = await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    const settled = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(synced.state).toBe('pushed');
    expect(settled).toMatchObject({ pending_since: null, failure: null, last_result: 'pushed' });
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
  });
});

describe('remote choice', () => {
  test('with grimoire.remote naming a second remote, sync fetches from and pushes to it, and reads follow it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const upstream = path.join(world.root, 'upstream.git');
    await git(world.root, ['init', '--quiet', '--bare', '--initial-branch=main', upstream]);
    await world.a.git(['remote', 'add', 'upstream', pathToFileURL(upstream).href]);
    await world.a.git(['push', '--quiet', 'upstream', 'main']);
    await world.a.git(['config', 'grimoire.remote', 'upstream']);
    await ok(core.call('create', { title: 'From Alice' }, ctx));

    expect(await ok(core.call('sync', {}, ctx))).toMatchObject({ state: 'pushed', remote: 'upstream' });
    expect(await git(upstream, ['rev-parse', 'refs/heads/grimoire/tracker'])).toBe(await trackerTip(world.a));
    expect(await remoteTracker(world.a)).toBeNull();

    // Carol works from a clone of upstream alone, and syncs.
    const carolDir = path.join(world.root, 'carol');
    await git(world.root, ['clone', '--quiet', '-c', 'user.name=Carol Example', '-c', 'user.email=carol@example.com', pathToFileURL(upstream).href, carolDir]);
    const carol: CallContext = { ...ctx, repo: { root: carolDir, pin: null }, person: { name: 'Carol Example', email: 'carol@example.com' } };
    await ok(core.call('create', { title: 'From Carol' }, carol));
    expect(await ok(core.call('sync', {}, carol))).toMatchObject({ state: 'pushed', remote: 'origin' });

    expect(await ok(core.call('sync', {}, ctx))).toMatchObject({ state: 'in-sync', remote: 'upstream', fetched: true });
    expect((await ok(core.call('list', {}, ctx))).rows.map((row) => row.title).sort()).toEqual(['From Alice', 'From Carol']);
  });
});

describe('when nothing is pushed', () => {
  test('a remote with no default branch gets no push, and the sync-pending marker is set', async ({ world, grimoire }) => {
    const empty = path.join(world.root, 'empty.git');
    await world.a.git(['init', '--quiet', '--bare', empty]);
    await world.a.git(['remote', 'set-url', 'origin', pathToFileURL(empty).href]);
    const core = syncingCore(grimoire);
    await closeOne(core, grimoire.ctx);
    await core.close();

    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(await world.a.git(['ls-remote', 'origin'])).toBe('');
    expect(status).toMatchObject({ last_result: 'no-default-branch', failure: null });
    expect(status.pending_since).not.toBeNull();
    expect(status.summary).toContain('no default branch');
  });

  test('with auto-sync off no automatic push happens, and an explicit sync still pushes', async ({ world, grimoire }) => {
    await commitToTracker(world.a, {
      'settings.yml': 'auto-sync: {"at":"2026-10-11T03:00:00.000Z","by":"alice@example.com","value":false}\n',
    });
    const core = syncingCore(grimoire);
    await closeOne(core, grimoire.ctx);
    await core.close();
    const off = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(await remoteTracker(world.a)).toBeNull();
    expect(off).toMatchObject({ auto_sync: false, last_result: null });
    expect(off.pending_since).not.toBeNull();

    const synced = await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    expect(synced.state).toBe('pushed');
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    expect((await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).pending_since).toBeNull();
  });
});

describe('incomplete clones', () => {
  test('a partial clone reads NOT_SYNCED for missing tracker objects, never empty results, until sync backfills them', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const first = (await ok(core.call('create', { title: 'First' }, ctx))).id;
    const second = (await ok(core.call('create', { title: 'Second', body: 'Some body text.' }, ctx))).id;
    await pushTracker(world.a);
    await git(world.remote, ['config', 'uploadpack.allowFilter', 'true']);
    const carol = await cloneWith(world, 'partial', ['--filter=blob:none']);

    const listed = await errorOf(core.call('list', {}, carol.ctx));
    const shown = await errorOf(core.call('show', { ref: first }, carol.ctx));
    expect(listed.code).toBe('NOT_SYNCED');
    expect(shown.code).toBe('NOT_SYNCED');
    expect(listed.details.remedy).toContain('grimoire sync');

    const fetchHead = path.join(carol.dir, '.git', 'FETCH_HEAD');
    await rm(fetchHead, { force: true });
    const synced = await ok(core.call('sync', {}, carol.ctx));
    expect(synced).toMatchObject({ state: 'in-sync', fetched: true });
    expect(existsSync(fetchHead)).toBe(false);
    const rows = await ok(core.call('list', {}, carol.ctx));
    expect(rows.rows.map((row) => row.id)).toEqual([first, second]);
    expect((await ok(core.call('show', { ref: second }, carol.ctx))).body).toBe('Some body text.');
    await ok(core.call('create', { title: 'From the partial clone' }, carol.ctx));
    expect(await ok(core.call('sync', {}, carol.ctx))).toMatchObject({ state: 'pushed' });
    expect(await remoteTracker(world.a)).toBe(await git(carol.dir, ['rev-parse', 'refs/grimoire/tracker']));
  });

  test('a shallow tracker history refuses writes with NOT_SYNCED until sync deepens it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await ok(core.call('create', { title: 'One' }, ctx));
    await ok(core.call('create', { title: 'Two' }, ctx));
    await pushTracker(world.a);
    const carol = await cloneWith(world, 'shallow', ['--depth', '1', '--no-single-branch']);

    const refused = await errorOf(core.call('create', { title: 'Three' }, carol.ctx));
    expect(refused.code).toBe('NOT_SYNCED');
    expect(refused.details.remedy).toContain('grimoire sync');
    expect(await git(carol.dir, ['for-each-ref', 'refs/grimoire/'])).toBe('');
    expect((await ok(core.call('list', {}, carol.ctx))).rows).toHaveLength(2);

    expect(await ok(core.call('sync', {}, carol.ctx))).toMatchObject({ state: 'in-sync', fetched: true });
    await ok(core.call('create', { title: 'Three' }, carol.ctx));
    expect((await ok(core.call('list', {}, carol.ctx))).rows.map((row) => row.title)).toEqual(['One', 'Two', 'Three']);
  });

  test('a shallow clone whose config.yml names root R reads, refuses writes as shallow, and the same core writes once sync deepens it', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await ok(core.call('create', { title: 'One' }, ctx));
    await ok(core.call('create', { title: 'Two' }, ctx));
    await pushTracker(world.a);
    const carol = await cloneWith(world, 'shallow', ['--depth', '1', '--no-single-branch']);
    await nameRoot(carol.dir, await rootOf(world.a));

    expect((await ok(core.call('list', {}, carol.ctx))).rows).toHaveLength(2);
    const refused = await errorOf(core.call('create', { title: 'Three' }, carol.ctx));
    expect(refused).toMatchObject({ code: 'NOT_SYNCED', message: expect.stringContaining('shallow') });
    expect(refused.details.remedy).toContain('grimoire sync');

    expect(await ok(core.call('sync', {}, carol.ctx))).toMatchObject({ state: 'in-sync', fetched: true });
    expect((await ok(core.call('list', {}, carol.ctx))).rows).toHaveLength(2);
    await ok(core.call('create', { title: 'Three' }, carol.ctx));
    expect((await ok(core.call('list', {}, carol.ctx))).rows.map((row) => row.title)).toEqual(['One', 'Two', 'Three']);
  });
});

describe('a missing tracker', () => {
  test('config.yml naming root R with no ref holding it gives NOT_SYNCED with a remedy on reads and writes, until sync fetches it', async ({
    world,
    grimoire,
  }) => {
    const root = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await nameRoot(world.b.dir, root);
    const bob = agentContext(world.b);

    const read = await errorOf(grimoire.core.call('list', {}, bob));
    const write = await errorOf(grimoire.core.call('create', { title: 'Lost' }, bob));
    expect(read).toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: root } });
    expect(write).toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: root } });
    expect(read.details.remedy).toContain('grimoire sync');
    expect(write.details.remedy).toContain('grimoire sync');

    await pushTracker(world.a);
    expect(await ok(grimoire.core.call('sync', {}, bob))).toMatchObject({ state: 'in-sync', fetched: true });
    expect((await ok(grimoire.core.call('list', {}, bob))).rows).toEqual([]);
    await ok(grimoire.core.call('create', { title: 'Found' }, bob));
  });

  test('tracker refs that hold another root than config.yml names give NOT_SYNCED, never that tracker’s issues', async ({
    world,
    grimoire,
  }) => {
    const root = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await initializeTracker(world.b, world.b);
    const bob = agentContext(world.b);
    await ok(grimoire.core.call('create', { title: 'In the other tracker' }, bob));
    await nameRoot(world.b.dir, root);

    const read = await errorOf(grimoire.core.call('list', {}, bob));
    expect(read).toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: root } });
    expect(read.details.remedy).toContain('grimoire init');
  });
});

describe('failures', () => {
  /** An HTTP remote that answers every request with 401 and counts them. */
  async function authWall(): Promise<{ url: (userinfo?: string) => string; requests: () => number; close: () => Promise<void> }> {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="grimoire-test"' });
      response.end('authentication required');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: (userinfo) => `http://${userinfo ? `${userinfo}@` : ''}127.0.0.1:${port}/remote.git`,
      requests: () => requests,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  test('after a failure, automatic syncs back off without touching the remote; an explicit sync still tries', async ({
    world,
    grimoire,
    onTestFinished,
  }) => {
    const wall = await authWall();
    onTestFinished(() => wall.close());
    await world.a.git(['remote', 'set-url', 'origin', wall.url()]);
    const core = syncingCore(grimoire);
    await closeOne(core, grimoire.ctx, 'First');
    await core.close();
    const tried = wall.requests();
    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));

    const again = syncingCore(grimoire);
    await closeOne(again, grimoire.ctx, 'Second');
    await again.close();
    expect(tried).toBeGreaterThan(0);
    expect(wall.requests()).toBe(tried);
    expect(Date.parse(status.retry_at!) - Date.parse(status.last_attempt_at!)).toBe(60_000);

    await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    const later = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(wall.requests()).toBeGreaterThan(tried);
    expect(Date.parse(later.retry_at!) - Date.parse(later.last_attempt_at!)).toBe(120_000);
  });

  test('failures back off exponentially, up to an hour', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await world.a.git(['remote', 'set-url', 'origin', pathToFileURL(path.join(world.root, 'gone.git')).href]);
    const waits: number[] = [];
    for (let failure = 1; failure <= 8; failure++) {
      await ok(core.call('sync', {}, ctx));
      const status = await ok(core.call('sync_status', {}, ctx));
      waits.push((Date.parse(status.retry_at!) - Date.parse(status.last_attempt_at!)) / 60_000);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  test('an explicit sync that can’t reach the remote leaves nothing pending when the remote held the local tip when last seen', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    expect(await ok(core.call('sync', {}, ctx))).toMatchObject({ state: 'pushed' });
    await world.a.git(['remote', 'set-url', 'origin', pathToFileURL(path.join(world.root, 'gone.git')).href]);

    const offline = await ok(core.call('sync', {}, ctx));
    const status = await ok(core.call('sync_status', {}, ctx));
    expect(offline).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'network' } });
    expect(status.pending_since).toBeNull();
  });

  test('a sync that must fold without a git user.email gives NO_GIT_IDENTITY with the resolved identity', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await pushTracker(world.a);
    await world.b.git(['fetch', '--quiet']);
    const bob = agentContext(world.b);
    await ok(core.call('create', { title: 'From Bob' }, bob));
    await ok(core.call('create', { title: 'From Alice' }, ctx));
    await pushTracker(world.a);

    const refused = await errorOf(core.call('sync', {}, { ...bob, person: { name: 'Bob Example', email: null } }));
    expect(refused).toMatchObject({ code: 'NO_GIT_IDENTITY', details: { name: 'Bob Example', email: null } });
  });
});
