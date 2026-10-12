// Sync with a bare remote (spec §4 Sync, §6, §3 Refs; Testing Decisions seam 1):
// the automatic fetch → fold → push after attempt-ending writes, the explicit
// `sync` op, sync-pending markers and the sync status.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { autoSync, createCore, syncNow, syncRequestOf, type CallContext, type Core } from '../../src/core';
import { actorOf } from '../../src/core/context';
import { openTracker, type NetworkGit, type SyncOutcome, type TrackerStore } from '../../src/tracker';
import { runNetworkGit, type NetworkGitRun } from '../../src/tracker/remote';
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
import { git, gitResult, runCommand, type Checkout, type GitWorld } from '#harness';

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

/** Runs `body` with `checkout`'s tracker store open, closing it before the world is removed. */
async function withTracker<T>(checkout: Checkout, body: (tracker: TrackerStore) => Promise<T>): Promise<T> {
  const tracker = await openTracker(checkout.dir);
  try {
    return await body(tracker);
  } finally {
    await tracker.close();
  }
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

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

/** A clone of the world's remote made with extra `git clone` flags, committing as Carol. */
async function cloneWith(world: GitWorld, name: string, flags: readonly string[]): Promise<{ dir: string; ctx: CallContext }> {
  const dir = path.join(world.root, name);
  await git(world.root, ['clone', '--quiet', ...flags, '-c', 'user.name=Carol Example', '-c', 'user.email=carol@example.com', world.remoteUrl, dir]);
  const ctx: CallContext = { ...agentContext(world.b), repo: { root: dir, pin: null }, person: { name: 'Carol Example', email: 'carol@example.com' } };
  return { dir, ctx };
}

async function errorOf(
  outcome: Promise<{ ok: boolean; error?: unknown }>,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const settled = await outcome;
  if (settled.ok) throw new Error('expected an error');
  return settled.error as { code: string; message: string; details: Record<string, unknown> };
}

/** Writes `.grimoire/config.yml` naming tracker root `root` into `dir` (what `init` will commit). */
async function nameRoot(dir: string, root: string): Promise<void> {
  await mkdir(path.join(dir, '.grimoire'), { recursive: true });
  await writeFile(path.join(dir, '.grimoire', 'config.yml'), `version: "0.0.0"\ninstall_format: 1\ntracker_root: "${root}"\n`);
}

/** The root commit R of `checkout`'s tracker. */
function rootOf(checkout: Checkout): Promise<string> {
  return checkout.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
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

describe('around the calling op', () => {
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

describe('two processes in one clone', () => {
  test('a fetch in another process that moves the remote-tracking ref while a push runs is never rewound by that push', async ({
    world,
    grimoire,
  }) => {
    const client = world.a.dir.replaceAll('\\', '/');
    // Before the push returns, the remote moves past it and another process in clone a fetches that.
    const hook = [
      '#!/bin/sh',
      'read old new ref',
      'unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'export GIT_AUTHOR_NAME=Remote GIT_AUTHOR_EMAIL=remote@example.com GIT_COMMITTER_NAME=Remote GIT_COMMITTER_EMAIL=remote@example.com',
      'later=$(git commit-tree "$new^{tree}" -p "$new" -m later)',
      'git update-ref refs/heads/grimoire/tracker "$later"',
      `git -C "${client}" fetch --quiet origin +refs/heads/grimoire/tracker:refs/remotes/origin/grimoire/tracker`,
      '',
    ].join('\n');
    await writeFile(path.join(world.remote, 'hooks', 'post-receive'), hook, { mode: 0o755 });
    // A single-branch clone: no fetch refspec maps grimoire/tracker, so only grimoire moves its remote-tracking ref.
    await world.a.git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);

    expect(await ok(grimoire.core.call('sync', {}, grimoire.ctx))).toMatchObject({ state: 'pushed' });
    const remote = await remoteTracker(world.a);
    expect(remote).not.toBe(await trackerTip(world.a));
    expect(await world.a.git(['rev-parse', 'refs/remotes/origin/grimoire/tracker'])).toBe(remote);
  });
});

describe('the detached sync child', () => {
  test('a process that exits the moment its close answers has already set the sync-pending marker', async ({
    world,
    grimoire,
    onTestFinished,
  }) => {
    const writer = await bundleCallProcess('write-and-exit.ts');
    onTestFinished(() => writer.cleanup());

    const run = await runCommand(process.execPath, [writer.script, world.a.dir], { timeoutMs: 60_000 });
    expect(run).toMatchObject({ code: 0, stderr: '' });
    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(status.pending_since).not.toBeNull();
  });
});

/** How git answers a push that lost a race, by kind: the porcelain summary and what the remote said. */
const LOST_RACES: readonly (readonly [string, string])[] = [
  // The remote moved since the fetch.
  ['[rejected] (fetch first)', ''],
  // Another push moved it while this one ran: the remote's compare-and-set failed.
  ['[remote rejected] (failed to update ref)', "remote: error: cannot lock ref 'refs/heads/grimoire/tracker': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222\n"],
  // Another push held the ref's lock.
  ['[remote rejected] (failed to update ref)', "remote: error: cannot lock ref 'refs/heads/grimoire/tracker': Unable to create '/srv/remote.git/refs/heads/grimoire/tracker.lock': File exists.\n"],
  ['[rejected] (non-fast-forward)', ''],
];

/**
 * A remote busy with other clones' pushes, standing in for sync's network git:
 * each of the first `lost` pushes loses a race, answered the way git answers
 * each kind in turn; the pushes after those reach the real remote. The other
 * clones' pushes never land here, so the remote's refs stay as first listed
 * until a push of Alice's does: each round's `ls-remote` is answered from that
 * listing rather than spawning git again. The pauses before retries are
 * recorded, not waited out.
 */
function busyRemote(lost: number): { network: NetworkGit; pause: (ms: number) => Promise<void>; pushes: () => number; pauses: number[] } {
  let pushes = 0;
  let listing: NetworkGitRun | null = null;
  const pauses: number[] = [];
  const network: NetworkGit = async (cwd, args, options) => {
    if (args[0] === 'ls-remote' && pushes < lost) {
      listing ??= await runNetworkGit(cwd, args, options);
      return listing;
    }
    if (args[0] !== 'push' || ++pushes > lost) return runNetworkGit(cwd, args, options);
    const [summary, said] = LOST_RACES[(pushes - 1) % LOST_RACES.length]!;
    const stdout = `To ${args.at(-2)}\n!\t${args.at(-1)}\t${summary}\nDone\n`;
    return { code: 1, stdout: Buffer.from(stdout), stderr: `${said}error: failed to push some refs to '${args.at(-2)}'\n`, timedOut: false };
  };
  return { network, pause: async (ms) => void pauses.push(ms), pushes: () => pushes, pauses };
}

describe('concurrent clones', () => {
  /**
   * Bob's tracker commit, on the remote under another branch, and an unpushed
   * one from Alice: what a race needs. Returns Bob's commit and a shell line
   * that moves the remote's `grimoire/tracker` to it, once.
   */
  async function raceSetup(world: GitWorld, grimoire: Grimoire): Promise<{ fromBob: string; moveOnce: (gitDir: string) => string }> {
    await pushTracker(world.a);
    await world.b.git(['fetch', '--quiet']);
    await ok(grimoire.core.call('create', { title: 'From Bob' }, agentContext(world.b)));
    await world.b.git(['push', '--quiet', 'origin', 'refs/grimoire/tracker:refs/heads/side']);
    const fromBob = (await trackerTip(world.b))!;
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    const flag = path.join(world.root, 'raced').replaceAll('\\', '/');
    const moveOnce = (gitDir: string) =>
      `if [ ! -e "${flag}" ]; then : > "${flag}"; git --git-dir="${gitDir}" update-ref refs/heads/grimoire/tracker ${fromBob}; fi`;
    return { fromBob, moveOnce };
  }

  /** Alice's sync pushed a fold of her tracker and Bob's. */
  async function expectFoldedPush(world: GitWorld, grimoire: Grimoire, fromBob: string): Promise<void> {
    const synced = await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    const tip = (await trackerTip(world.a))!;
    expect(synced).toMatchObject({ state: 'pushed', fold: tip });
    expect(await remoteTracker(world.a)).toBe(tip);
    expect((await world.a.git(['rev-list', '--parents', '-n', '1', tip])).split(' ')).toContain(fromBob);
    expect((await ok(grimoire.core.call('list', {}, grimoire.ctx))).rows.map((row) => row.title).sort()).toEqual(['From Alice', 'From Bob']);
  }

  test('a push that loses the race before it starts (the remote moved since the fetch) fetches, folds and pushes again', async ({
    world,
    grimoire,
  }) => {
    const { fromBob, moveOnce } = await raceSetup(world, grimoire);
    // Bob's tracker lands on the remote just before Alice's first push reads the remote's refs.
    const script = path.join(world.root, 'race.sh').replaceAll('\\', '/');
    await writeFile(script, ['#!/bin/sh', moveOnce('$1'), 'exec git receive-pack "$1"', ''].join('\n'));
    await world.a.git(['config', 'remote.origin.receivepack', `sh ${script}`]);

    await expectFoldedPush(world, grimoire, fromBob);
  });

  test('a push that loses the race while it runs (the remote’s compare-and-set fails) fetches, folds and pushes again', async ({
    world,
    grimoire,
  }) => {
    const { fromBob, moveOnce } = await raceSetup(world, grimoire);
    // Bob's tracker lands on the remote after Alice's push read the remote's refs, before it updates them.
    const hook = [
      '#!/bin/sh',
      'unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
      moveOnce('.'),
      '',
    ].join('\n');
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), hook, { mode: 0o755 });

    await expectFoldedPush(world, grimoire, fromBob);
  });

  test('a push that meets another push holding the remote’s ref lock fetches, folds and pushes again, with no failure or backoff', async ({
    world,
    grimoire,
  }) => {
    const { fromBob, moveOnce } = await raceSetup(world, grimoire);
    // Bob's push holds the lock on the remote's grimoire/tracker while Alice's tries to take it, then lands.
    const lock = path.join(world.remote, 'refs', 'heads', 'grimoire', 'tracker.lock').replaceAll('\\', '/');
    const flag = path.join(world.root, 'locked').replaceAll('\\', '/');
    const script = path.join(world.root, 'locked.sh').replaceAll('\\', '/');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        `if [ -e "${flag}" ]; then exec git receive-pack "$1"; fi`,
        `: > "${flag}"; : > "${lock}"`,
        'git receive-pack "$1"; code=$?',
        `rm -f "${lock}"; ${moveOnce('$1')}`,
        'exit $code',
        '',
      ].join('\n'),
    );
    await world.a.git(['config', 'remote.origin.receivepack', `sh ${script}`]);

    await expectFoldedPush(world, grimoire, fromBob);
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ failure: null, retry_at: null, pending_since: null });
  });

  test('a push that loses the race round after round to busy clones pushes again each round until it lands, with no failure or backoff', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    const remote = busyRemote(4);

    const synced = await withTracker(world.a, (tracker) =>
      syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), network: remote.network, pause: remote.pause }),
    );
    expect(synced).toMatchObject({ state: 'pushed' });
    expect(remote.pushes()).toBe(5);
    // A pause before every retry, none of them waited out in real time here.
    expect(remote.pauses).toHaveLength(4);
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ failure: null, retry_at: null, pending_since: null });
  });

  test('a push that loses every round records the lost race with no backoff: the next automatic sync tries at once', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    const remote = busyRemote(Infinity);
    const request = syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx));

    const lost = await withTracker(world.a, (tracker) => syncNow(tracker, { ...request, network: remote.network, pause: remote.pause }));
    expect(lost).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'rejected', lostRace: true } });
    expect(remote.pushes()).toBeGreaterThan(2);
    expect(remote.pauses).toHaveLength(remote.pushes() - 1);
    const status = await ok(grimoire.core.call('sync_status', {}, grimoire.ctx));
    expect(status).toMatchObject({ retry_at: null, failure: { class: 'rejected' } });
    expect(status.pending_since).not.toBeNull();

    // The remote is busy, not refusing: no backoff holds the next automatic sync back.
    expect(await withTracker(world.a, (tracker) => autoSync(tracker, request))).toMatchObject({ state: 'pushed' });
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
  });
});
