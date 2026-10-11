// Version copies (spec §6, §11): installed whole under the install lock with
// their tarball integrity, and pruned only when nothing needs them. Seam 1:
// the installer driven directly, against a real clone and real npm tarballs.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import {
  copyDir,
  installCopy,
  INSTALL_LOCK,
  listCopies,
  pruneCopies,
  UPGRADE_RECORDS,
  type CopySource,
} from '../../src/installer';
import { GrimoireError } from '../../src/errors';
import { MachineLocalStore } from '../../src/machine-local';
import { npmPack, reportingPackage, writeConfig } from './support';

async function pkgListing(store: MachineLocalStore): Promise<string[]> {
  return (await readdir(path.join(store.dir, 'pkg')).catch(() => [] as string[])).sort();
}

describe('installing a copy', () => {
  gitTest('from an npm tarball: unpacked into pkg/<version>/ with .complete recording npm’s integrity', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball, integrity } = npmPack(await reportingPackage(world.root, '1.4.2'), world.root);

    const result = await installCopy(store, '1.4.2', { tarball, integrity });

    expect(result).toEqual({ status: 'installed', version: '1.4.2', dir: copyDir(store, '1.4.2'), integrity });
    expect(JSON.parse(await readFile(path.join(copyDir(store, '1.4.2'), '.complete'), 'utf8'))).toEqual({ integrity });
    expect(await readFile(path.join(copyDir(store, '1.4.2'), 'dist', 'launch.mjs'), 'utf8')).toContain('export async function launch');
    // Nothing but the copy: no temp folder, no trash.
    expect(await pkgListing(store)).toEqual(['1.4.2']);
    expect(await listCopies(store)).toEqual([{ version: '1.4.2', dir: copyDir(store, '1.4.2'), integrity }]);
  });

  gitTest('a tarball given no integrity records the one it hashes to, which is npm’s', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball, integrity } = npmPack(await reportingPackage(world.root, '1.4.2'), world.root);

    const result = await installCopy(store, '1.4.2', { tarball });

    expect(result.integrity).toBe(integrity);
  });

  gitTest('a complete copy already there is left alone', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const source: CopySource = { dir: await reportingPackage(world.root, '1.4.2'), integrity: 'sha512-first' };
    await installCopy(store, '1.4.2', source);

    const again = await installCopy(store, '1.4.2', { dir: source.dir, integrity: 'sha512-second' });

    expect(again).toMatchObject({ status: 'present', integrity: 'sha512-first' });
  });

  gitTest('refused, leaving pkg/ untouched: a tarball that doesn’t match its integrity, another version, another package, a non-strict version', async ({
    world,
  }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball } = npmPack(await reportingPackage(world.root, '1.4.2'), world.root);
    const other = await reportingPackage(path.join(world.root, 'other'), '1.4.2');
    await writeFile(path.join(other, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.4.2' }));

    const attempts: [string, () => Promise<unknown>][] = [
      ['integrity', () => installCopy(store, '1.4.2', { tarball, integrity: 'sha512-AAAA' })],
      ['version', () => installCopy(store, '1.5.0', { tarball })],
      ['package', () => installCopy(store, '1.4.2', { dir: other, integrity: null })],
      ['semver', () => installCopy(store, 'latest', { tarball })],
    ];
    for (const [name, attempt] of attempts) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(GrimoireError);
      expect((error as GrimoireError).code, name).toBe('INVALID');
    }
    expect(await pkgListing(store)).toEqual([]);
  });

  gitTest('a folder at pkg/<version> without .complete is replaced, never loaded as it is', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const source: CopySource = { dir: await reportingPackage(world.root, '1.4.2'), integrity: null };
    await installCopy(store, '1.4.2', source);
    await rm(path.join(copyDir(store, '1.4.2'), '.complete'));
    await writeFile(path.join(copyDir(store, '1.4.2'), 'stray.txt'), 'half-copied');

    const result = await installCopy(store, '1.4.2', source);

    expect(result.status).toBe('installed');
    expect(await readdir(copyDir(store, '1.4.2'))).not.toContain('stray.txt');
  });

  gitTest('waits for another install holding the lock', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const held = await store.locks.acquire(INSTALL_LOCK);
    if (held.status !== 'acquired') throw new Error('lock not acquired');

    const install = installCopy(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await pkgListing(store)).toEqual([]);
    await held.lock.release();

    expect((await install).status).toBe('installed');
  });
});

describe('pruning copies', () => {
  async function installAll(store: MachineLocalStore, parent: string, versions: string[]): Promise<void> {
    for (const version of versions) {
      await installCopy(store, version, { dir: await reportingPackage(parent, version), integrity: null });
    }
  }

  gitTest('never removes a copy a registered worktree pins, a live process runs, or the newest previous version', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['0.9.0', '1.0.0', '1.5.0', '2.0.0', '3.0.0', '4.0.0']);
    const linked = await world.a.addWorktree('old-branch');
    await writeConfig(world.a.dir, '2.0.0');
    await writeConfig(linked.dir, '1.0.0');
    const running = await store.processes.register({ role: 'mcp', client: null, worktree: world.a.dir, pin: '3.0.0', pathSource: null });
    // A record whose process is gone keeps nothing.
    await store.processes.register({ role: 'mcp', client: null, worktree: world.a.dir, pin: '4.0.0', pathSource: null, pid: 2 ** 22 + 17, startTime: 1 });

    const result = await pruneCopies(store);
    await running.unregister();

    expect(result.removed.sort()).toEqual(['0.9.0', '4.0.0']);
    expect(Object.fromEntries(result.kept.map((k) => [k.version, k.why]))).toEqual({
      '1.0.0': ['pinned'],
      '1.5.0': ['previous'],
      '2.0.0': ['pinned'],
      '3.0.0': ['running'],
    });
    expect(await pkgListing(store)).toEqual(['.trash', '1.0.0', '1.5.0', '2.0.0', '3.0.0']);
    expect(await readdir(path.join(store.dir, 'pkg', '.trash'))).toEqual([]);
  });

  gitTest('keeps both sides of an upgrade in progress, and what the caller asks to keep', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.1.0']);
    await writeConfig(world.a.dir, '1.2.0');
    await store.coordination.write(UPGRADE_RECORDS, world.a.dir, { worktree: world.a.dir, from: '1.0.0', to: '2.0.0', started_at: 0 });

    const result = await pruneCopies(store, { keep: ['2.1.0'] });

    expect(result.removed).toEqual([]);
    expect(Object.fromEntries(result.kept.map((k) => [k.version, k.why]))).toEqual({
      '1.0.0': ['upgrading'],
      '1.1.0': ['previous'],
      '1.2.0': ['pinned'],
      '2.0.0': ['upgrading'],
      '2.1.0': ['requested'],
    });
  });

  gitTest('with nothing pinned it keeps the newest copy; leftovers of interrupted installs go; unknown names stay', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['1.0.0', '1.1.0']);
    await rm(path.join(copyDir(store, '1.0.0'), '.complete'));
    const pkg = path.join(store.dir, 'pkg');
    await writeFile(path.join(pkg, 'notes.txt'), 'mine');
    await (await import('node:fs/promises')).mkdir(path.join(pkg, '.tmp-1.2.0-deadbeef', 'dist'), { recursive: true });

    const result = await pruneCopies(store);

    expect(result.kept).toEqual([{ version: '1.1.0', why: ['previous'] }]);
    expect(await pkgListing(store)).toEqual(['.trash', '1.1.0', 'notes.txt']);
  });
});
