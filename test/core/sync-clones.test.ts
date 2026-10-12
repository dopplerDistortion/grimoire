// Sync with a bare remote (spec §4 Sync, §6), continued from sync.test.ts: sync
// around the calling op, two processes in one clone, the detached sync child,
// and concurrent clones racing for the remote.
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { autoSync, syncNow, syncRequestOf } from '../../src/core';
import { actorOf } from '../../src/core/context';
import type { NetworkGit } from '../../src/tracker';
import { agentContext, bundleCallProcess, coreTest as test, pushTracker, T0, trackerTip, type Grimoire } from './support';
import { git, runCommand, type GitWorld } from '#harness';
import { ok, closeOne, remoteTracker, syncingCore, withTracker, until, busyRemote, LOST_RACES, CONTENDED } from './sync-support';

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
    const remote = busyRemote(4, { landsOn: world.remote });

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
    const remote = busyRemote(Infinity, { landsOn: world.remote });
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

  test.for([...LOST_RACES, ...CONTENDED])('a push rejected as %s while the remote doesn’t move is refused, not a lost race: it fails within three pushes as rejected with the remote’s message, and backs off', async (
    answer,
    { world, grimoire },
  ) => {
    await pushTracker(world.a);
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    const remote = busyRemote(Infinity, { answers: [answer] });

    const refused = await withTracker(world.a, (tracker) =>
      syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), network: remote.network, pause: remote.pause }),
    );
    expect(refused).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'rejected' } });
    expect(refused.failure?.lostRace).toBeUndefined();
    expect(refused.failure?.message).toMatch(/fetch first|but expected|File exists|non-fast-forward/);
    // Three pushes, each followed by a listing that showed the remote hadn't moved.
    expect(remote.pushes()).toBe(3);
    expect(remote.pauses).toHaveLength(3);
    // Once the remote showed no move, a held lock's holder gets at least a quarter second to let go.
    expect(Math.min(...remote.pauses.slice(1))).toBeGreaterThanOrEqual(250);
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ failure: { class: 'rejected' }, retry_at: expect.any(String) });
  });

  test('a push that meets the remote’s ref lock once, held by something that lets go without moving the remote, pushes again and lands, with no failure or backoff', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    // The lock's holder (a server-side pack-refs, say) lets go before the retry; the remote's listing never moves.
    const remote = busyRemote(1, { answers: [CONTENDED[0]!] });

    const synced = await withTracker(world.a, (tracker) =>
      syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), network: remote.network, pause: remote.pause }),
    );
    expect(synced).toMatchObject({ state: 'pushed' });
    expect(remote.pushes()).toBe(2);
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ failure: null, retry_at: null, pending_since: null });
  });

  test('a push that meets the remote’s ref lock as the sync’s time runs out, with no listing after it to tell a race, is recorded as refused and backs off', async ({
    world,
    grimoire,
  }) => {
    await pushTracker(world.a);
    await ok(grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx));
    const refusing = busyRemote(Infinity, { answers: [CONTENDED[0]!] });
    const budgetMs = 60_000;
    // The push takes the rest of the sync's budget: no time is left for a pause and another listing.
    const realNow = Date.now.bind(Date);
    const network: NetworkGit = async (cwd, args, options) => {
      const run = await refusing.network(cwd, args, options);
      if (args[0] === 'push') vi.spyOn(Date, 'now').mockImplementation(() => realNow() + budgetMs);
      return run;
    };

    try {
      const refused = await withTracker(world.a, (tracker) =>
        syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), budgetMs, network, pause: refusing.pause }),
      );
      expect(refused).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'rejected' } });
      expect(refused.failure?.lostRace).toBeUndefined();
      expect(refusing.pushes()).toBe(1);
      expect(refusing.pauses).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(await ok(grimoire.core.call('sync_status', {}, grimoire.ctx))).toMatchObject({ failure: { class: 'rejected' }, retry_at: expect.any(String) });
  });
});
