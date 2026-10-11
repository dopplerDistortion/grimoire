// The write path's critical section (spec §4, Write path; ADR 0007): every
// tracker write runs under the fairness lock, one after another, so whatever
// a write costs there is paid once per queued writer. Starting git costs tens
// of milliseconds on Windows and several times that on a busy machine, so a
// warm core moves the ref with no new git process. The refs must still be
// resolved fresh on every call.
import * as childProcess from 'node:child_process';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, vi } from 'vitest';
import { MachineLocalStore } from '../../src/machine-local';
import { commitToTracker, coreTest as test, fetchTracker, pushTracker, trackerTip, TRACKER_REF } from './support';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

/** The processes started since `mockClear`, as `command arg…` lines. */
function started(): string[] {
  return [vi.mocked(childProcess.spawn), vi.mocked(childProcess.execFile)].flatMap((fn) =>
    fn.mock.calls.map(([command, args]) =>
      [command, ...(Array.isArray(args) ? args : [])].join(' '),
    ),
  );
}

describe('the write path', () => {
  test('writes through a warm core start no process: the ref is resolved and moved through long-lived git', async ({
    world,
    grimoire,
  }) => {
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();

    for (let i = 0; i < 3; i++) {
      expect(await grimoire.core.call('create', { title: `Write ${i}` }, grimoire.ctx)).toMatchObject({ ok: true });
    }

    expect(started()).toEqual([]);
    expect(await world.a.git(['rev-list', '--count', (await trackerTip(world.a))!])).toBe('5');
  });

  test('writes ahead of a fetched remote-tracking tracker start no process either', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.a);
    await commitToTracker(world.a, { 'notes/another-writer.txt': 'x\n' }, 'another writer');
    expect(await grimoire.core.call('create', { title: 'Warm-up' }, grimoire.ctx)).toMatchObject({ ok: true });
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();

    for (let i = 0; i < 3; i++) {
      expect(await grimoire.core.call('create', { title: `Write ${i}` }, grimoire.ctx)).toMatchObject({ ok: true });
    }
    const ownWrites = started();
    // Commits by other writers since this core last looked are walked too.
    for (let i = 0; i < 3; i++) await commitToTracker(world.a, { 'notes/another-writer.txt': `${i}\n` }, 'another writer');
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();
    expect(await grimoire.core.call('create', { title: 'After others' }, grimoire.ctx)).toMatchObject({ ok: true });

    expect(ownWrites).toEqual([]);
    expect(started()).toEqual([]);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['merge-base', '--is-ancestor', 'refs/remotes/origin/grimoire/tracker', tip])).toBe('');
  });

  test('a cold core starts its gits while it waits for the fairness lock, not inside it', async ({
    world,
    grimoire,
  }) => {
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const held = await machine.locks.acquire('tracker-write');
    if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
    const core = grimoire.makeCore();
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();

    const write = core.call('create', { title: 'Cold' }, grimoire.ctx);
    // The write reads the config and starts the ref updater while it waits; the view loads meanwhile.
    await vi.waitFor(() => {
      expect(started().filter((line) => / update-ref --stdin /.test(line))).toHaveLength(1);
      expect(started().filter((line) => / config -z --get-regexp /.test(line))).toHaveLength(1);
    });
    await setTimeout(200);
    vi.mocked(childProcess.spawn).mockClear();
    vi.mocked(childProcess.execFile).mockClear();
    await held.lock.release();

    expect(await write).toMatchObject({ ok: true });
    expect(started()).toEqual([]);
  });

  test('a write builds on a tip another writer moved, even when packed-refs was rewritten within the same second', async ({
    world,
    grimoire,
  }) => {
    // A long-lived git caches packed-refs and trusts its stat, which can miss a
    // same-size rewrite inside one timestamp tick: the write would build on a
    // stale tip and lose every compare-and-set until BUSY. Each round leaves the
    // tick only a few git commands to pass in, so most rounds stay inside it.
    const core = grimoire.makeCore({ writeBudgetMs: 3_000 });
    expect(await core.call('create', { title: 'First' }, grimoire.ctx)).toMatchObject({ ok: true });
    for (let round = 0; round < 3; round++) {
      await world.a.git(['pack-refs', '--all']);
      // The tip is only in packed-refs now: the core reads it there, then moves the ref.
      expect(await core.call('create', { title: `Mine ${round}` }, grimoire.ctx)).toMatchObject({ ok: true });
      const mine = (await trackerTip(world.a))!;
      const theirs = await world.a.git(['commit-tree', `${mine}^{tree}`, '-p', mine, '-m', 'another writer']);
      await world.a.git(['update-ref', TRACKER_REF, theirs, mine]);
      await world.a.git(['pack-refs', '--all']);

      const after = await core.call('create', { title: `After theirs ${round}` }, grimoire.ctx);

      expect(after).toMatchObject({ ok: true });
      expect(await world.a.git(['rev-parse', `${(await trackerTip(world.a))!}^`])).toBe(theirs);
    }
  });
});
