import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest as test } from '#harness';
import { locateMachineLocalStore, type MachineLocalStore } from '../../src/machine-local';

async function storeOf(dir: string): Promise<MachineLocalStore> {
  const store = await locateMachineLocalStore(dir);
  if (!store) throw new Error(`no store at ${dir}`);
  return store;
}

/** Every file under `dir`, relative, with forward slashes. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

describe('caches', () => {
  test('a missing cache is built and kept; a current one is trusted', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    let builds = 0;
    const build = () => ({ served: ['skill-a'], build: ++builds });

    expect(await store.caches.get('served-set', { version: 2, build })).toEqual({
      served: ['skill-a'],
      build: 1,
    });
    expect(await store.caches.get('served-set', { version: 2, build })).toEqual({
      served: ['skill-a'],
      build: 1,
    });
    expect(builds).toBe(1);
  });

  test('a cache with an older or missing cache version is rebuilt, not trusted', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    await store.caches.get('copy-state', { version: 1, build: () => 'from v1' });

    expect(await store.caches.get('copy-state', { version: 2, build: () => 'from v2' })).toBe(
      'from v2',
    );
    expect(await store.caches.get('copy-state', { version: 2, build: () => 'again' })).toBe(
      'from v2',
    );

    // A cache file that carries no cache version at all.
    const dir = path.join(store.dir, 'caches');
    const [name] = await readdir(dir);
    await writeFile(path.join(dir, name!), JSON.stringify({ name: 'copy-state', value: 'bare' }));
    expect(await store.caches.get('copy-state', { version: 2, build: () => 'rebuilt' })).toBe(
      'rebuilt',
    );
  });

  test('a cache a newer release wrote is rebuilt for this process but left in place', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    await store.caches.get('served-set', { version: 5, build: () => 'newer shape' });

    expect(await store.caches.get('served-set', { version: 4, build: () => 'mine' })).toBe('mine');
    expect(await store.caches.get('served-set', { version: 5, build: () => 'unused' })).toBe(
      'newer shape',
    );
  });

  test('an invalidated cache is rebuilt', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await store.caches.get('served-set', { version: 1, build: () => 'first' });
    await store.caches.invalidate('served-set');
    expect(await store.caches.get('served-set', { version: 1, build: () => 'second' })).toBe(
      'second',
    );
  });
});

describe('documents (coordination and records)', () => {
  test('keys of any shape are stored apart and listed back as given', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const keys = ['abc', 'ABC', 'C:\\work\\repo', '/home/me/repo', 'con', 'x'.repeat(300)];
    for (const [i, key] of keys.entries()) await store.coordination.write('seen-here', key, i);

    for (const [i, key] of keys.entries()) {
      expect(await store.coordination.read('seen-here', key)).toBe(i);
    }
    expect((await store.coordination.list('seen-here')).map((e) => e.key)).toEqual(
      [...keys].sort(),
    );
  });

  test('append keeps entries in order; remove and update-to-undefined delete', async ({
    world,
  }) => {
    const store = await storeOf(world.a.dir);
    const first = await store.records.append('skill-reads', { skill: 'a' });
    const second = await store.records.append('skill-reads', { skill: 'b' });
    expect(first < second).toBe(true);
    expect((await store.records.list('skill-reads')).map((e) => e.value)).toEqual([
      { skill: 'a' },
      { skill: 'b' },
    ]);

    expect(await store.records.remove('skill-reads', first)).toBe(true);
    expect(await store.records.remove('skill-reads', first)).toBe(false);
    await store.records.update('skill-reads', second, () => undefined);
    expect(await store.records.list('skill-reads')).toEqual([]);
  });

  test('coordination documents carry no version field', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await store.coordination.write('runner-backoff', 'claude', { until: 1 });
    const dir = path.join(store.dir, 'coordination', 'runner-backoff');
    const [name] = await readdir(dir);
    const onDisk = JSON.parse(await readFile(path.join(dir, name!), 'utf8')) as object;
    expect(onDisk).toEqual({ key: 'claude', value: { until: 1 } });
  });

  test('concurrent writes leave whole values and no temp files behind', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    const values = Array.from({ length: 30 }, (_, i) => ({ i, pad: String(i).repeat(20_000) }));
    const reads: unknown[] = [];
    await Promise.all([
      ...values.map((v) => store.coordination.write('big', 'one', v)),
      ...values.map(async () => reads.push(await store.coordination.read('big', 'one'))),
    ]);

    for (const read of reads) {
      if (read !== undefined) expect(values).toContainEqual(read);
    }
    expect(values).toContainEqual(await store.coordination.read('big', 'one'));
    expect(await filesUnder(store.dir)).toEqual(['coordination/big/one.json']);
  });

  test('a write goes through while another process briefly holds the file open', async ({
    world,
  }) => {
    // On Windows, renaming onto an open file fails with EPERM until it closes.
    const store = await storeOf(world.a.dir);
    await store.records.write('sync-status', 'last', { n: 1 });
    const file = path.join(store.dir, 'records', 'sync-status', 'last.json');
    const handle = await open(file, 'r');
    const closing = new Promise<void>((resolve) =>
      setTimeout(() => void handle.close().then(resolve), 300),
    );

    await store.records.write('sync-status', 'last', { n: 2 });
    await closing;

    expect(await store.records.read('sync-status', 'last')).toEqual({ n: 2 });
  });

  test('kinds are plain lowercase names', async ({ world }) => {
    const store = await storeOf(world.a.dir);
    await expect(store.coordination.write('../escape', 'k', 1)).rejects.toThrow(TypeError);
    await expect(store.records.read('Upper', 'k')).rejects.toThrow(TypeError);
    await mkdir(store.dir, { recursive: true });
    expect(await readdir(store.dir)).toEqual([]);
  });
});
