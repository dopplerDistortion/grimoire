import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { buildChild, startChild, type ChildBundle } from '../machine-local/child-process';
import { agentContext, commitToTracker, coreTest as test, issuePath, trackerFile, trackerTip } from './support';

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

async function show(core: Core, ctx: CallContext, input: Record<string, unknown>) {
  const shown = await core.call('show', input, ctx);
  if (!shown.ok) throw new Error(`show failed: ${JSON.stringify(shown.error)}`);
  return shown.result;
}

function machineStore(dir: string): MachineLocalStore {
  return new MachineLocalStore(path.join(dir, '.git'));
}

/** A loopback server that answers the start lock's health probe the way a running `start` does. */
async function healthServer(nonce: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ service: 'grimoire-start', nonce }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('show: relations, comments and links', () => {
  test('children and blockers come with their state; a blocker whose record is gone reads as unknown', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const done = await createIssue(core, ctx, { title: 'Done blocker' });
    const gone = await createIssue(core, ctx, { title: 'Gone blocker' });
    const map = await createIssue(core, ctx, { title: 'Map', blocked_by: [done, gone] });
    const kid = await createIssue(core, ctx, { title: 'Kid', parent: map });
    const record = await trackerFile(world.a, (await trackerTip(world.a))!, issuePath(done));
    await commitToTracker(world.a, {
      [issuePath(done)]: record.replace('status: "open"', 'status: "done"'),
      [issuePath(gone)]: null,
    });

    const shown = await show(core, ctx, { ref: map });

    expect(shown).toMatchObject({
      children: [{ id: kid, title: 'Kid', status: 'open' }],
      blockers: [
        ...[
          { id: done, title: 'Done blocker', status: 'done' },
          { id: gone, title: null, status: 'unknown' },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      ],
      ready: false,
      conflict: null,
      comment_count: 0,
      comments: [],
      cursor: null,
    });
  });

  test('the newest 20 comments come oldest first, with a cursor that pages to older ones', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Chatty' });
    for (let i = 0; i < 25; i++) await core.call('comment', { id, body: `c${i}` }, ctx);

    const first = await show(core, ctx, { ref: id });
    const older = await show(core, ctx, { ref: id, cursor: first.cursor });

    expect(first.comment_count).toBe(25);
    expect(first.comments.map((c) => c.body)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
    expect(first.comments[0]).toEqual({
      id: expect.stringMatching(/^20261011T031508755Z-0-[0-9a-z]{4}$/),
      at: '2026-10-11T03:15:08.755Z',
      kind: 'comment',
      actor: expect.objectContaining({ person: 'alice@example.com', client: 'claude-code' }),
      body: 'c5',
    });
    expect(first.cursor).toEqual(expect.any(String));
    expect(older.comments.map((c) => c.body)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(older.cursor).toBeNull();
    expect(older).not.toHaveProperty('body');
  });

  test('comments: none, a number, or all', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Chatty' });
    for (let i = 0; i < 22; i++) await core.call('comment', { id, body: `c${i}` }, ctx);

    const none = await show(core, ctx, { ref: id, comments: 'none' });
    const three = await show(core, ctx, { ref: id, comments: 3 });
    const all = await show(core, ctx, { ref: id, comments: 'all' });

    expect(none).toMatchObject({ comments: [], comment_count: 22, cursor: null });
    expect(three.comments.map((c) => c.body)).toEqual(['c19', 'c20', 'c21']);
    expect(three.cursor).toEqual(expect.any(String));
    expect(all.comments).toHaveLength(22);
    expect(all.cursor).toBeNull();
  });

  test('a body over ~24 KB is cut well-formed, with truncated and a cursor that continues it', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const body = Array.from({ length: 1500 }, (_, i) => `line ${i}: ✓ “quoted” \\ "escaped" 😀\n`).join('');
    const id = await createIssue(core, ctx, { title: 'Huge spec', body });
    await core.call('comment', { id, body: 'after the body' }, ctx);

    const pages = [await show(core, ctx, { ref: id })];
    while (pages[pages.length - 1]!.cursor && pages.length < 10) {
      pages.push(await show(core, ctx, { ref: id, cursor: pages[pages.length - 1]!.cursor }));
    }

    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(pages[0]).toMatchObject({ truncated: true, comments: [] });
    expect(pages.map((page) => page.body ?? '').join('')).toBe(body);
    expect(pages[1]!.body_from).toBe(pages[0]!.body!.length);
    expect(pages[pages.length - 1]!.comments.map((c) => c.body)).toEqual(['after the body']);
  });

  test('a body cursor goes stale when the issue changes: INVALID', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Huge spec', body: 'x'.repeat(40_000) });
    const first = await show(core, ctx, { ref: id });
    await core.call('update', { id, title: 'Renamed' }, ctx);

    const outcome = await core.call('show', { ref: id, cursor: first.cursor }, ctx);

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { cursor: expect.any(String) } } } });
  });
});

describe('show: local_link', () => {
  let child: ChildBundle;
  beforeAll(async () => {
    child = await buildChild();
  });
  afterAll(async () => {
    await child.cleanup();
  });

  test('without a dashboard, local_link uses the per-clone default port in 47000-47999, the same from every worktree', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });
    const feature = await world.a.addWorktree('feature');

    const fromMain = await show(core, ctx, { ref: id });
    const fromWorktree = await show(core, agentContext(world.a, feature), { ref: id });

    const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)\/issues\//.exec(fromMain.local_link)?.[1]);
    expect(fromMain.local_link).toBe(`http://127.0.0.1:${port}/issues/${id}`);
    expect(port).toBeGreaterThanOrEqual(47000);
    expect(port).toBeLessThanOrEqual(47999);
    expect(fromWorktree.local_link).toBe(fromMain.local_link);
  });

  test('the dashboard.port machine setting overrides the default; a live start lock overrides both', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });
    const store = machineStore(world.a.dir);
    await store.records.write('machine-settings', 'dashboard.port', 47500);

    const fromSetting = await show(core, ctx, { ref: id });
    const running = await healthServer('0123456789abcdef');
    const lock = await store.locks.acquire('start', { data: { port: running.port, nonce: '0123456789abcdef' } });
    const fromLock = await show(core, ctx, { ref: id });
    if (lock.status === 'acquired') await lock.lock.release();
    await running.close();

    expect(fromSetting.local_link).toBe(`http://127.0.0.1:47500/issues/${id}`);
    expect(fromLock.local_link).toBe(`http://127.0.0.1:${running.port}/issues/${id}`);
  });

  test('a start lock whose port does not echo its nonce is stale, and ignored', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });
    const store = machineStore(world.a.dir);
    await store.records.write('machine-settings', 'dashboard.port', 47500);
    const other = await healthServer('fedcba9876543210');
    const lock = await store.locks.acquire('start', { data: { port: other.port, nonce: '0123456789abcdef' } });
    const shown = await show(core, ctx, { ref: id });
    if (lock.status === 'acquired') await lock.lock.release();
    await other.close();

    expect(shown.local_link).toBe(`http://127.0.0.1:47500/issues/${id}`);
  });

  test('a start lock whose process is gone is ignored', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });
    await machineStore(world.a.dir).records.write('machine-settings', 'dashboard.port', 47500);
    const running = await healthServer('0123456789abcdef');
    const holder = await startChild(child, {
      action: 'hold-lock',
      from: world.a.dir,
      name: 'start',
      data: { port: running.port, nonce: '0123456789abcdef' },
    });
    const whileLive = await show(core, ctx, { ref: id });

    // Its port still echoes the nonce: only the holder's process is gone.
    await holder.kill();
    const afterKill = await show(core, ctx, { ref: id });
    await running.close();

    expect(whileLive.local_link).toBe(`http://127.0.0.1:${running.port}/issues/${id}`);
    expect(afterKill.local_link).toBe(`http://127.0.0.1:47500/issues/${id}`);
  });
});

describe('show: the machine marker', () => {
  test('machine-local data from a newer release gives the UPGRADE_REQUIRED envelope (marker: machine), never a raw throw', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });
    const store = machineStore(world.a.dir);
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, 'format'), 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');

    const outcome = await core.call('show', { ref: id }, ctx);

    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'UPGRADE_REQUIRED',
        message: expect.stringContaining('relay the remedies'),
        retryable: false,
        details: {
          marker: 'machine',
          why: 'newer',
          running: VERSION,
          pin: null,
          requires: '2.0.0',
          remedies: [
            { kind: 'upgrade', command: 'npx @goksening/grimoire@2.0.0 init --upgrade', text: expect.any(String) },
            { kind: 'join', command: 'npx @goksening/grimoire@2.0.0 init', text: expect.any(String) },
          ],
        },
      },
    });
  });
});
