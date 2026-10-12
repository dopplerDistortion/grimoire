// Sync against the clock (spec §4 Sync; Testing Decisions seam 1): remotes that
// refuse credentials, hold every answer back, or never answer, and the time
// bounds that keep a call or a sync from hanging on them. In the serial `slow`
// project (npm run test:slow); the rest of sync is in sync.test.ts.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { autoSync, createCore, spawnedAutoSync, syncNow, syncRequestOf, type CallContext, type Core } from '../../src/core';
import { actorOf } from '../../src/core/context';
import { openTracker, type SyncOutcome, type TrackerStore } from '../../src/tracker';
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
    // A credential helper that, like Git Credential Manager, prompts (here: hangs) unless told never to.
    const helper = path.join(world.root, 'credential-helper.sh').replaceAll('\\', '/');
    await writeFile(helper, '#!/bin/sh\n[ "$GCM_INTERACTIVE" = never ] && [ "$SSH_ASKPASS_REQUIRE" = never ] || sleep 60\nexit 0\n');
    await world.a.git(['config', 'credential.helper', `!sh ${helper}`]);
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
    const asked = Date.now();
    const synced = await ok(grimoire.core.call('sync', {}, grimoire.ctx));
    expect(Date.now() - asked).toBeLessThan(15_000);
    expect(synced).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'auth' } });
    expect(synced.failure?.message).toMatch(/terminal prompts disabled|could not read Username/i);
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
    const { id } = await ok(core.call('create', { title: 'Fix the flaky test' }, grimoire.ctx));
    const { attempt } = await ok(core.call('claim', { id }, grimoire.ctx));

    const started = Date.now();
    await ok(core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, grimoire.ctx));
    const took = Date.now() - started;
    const shown = await ok(core.call('show', { ref: id }, grimoire.ctx));
    await until(async () => requests > 0, 'the sync to reach the remote');
    // The remote holds every answer back, so a close that waited for its sync would wait out the 20 s step timeout.
    expect(took).toBeLessThan(5_000);
    expect(shown.status).toBe('done');
    release();
    await core.close();
  });
});

describe('bounded network steps', () => {
  /** Points clone a's origin at an HTTP server that never answers. */
  async function silentRemote(world: GitWorld, onTestFinished: (fn: () => Promise<void>) => void): Promise<void> {
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
  }

  test('a remote that never answers is cut off at the step timeout as a network failure', async ({ world, grimoire, onTestFinished }) => {
    await silentRemote(world, onTestFinished);

    const started = Date.now();
    const outcome = await withTracker(world.a, (tracker) =>
      syncNow(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), timeoutMs: 1_500 }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'network' } });
    expect(outcome.failure?.message).toContain('timed out');
  });

  test('an automatic sync stops at its budget as a whole, however long each step may take', async ({ world, grimoire, onTestFinished }) => {
    await silentRemote(world, onTestFinished);

    const started = Date.now();
    const outcome = await withTracker(world.a, (tracker) =>
      autoSync(tracker, { ...syncRequestOf(grimoire.ctx, actorOf(grimoire.ctx)), timeoutMs: 60_000, budgetMs: 1_500 }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'network' } });
    expect((outcome as SyncOutcome).failure?.message).toContain('timed out');
  });
});

// Two clones racing each other through one remote: real concurrent writers, so it runs here, with the
// machine to itself, rather than beside the main suite (the lost races it takes are in sync.test.ts).
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

    // The background syncs alone: no explicit sync runs.
    const remote = (await remoteTracker(world.a))!;
    const clones = [[world.a, grimoire.ctx], [world.b, bobCtx]] as const;
    // Both clones' sync status first: a sync that failed names its cause before any list falls short.
    for (const [checkout, ctx] of clones) {
      expect(await ok(grimoire.core.call('sync_status', {}, ctx))).toMatchObject({ failure: null, pending_since: null });
      // Asked of the remote, which has every object: the remote holds this clone's tip.
      expect(await gitResult(world.remote, ['merge-base', '--is-ancestor', (await trackerTip(checkout))!, remote])).toMatchObject({ code: 0 });
    }
    for (const [checkout, ctx] of clones) {
      await checkout.git(['fetch', '--quiet']);
      const rows = (await ok(grimoire.core.call('list', { status: 'done' }, ctx))).rows.map((row) => row.id);
      expect(rows.sort()).toEqual([...closed].sort());
    }
  });
});
