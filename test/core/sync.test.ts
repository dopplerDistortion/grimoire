// Sync with a bare remote (spec §4 Sync, §6, §3 Refs; Testing Decisions seam 1):
// the automatic fetch → fold → push after attempt-ending writes, the explicit
// `sync` op, sync-pending markers and the sync status.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { spawnedAutoSync, syncNow, syncRequestOf, type CallContext, type Core } from '../../src/core';
import { actorOf } from '../../src/core/context';
import { openTracker } from '../../src/tracker';
import { MachineLocalStore } from '../../src/machine-local';
import {
  agentContext,
  bundleCallProcess,
  commitToTracker,
  coreTest as test,
  initializeTracker,
  pushTracker,
  T0,
  trackerTip,
  type Grimoire,
} from './support';
import { git, type Checkout, type GitWorld } from '#harness';

/** A remote pre-receive hook that rejects every push the way GitHub's rulesets do. */
const REJECTING_HOOK = [
  '#!/bin/sh',
  'echo "GH013: Repository rule violations found for refs/heads/grimoire/tracker." >&2',
  'exit 1',
  '',
].join('\n');

const DEBRIEF = { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' };

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(`call failed: ${JSON.stringify(settled.error)}`);
  return settled.result;
}

/** Creates an issue, claims it and closes it as done: an attempt-ending write. */
async function closeOne(core: Core, ctx: CallContext, title = 'Fix the flaky test'): Promise<string> {
  const { id } = await ok(core.call('create', { title }, ctx));
  const { attempt } = await ok(core.call('claim', { id }, ctx));
  await ok(core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  return id;
}

/** The remote's `grimoire/tracker` tip, or null. */
async function remoteTracker(checkout: Checkout): Promise<string | null> {
  const run = await checkout.gitResult(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return run.stdout.split('\t')[0]?.trim() || null;
}

/** A core that syncs in-process after attempt-ending writes, as a long-lived process does. */
function syncingCore(grimoire: Grimoire): Core {
  return grimoire.makeCore({ autoSync: 'in-process' });
}

describe('automatic sync', () => {
  test('a close in clone a is pushed in the background; in clone b a plain git fetch is enough for show and list', async ({
    world,
    grimoire,
  }) => {
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

/** A clone of the world's remote made with extra `git clone` flags, committing as Carol. */
async function cloneWith(world: GitWorld, name: string, flags: readonly string[]): Promise<{ dir: string; ctx: CallContext }> {
  const dir = path.join(world.root, name);
  await git(world.root, ['clone', '--quiet', ...flags, '-c', 'user.name=Carol Example', '-c', 'user.email=carol@example.com', world.remoteUrl, dir]);
  const ctx: CallContext = { ...agentContext(world.b), repo: { root: dir, pin: null }, person: { name: 'Carol Example', email: 'carol@example.com' } };
  return { dir, ctx };
}

async function errorOf(outcome: Promise<{ ok: boolean; error?: unknown }>): Promise<{ code: string; details: Record<string, unknown> }> {
  const settled = await outcome;
  if (settled.ok) throw new Error('expected an error');
  return settled.error as { code: string; details: Record<string, unknown> };
}

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

    const synced = await ok(core.call('sync', {}, carol.ctx));
    expect(synced).toMatchObject({ state: 'in-sync', fetched: true });
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
});

describe('a missing tracker', () => {
  /** Writes `.grimoire/config.yml` naming tracker root `root` into `dir` (what `init` will commit). */
  async function nameRoot(dir: string, root: string): Promise<void> {
    await mkdir(path.join(dir, '.grimoire'), { recursive: true });
    await writeFile(path.join(dir, '.grimoire', 'config.yml'), `version: "0.0.0"\ninstall_format: 1\ntracker_root: "${root}"\n`);
  }

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

  test('a remote that needs credentials fails fast with class auth: no prompt, no hang, and the URL’s userinfo never shows', async ({
    world,
    grimoire,
    onTestFinished,
  }) => {
    const wall = await authWall();
    onTestFinished(() => wall.close());
    await world.a.git(['remote', 'set-url', 'origin', wall.url('alice:s3cret-token')]);
    const core = syncingCore(grimoire);

    const started = Date.now();
    await closeOne(core, grimoire.ctx);
    await core.close();
    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(status.failure).toMatchObject({ class: 'auth', client: 'claude-code', surface: 'mcp' });
    expect(status.summary).toContain('authentication failed in a claude-code server');
    expect(JSON.stringify(status)).not.toMatch(/s3cret|alice:/);

    await world.a.git(['remote', 'set-url', 'origin', wall.url()]);
    const synced = await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    expect(synced).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'auth' } });
    expect(synced.failure?.message).toMatch(/terminal prompts disabled|could not read Username/i);
  });

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
});

describe('around the calling op', () => {
  test('the close answers before its sync gets any answer from the remote: a sync never delays the call', async ({
    world,
    grimoire,
    onTestFinished,
  }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      void held.then(() => {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="grimoire-test"' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await world.a.git(['remote', 'set-url', 'origin', `http://127.0.0.1:${(server.address() as AddressInfo).port}/remote.git`]);
    const core = syncingCore(grimoire);

    const id = await closeOne(core, grimoire.ctx);
    const shown = await ok(core.call('show', { ref: id }, grimoire.ctx));
    for (let waited = 0; requests === 0 && waited < 15_000; waited += 50) await sleep(50);
    expect(shown.status).toBe('done');
    expect(requests).toBeGreaterThan(0);
    release();
    await core.close();
  });

  test('two clones that both close and sync converge: the later sync fetches, folds and pushes, and a plain fetch shows both', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await world.b.git(['fetch', '--quiet']);
    const alice = syncingCore(grimoire);
    const bob = grimoire.makeCore({ autoSync: 'in-process', clock: () => new Date(T0.getTime() + 60_000) });
    const bobCtx = agentContext(world.b);
    const fromAlice = await closeOne(alice, grimoire.ctx, 'From Alice');
    await alice.close();
    const fromBob = await closeOne(bob, bobCtx, 'From Bob');
    await bob.close();

    const bobTip = (await trackerTip(world.b))!;
    expect(await remoteTracker(world.a)).toBe(bobTip);
    const parents = (await world.b.git(['rev-list', '--parents', '-n', '1', bobTip])).split(' ');
    expect(parents).toHaveLength(3);
    expect(await world.b.git(['log', '-1', '--format=%B', bobTip])).toContain('Grimoire-Op: fold');
    await world.a.git(['fetch', '--quiet']);
    for (const ctx of [grimoire.ctx, bobCtx]) {
      const rows = (await ok(grimoire.core.call('list', { status: 'done' }, ctx))).rows.map((row) => row.id);
      expect(rows.sort()).toEqual([fromAlice, fromBob].sort());
    }
  });
});

describe('the detached sync child', () => {
  async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  test('a CLI-style write sets the marker, then a detached child registers a process record, pushes and clears it', async ({
    world,
    grimoire,
    onTestFinished,
  }) => {
    const child = await bundleCallProcess('sync-child.ts');
    onTestFinished(() => child.cleanup());
    // The remote takes a while, so the child is caught alive.
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
    const core = grimoire.makeCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: [child.script, world.a.dir] }) });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await closeOne(core, grimoire.ctx);
    await core.close();

    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 1, 'the child’s process record');
    const running = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(running.pending_since).not.toBeNull();
    expect((await machine.processes.live({ role: 'sync' }))[0]).toMatchObject({ client: 'codex', worktree: world.a.dir });
    await until(async () => (await remoteTracker(world.a)) === (await trackerTip(world.a)), 'the push');
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 0, 'the child to finish');
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ pending_since: null, last_result: 'pushed' });
  });

  test('a child that dies before it syncs leaves the sync-pending marker for upkeep', async ({ world, grimoire }) => {
    const core = grimoire.makeCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: ['-e', 'process.exit(0)'] }) });
    await closeOne(core, grimoire.ctx);
    await core.close();
    await sleep(500);

    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(status.pending_since).not.toBeNull();
    expect(await remoteTracker(world.a)).toBeNull();
  });
});

describe('bounded network steps', () => {
  test('a remote that never answers is cut off at the step timeout as a network failure', async ({ world, grimoire, onTestFinished }) => {
    const server = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    await world.a.git(['remote', 'set-url', 'origin', `http://127.0.0.1:${(server.address() as AddressInfo).port}/remote.git`]);
    const tracker = await openTracker(world.a.dir);
    onTestFinished(() => tracker.close());

    const started = Date.now();
    const outcome = await syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), timeoutMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'network' } });
    expect(outcome.failure?.message).toContain('timed out');
  });
});

describe('concurrent clones', () => {
  test('two clones closing at once with background syncs end up with one tracker on the remote holding every close', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await world.b.git(['fetch', '--quiet']);
    const bobCtx = agentContext(world.b);
    const alice = syncingCore(grimoire);
    const bob = syncingCore(grimoire);
    const closed = await Promise.all([
      ...[1, 2, 3].map((n) => closeOne(alice, grimoire.ctx, `Alice ${n}`)),
      ...[1, 2, 3].map((n) => closeOne(bob, bobCtx, `Bob ${n}`)),
    ]);
    await Promise.all([alice.close(), bob.close()]);
    for (const ctx of [grimoire.ctx, bobCtx, grimoire.ctx]) await ok(grimoire.core.call('sync', {}, ctx));

    const remote = await remoteTracker(world.a);
    for (const [checkout, ctx] of [[world.a, grimoire.ctx], [world.b, bobCtx]] as const) {
      expect(await checkout.gitResult(['merge-base', '--is-ancestor', (await trackerTip(checkout))!, remote!])).toMatchObject({ code: 0 });
      const rows = (await ok(grimoire.core.call('list', { status: 'done' }, ctx))).rows.map((row) => row.id);
      expect(rows.sort()).toEqual([...closed].sort());
    }
  });
});
