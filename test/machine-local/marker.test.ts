import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import { locateMachineLocalStore, type MachineLocalStore } from '../../src/machine-local';

async function storeOf(dir: string): Promise<MachineLocalStore> {
  const store = await locateMachineLocalStore(dir);
  if (!store) throw new Error(`no store at ${dir}`);
  return store;
}

/** Writes the machine marker as a later release would have left it. */
async function writeMarker(store: MachineLocalStore, text: string): Promise<void> {
  await mkdir(store.dir, { recursive: true });
  await writeFile(path.join(store.dir, 'format'), text);
}

async function upgradeError(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const error = (await promise.then(
    () => {
      throw new Error('expected UPGRADE_REQUIRED');
    },
    (e: unknown) => e,
  )) as { code?: unknown; retryable?: unknown; details?: Record<string, unknown> };
  expect(error.code).toBe('UPGRADE_REQUIRED');
  expect(error.retryable).toBe(false);
  return error.details!;
}

describe('the machine marker', () => {
  test('the first record write creates the marker: format 1, compat 1, requires 1.0.0', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    expect(await store.marker.read()).toBeUndefined();

    await store.records.write('machine-settings', 'knowledge.pickup', 'ask');

    expect(await store.marker.read()).toEqual({ format: 1, compat: 1, requires: '1.0.0' });
    expect(await readFile(path.join(store.dir, 'format'), 'utf8')).toBe(
      'format: 1\ncompat: 1\nrequires: "1.0.0"\n',
    );
  });

  test('a marker whose compat is newer than this release gives UPGRADE_REQUIRED (marker: machine) for records', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    await store.records.write('sync-status', 'last', { class: 'auth' });
    await writeMarker(store, 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');

    const details = await upgradeError(store.records.read('sync-status', 'last'));
    expect(details).toMatchObject({ marker: 'machine', why: 'newer', requires: '2.0.0' });
    await upgradeError(store.records.write('sync-status', 'last', {}));
    await upgradeError(store.records.list('sync-status'));
    await upgradeError(store.marker.check());
  });

  test('a marker whose compat is older than this release can run against gives UPGRADE_REQUIRED, why older', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    await writeMarker(store, 'format: 0\ncompat: 0\nrequires: "0.1.0"\n');

    const details = await upgradeError(store.records.read('sync-status', 'last'));
    expect(details).toMatchObject({ marker: 'machine', why: 'older' });
  });

  test('coordination data keeps working whatever the marker says', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await writeMarker(store, 'format: 9\ncompat: 9\nrequires: "9.0.0"\n');

    await store.coordination.write('sync-pending', 'tip', { oid: 'abc' });
    expect(await store.coordination.read('sync-pending', 'tip')).toEqual({ oid: 'abc' });
    expect((await store.leases.acquire('sweep', { ttlMs: 1_000 })).status).toBe('acquired');
    expect((await store.locks.acquire('install')).status).toBe('acquired');
    await store.processes.register({
      role: 'mcp',
      client: null,
      worktree: null,
      pin: '1.0.0',
      pathSource: null,
    });
    expect(await store.processes.live()).toHaveLength(1);
  });

  test('a later additive format with compat 1 runs, and its marker and unknown keys are left alone', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const later = 'format: 3\ncompat: 1\nrequires: "1.0.0"\nfuture_key: {"x":1}\n';
    await writeMarker(store, later);

    await store.records.write('join', '1.0.0', { excerpt_mode: 'facts' });
    expect(await store.records.read('join', '1.0.0')).toEqual({ excerpt_mode: 'facts' });
    expect(await store.marker.read()).toMatchObject({ format: 3, compat: 1, requires: '1.0.0' });
    expect(await readFile(path.join(store.dir, 'format'), 'utf8')).toBe(later);
  });
});
