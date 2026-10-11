import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import {
  locateMachineLocalStore,
  MachineLocalStore,
  type ProcessRecord,
} from '../../src/machine-local';
import { buildChild, startChild, type ChildBundle } from './child-process';

async function storeOf(dir: string): Promise<MachineLocalStore> {
  const store = await locateMachineLocalStore(dir);
  if (!store) throw new Error(`no store at ${dir}`);
  return store;
}

let child: ChildBundle;
beforeAll(async () => {
  child = await buildChild();
});
afterAll(() => child?.cleanup());

describe('process records', () => {
  test('a registered process is listed live with its pid, start time, client, worktree, pin, Node and PATH source', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const before = Date.now();
    const registration = await store.processes.register({
      role: 'mcp',
      client: 'claude-code',
      worktree: world.a.dir,
      pin: '1.0.0',
      pathSource: 'client-env',
    });

    const live = await store.processes.live();
    expect(live).toHaveLength(1);
    expect(live[0]).toEqual(registration.record);
    expect(live[0]).toMatchObject({
      pid: process.pid,
      host: store.host,
      role: 'mcp',
      client: 'claude-code',
      pin: '1.0.0',
      node: process.version,
      path_source: 'client-env',
    });
    expect(live[0]!.start_time).toBeLessThanOrEqual(before);
    expect(live[0]!.start_time).toBeGreaterThan(before - process.uptime() * 1000 - 5_000);

    await registration.unregister();
    expect(await store.processes.live()).toEqual([]);
  });

  test('a registration fills in its client once it is known (a server learns it from its first call), in the same record', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const registration = await store.processes.register({ role: 'mcp', client: null, worktree: world.a.dir, pin: '1.0.0', pathSource: null });

    const updated = await registration.update({ client: 'codex-mcp-client' });

    expect(updated).toEqual({ ...registration.record, client: 'codex-mcp-client' });
    expect(await store.processes.live({ client: 'codex-mcp-client' })).toEqual([updated]);
    expect(await readdir(path.join(store.dir, 'processes'))).toEqual([`${process.pid}-${updated.nonce}.json`]);
    await registration.unregister();
    expect(await store.processes.live()).toEqual([]);
  });

  test('live processes are listed per client, worktree and pin, from any worktree', async ({
    world,
  }) => {
    const feature = await world.a.addWorktree('feature');
    const children = await Promise.all([
      startChild(child, register(world.a.dir, 'claude-code', world.a.dir, '1.0.0')),
      startChild(child, register(feature.dir, 'codex', feature.dir, '1.1.0')),
      startChild(child, register(feature.dir, 'claude-code', feature.dir, '1.1.0')),
    ]);
    try {
      const store = await storeOf(feature.dir);
      const pids = (records: ProcessRecord[]) => records.map((r) => r.pid).sort();

      expect(pids(await store.processes.live())).toEqual(pids(children.map(asRecord)));
      expect(pids(await store.processes.live({ client: 'claude-code' }))).toEqual(
        pids([asRecord(children[0]!), asRecord(children[2]!)]),
      );
      expect(pids(await store.processes.live({ worktree: feature.dir }))).toEqual(
        pids([asRecord(children[1]!), asRecord(children[2]!)]),
      );
      expect(pids(await store.processes.live({ pin: '1.0.0' }))).toEqual([children[0]!.pid]);
      expect(
        pids(await store.processes.live({ client: 'codex', worktree: feature.dir, pin: '1.1.0' })),
      ).toEqual([children[1]!.pid]);
    } finally {
      await Promise.all(children.map((c) => c.kill()));
    }
  });

  test('a record whose pid is gone from this host is stale, and prune removes it', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const running = await startChild(child, register(world.a.dir, 'codex', world.a.dir, '1.0.0'));
    expect((await store.processes.live()).map((r) => r.pid)).toEqual([running.pid]);

    await running.kill();

    expect(await store.processes.live()).toEqual([]);
    expect((await store.processes.stale()).map((r) => r.pid)).toEqual([running.pid]);
    expect((await store.processes.prune()).map((r) => r.pid)).toEqual([running.pid]);
    expect(await store.processes.stale()).toEqual([]);
    expect(await readdir(path.join(store.dir, 'processes'))).toEqual([]);
  });

  test('a record whose pid is alive but started at another time is stale (the pid was reused)', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const now = await store.processes.register({
      role: 'sync',
      client: null,
      worktree: null,
      pin: '1.0.0',
      pathSource: null,
    });
    const reused = await store.processes.register({
      role: 'sync',
      client: null,
      worktree: null,
      pin: '1.0.0',
      pathSource: null,
      pid: process.pid,
      startTime: now.record.start_time - 3_600_000,
    });

    expect((await store.processes.live()).map((r) => r.nonce)).toEqual([now.record.nonce]);
    expect((await store.processes.stale()).map((r) => r.nonce)).toEqual([reused.record.nonce]);
  });

  test('a record from another host is never called stale here', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const elsewhere = new MachineLocalStore(store.commonDir, null, { host: 'another-machine' });
    await elsewhere.processes.register({
      role: 'mcp',
      client: 'codex',
      worktree: null,
      pin: '1.0.0',
      pathSource: null,
      pid: 2 ** 30, // no such pid here
      startTime: 0,
    });

    expect((await store.processes.live()).map((r) => r.host)).toEqual(['another-machine']);
    expect(await store.processes.prune()).toEqual([]);
  });

  test('process records carry no version field', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await store.processes.register({
      role: 'mcp',
      client: 'codex',
      worktree: world.a.dir,
      pin: '1.0.0',
      pathSource: 'login-shell',
    });
    const dir = path.join(store.dir, 'processes');
    const [name] = await readdir(dir);
    const onDisk = JSON.parse(await readFile(path.join(dir, name!), 'utf8')) as object;
    expect(Object.keys(onDisk).sort()).toEqual(
      [
        'client',
        'host',
        'node',
        'nonce',
        'path_source',
        'pid',
        'pin',
        'registered_at',
        'role',
        'start_time',
        'worktree',
      ].sort(),
    );
  });
});

function register(from: string, client: string, worktree: string, pin: string) {
  return { action: 'register', from, client, worktree, pin, pathSource: 'client-env' };
}

function asRecord(running: { firstLine: unknown }): ProcessRecord {
  return running.firstLine as ProcessRecord;
}
