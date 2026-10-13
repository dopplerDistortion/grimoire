// Purge and history (spec §3 Delete and purge, §9 "an error always means
// nothing changed"): a purge's answer about pushed history is never "never
// pushed" for content that is leaving, and once its commit lands it answers
// that it did, whatever the facts it gathers afterwards. Seam 1: the core
// against real git in temp repos; the git that reads pushed history found
// through a pass-through spy on node:child_process, the push held at sync's
// network seam.
import * as childProcess from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { runNetworkGit } from '../../src/tracker/remote';
import { coreTest, fetchTracker, pushTracker, TRACKER_REF } from './support';
import { remoteTracker, withTracker } from './sync-support';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };
const attemptPath = (id: string, attempt: string) => `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const done = await outcome;
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  return done.result;
}

async function endedAttempt(core: Core, ctx: CallContext, title = 'Leaky'): Promise<{ id: string; attempt: string }> {
  const { id } = await ok(core.call('create', { title }, ctx));
  const { attempt } = await ok(core.call('claim', { id }, ctx));
  await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx));
  return { id, attempt };
}

/** Each git that asks pushed history whether it held a path (`rev-list -1 … -- <paths>`) fails to start. */
function pushedHistoryUnreadable(): { restore(): void } {
  const spawn = vi.mocked(childProcess.spawn);
  const real = spawn.getMockImplementation()!;
  spawn.mockImplementation(((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    const asks = command === 'git' && args.includes('rev-list') && args.includes('-1') && args.includes('--');
    return asks ? real('grimoire-no-such-git', [], options) : real(command, args, options);
  }) as typeof childProcess.spawn);
  return { restore: () => spawn.mockImplementation(real) };
}

describe('a purge whose commit landed', () => {
  coreTest('answers that it purged, even when what pushed history holds can’t be read afterwards: then it says it may', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const { id, attempt } = await endedAttempt(core, ctx);
    const unreadable = pushedHistoryUnreadable();
    let purged;
    try {
      purged = await core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx));
    } finally {
      unreadable.restore();
    }

    expect(purged).toMatchObject({ ok: true, result: { attempt, changed: true, history: { pushed: true } } });
    expect(purged.ok && purged.result.history.note).toMatch(/couldn’t tell whether pushed history holds it/);
    expect(await world.a.git(['log', '-1', '--format=%B', TRACKER_REF])).toMatch(/^Grimoire-Op: purge$/m);
    expect(await world.a.git(['rev-list', TRACKER_REF, '--', attemptPath(id, attempt)])).toBe('');
  });
});

describe('a purge while a sync pushes', () => {
  coreTest('never says “never pushed” for content the push is taking, and leaves the segment being pushed as it is', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    let purged: Awaited<ReturnType<Core['call']>> | undefined;

    const synced = await withTracker(world.a, (tracker) =>
      tracker.sync({
        author: { name: 'Alice', email: 'alice@example.com' },
        actor: { kind: 'human', nonce: 'n' },
        timeoutMs: 30_000,
        // The push is on its way when the person purges the trace it carries.
        network: async (cwd, args, options) => {
          if (args[0] === 'push') purged = await core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx));
          return runNetworkGit(cwd, args, options);
        },
      }),
    );

    expect(synced).toMatchObject({ state: 'pushed' });
    const pushed = (await remoteTracker(world.a))!;
    // The push landed what it carried, the trace with it: the purge says pushed history keeps it.
    expect(await world.a.git(['rev-list', '-1', pushed, '--', attemptPath(id, attempt)])).not.toBe('');
    expect(purged).toMatchObject({ ok: true, result: { attempt, changed: true, history: { pushed: true } } });
    expect((purged as { result: { history: { note: string } } }).result.history.note).toMatch(/Pushed history still holds it/);
    // The purge went on top of what was pushed: the next push is a fast-forward, and folds nothing back.
    expect((await world.a.gitResult(['merge-base', '--is-ancestor', pushed, TRACKER_REF])).code).toBe(0);
    expect((await world.a.git(['ls-tree', '-r', '--name-only', TRACKER_REF])).split('\n').filter((file) => file.includes(attempt))).toEqual([`purges/${attempt}.md`]);
  });

  coreTest('a sync that starts its push after a purge pushes the purged history', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);

    const synced = await withTracker(world.a, async (tracker) => {
      let once = true;
      return tracker.sync({
        author: { name: 'Alice', email: 'alice@example.com' },
        actor: { kind: 'human', nonce: 'n' },
        timeoutMs: 30_000,
        // The purge lands after the sync read the remote, before it starts its push.
        network: async (cwd, args, options) => {
          const run = await runNetworkGit(cwd, args, options);
          if (args[0] === 'ls-remote' && once) {
            once = false;
            await ok(core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx)));
          }
          return run;
        },
      });
    });

    expect(synced).toMatchObject({ state: 'pushed' });
    const pushed = (await remoteTracker(world.a))!;
    expect(await world.a.git(['rev-list', '-1', pushed, '--', attemptPath(id, attempt)])).toBe('');
    expect(pushed).toBe(await world.a.git(['rev-parse', TRACKER_REF]));
  });
});

describe('a purge after a push whose outcome sync never learned', () => {
  coreTest('a push that timed out after it landed still counts as pushed: the purge never says “never pushed”, nor rewrites what the remote holds', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    // A single-branch clone: git's push leaves the remote-tracking tracker alone, so only sync could move it.
    await world.a.git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);

    const synced = await withTracker(world.a, (tracker) =>
      tracker.sync({
        author: { name: 'Alice', email: 'alice@example.com' },
        actor: { kind: 'human', nonce: 'n' },
        timeoutMs: 30_000,
        // The push lands, but its git is killed at the timeout before sync hears so.
        network: async (cwd, args, options) => {
          const run = await runNetworkGit(cwd, args, options);
          return args[0] === 'push' ? { ...run, code: null, timedOut: true } : run;
        },
      }),
    );
    expect(synced).toMatchObject({ state: 'pending', reason: 'failed' });
    const pushed = (await remoteTracker(world.a))!;
    expect(await world.a.git(['rev-list', '-1', pushed, '--', attemptPath(id, attempt)])).not.toBe('');

    const purged = await core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx));

    expect(purged).toMatchObject({ ok: true, result: { attempt, changed: true, history: { pushed: true, unpushed_rewritten: 0 } } });
    expect((await world.a.gitResult(['merge-base', '--is-ancestor', pushed, TRACKER_REF])).code).toBe(0);
  });

  coreTest('the next sync, which reads what the remote holds, settles it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await endedAttempt(core, ctx);
    await world.a.git(['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);
    const records = path.join(world.a.dir, '.git', 'grimoire', 'coordination', 'tracker-push');
    const sync = (timedOut: boolean) =>
      withTracker(world.a, (tracker) =>
        tracker.sync({
          author: { name: 'Alice', email: 'alice@example.com' },
          actor: { kind: 'human', nonce: 'n' },
          timeoutMs: 30_000,
          network: async (cwd, args, options) => {
            const run = await runNetworkGit(cwd, args, options);
            return timedOut && args[0] === 'push' ? { ...run, code: null, timedOut: true } : run;
          },
        }),
      );
    await sync(true);
    expect((await readdir(records)).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    expect(await sync(false)).toMatchObject({ state: 'in-sync' });

    expect((await readdir(records)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });
});
