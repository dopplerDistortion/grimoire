// The write path's critical section (spec §4, Write path; ADR 0007): every
// tracker write runs under the fairness lock, one after another, so whatever
// a write costs there is paid once per queued writer. Starting git costs tens
// of milliseconds on Windows and several times that on a busy machine, so a
// write starts no process while it holds the lock: refs are resolved and moved
// through long-lived gits, which must never act on a stale view of them, and
// must not outlive their store or break the write when they die.
//
// The tests here are performance guards, a deliberate exception to "never
// assert on internals" (spec, Testing Decisions): a process start inside the
// lock shows at no interface except as time, which the 40-writer acceptance
// test (concurrency.test.ts) measures end to end. They watch process starts
// through a pass-through spy on node:child_process, and only over the critical
// section: from when a write waiting for the lock takes it until the write
// returns. Readiness is an event (a write asking for the fairness lock), never
// a quiet spell, and no write here is timed. The tests that run against the
// clock, kill gits or put a git that stops answering in place of one are in
// write-path.slow.test.ts (the serial `slow` project).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { commitToTracker, fetchTracker, pushTracker, trackerTip, TRACKER_REF } from './support';
import { insideTheLock, test, UNHURRIED } from './write-path-support';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

describe('the write path', { timeout: 180_000 }, () => {
  test('a warm core starts no process while it holds the fairness lock: refs are resolved and moved through long-lived git', async ({
    world,
    grimoire,
  }) => {
    const core = grimoire.makeCore(UNHURRIED);
    expect(await core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    for (let i = 0; i < 2; i++) {
      const write = await insideTheLock(world.a, () => core.call('create', { title: `Write ${i}` }, grimoire.ctx));

      expect(write.value).toMatchObject({ ok: true });
      expect(write.started).toEqual([]);
    }
    expect(await world.a.git(['rev-list', '--count', (await trackerTip(world.a))!])).toBe('4');
  });

  test('a write ahead of a fetched remote-tracking tracker, with the tracker root named, starts no process inside the lock either', async ({
    world,
    grimoire,
  }) => {
    // What `init` commits: config.yml names the tracker's root, which every tip's history must hold.
    await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
    const root = await world.a.git(['rev-list', '--max-parents=0', TRACKER_REF]);
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), `install_format: 1\ntracker_root: "${root}"\n`);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    await commitToTracker(world.a, { 'notes/another-writer.txt': 'x\n' }, 'another writer');
    const core = grimoire.makeCore(UNHURRIED);
    expect(await core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    const own = await insideTheLock(world.a, () => core.call('create', { title: 'Mine' }, grimoire.ctx));
    // Commits other writers make while this one waits for the lock are walked too.
    const after = await insideTheLock(
      world.a,
      () => core.call('create', { title: 'After others' }, grimoire.ctx),
      async () => {
        for (let i = 0; i < 3; i++) {
          await commitToTracker(world.a, { 'notes/another-writer.txt': `${i}\n` }, 'another writer');
        }
      },
    );

    expect(own.value).toMatchObject({ ok: true });
    expect(own.started).toEqual([]);
    expect(after.value).toMatchObject({ ok: true });
    expect(after.started).toEqual([]);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['merge-base', '--is-ancestor', 'refs/remotes/origin/grimoire/tracker', tip])).toBe('');
  });

  test('in a shallow clone whose tracker history is whole, a warm core starts no process inside the lock either', async ({
    world,
    grimoire,
  }) => {
    // b moves main on by two commits and a fetches only the newest: main's history is cut off in a, the tracker's isn't.
    await world.b.commitFile('one.txt', '1\n');
    await world.b.commitFile('two.txt', '2\n');
    await world.b.git(['push', '--quiet', 'origin', 'main']);
    await world.a.git(['fetch', '--quiet', '--depth', '1', 'origin', 'main']);
    expect(await world.a.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    const core = grimoire.makeCore(UNHURRIED);
    expect(await core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });

    const own = await insideTheLock(world.a, () => core.call('create', { title: 'Mine' }, grimoire.ctx));
    const after = await insideTheLock(
      world.a,
      () => core.call('create', { title: 'After others' }, grimoire.ctx),
      async () => {
        for (let i = 0; i < 3; i++) {
          await commitToTracker(world.a, { 'notes/another-writer.txt': `${i}\n` }, 'another writer');
        }
      },
    );

    expect(own.value).toMatchObject({ ok: true });
    expect(own.started).toEqual([]);
    expect(after.value).toMatchObject({ ok: true });
    expect(after.started).toEqual([]);
    expect(await world.a.git(['rev-list', '--count', (await trackerTip(world.a))!])).toBe('7');
  });

  test('a cold core starts its gits while it waits for the fairness lock, not inside it', async ({
    world,
    grimoire,
  }) => {
    const core = grimoire.makeCore(UNHURRIED);

    const write = await insideTheLock(world.a, () => core.call('create', { title: 'Cold' }, grimoire.ctx));

    expect(write.value).toMatchObject({ ok: true });
    expect(write.started).toEqual([]);
  });
});
