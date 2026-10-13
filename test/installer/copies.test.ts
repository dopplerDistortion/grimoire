// Version copies (spec §6, §11): installed whole under the install lock with
// their tarball integrity, and pruned only when nothing needs them. Seam 1:
// the installer driven directly, against a real clone and real npm tarballs.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect } from 'vitest';
import { git, gitTest, makeUnlistable, permissionsApply } from '#harness';
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
import { findGitDirs } from '../../src/machine-local/git-dirs';
import { npmPack, reportingPackage, writeConfig } from './support';

async function pkgListing(store: MachineLocalStore): Promise<string[]> {
  return (await readdir(path.join(store.dir, 'pkg')).catch(() => [] as string[])).sort();
}

interface TarEntry {
  readonly name: string;
  /** ustar typeflag: '0' file, '1' hard link, '2' symlink, '5' folder. */
  readonly type?: string;
  readonly data?: string;
  readonly linkTo?: string;
}

/** A ustar archive built by hand, so it can hold what `npm pack` never writes. */
function tarArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(entry.type ?? '0', 156);
    header.write(entry.linkTo ?? '', 157, 100, 'utf8');
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const MANIFEST: TarEntry = { name: 'package/package.json', data: JSON.stringify({ name: '@goksening/grimoire', version: '1.4.2' }) };
const ENTRY: TarEntry = { name: 'package/dist/launch.mjs', data: 'export async function launch() {}\n' };

describe('installing a copy', () => {
  gitTest('from an npm tarball: unpacked into pkg/<version>/ with .complete recording npm’s integrity', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball, integrity } = npmPack(await reportingPackage(world.root, '1.4.2'), world.root);

    const result = await installCopy(store, '1.4.2', { tarball, integrity });

    expect(result).toEqual({ status: 'installed', version: '1.4.2', dir: copyDir(store, '1.4.2'), integrity });
    // npm's integrity, and each installed file's sha256 for doctor to compare the copy with.
    expect(JSON.parse(await readFile(path.join(copyDir(store, '1.4.2'), '.complete'), 'utf8'))).toEqual({
      integrity,
      files: { 'dist/launch.mjs': expect.stringMatching(/^[0-9a-f]{64}$/), 'package.json': expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
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

  gitTest('a hand-built tarball of the same shape installs, so the refusals below are about what each one adds', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const tarball = path.join(world.root, 'good.tgz');
    await writeFile(tarball, gzipSync(tarArchive([{ name: 'package/', type: '5' }, MANIFEST, ENTRY])));

    expect((await installCopy(store, '1.4.2', { tarball })).status).toBe('installed');
  });

  gitTest('refused, writing nothing outside pkg/ and leaving no temp folder: unsafe paths, links, truncated or non-gzip data', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const archives: Record<string, Buffer> = {
      'parent path': gzipSync(tarArchive([MANIFEST, ENTRY, { name: 'package/../../escaped.txt', data: 'out' }])),
      'absolute path': gzipSync(tarArchive([MANIFEST, ENTRY, { name: '/escaped.txt', data: 'out' }])),
      'drive path': gzipSync(tarArchive([MANIFEST, ENTRY, { name: 'C:escaped.txt', data: 'out' }])),
      symlink: gzipSync(tarArchive([MANIFEST, ENTRY, { name: 'package/link', type: '2', linkTo: '../../escaped.txt' }])),
      'hard link': gzipSync(tarArchive([MANIFEST, ENTRY, { name: 'package/link', type: '1', linkTo: 'package/package.json' }])),
      // The archive ends partway through a file's data.
      truncated: gzipSync(tarArchive([MANIFEST, { ...ENTRY, data: 'x'.repeat(2000) }]).subarray(0, 512 * 3)),
      'not gzip': Buffer.from('this is not a tarball'),
    };

    for (const [name, bytes] of Object.entries(archives)) {
      const tarball = path.join(world.root, 'crafted.tgz');
      await writeFile(tarball, bytes);

      const error = await installCopy(store, '1.4.2', { tarball }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error, name).toBeInstanceOf(GrimoireError);
      expect((error as GrimoireError).code, name).toBe('INVALID');
      expect((error as GrimoireError).message, name).toContain("can't be unpacked");
      expect(await pkgListing(store), name).toEqual([]);
    }
    for (const outside of [path.join(store.dir, 'escaped.txt'), path.join(store.dir, 'pkg', 'escaped.txt'), path.join(world.root, 'escaped.txt')]) {
      expect(existsSync(outside), outside).toBe(false);
    }
  });

  gitTest('a package folder holding a link is refused, never followed', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const dir = await reportingPackage(world.root, '1.4.2');
    await mkdir(path.join(world.root, 'elsewhere'));
    // A junction needs no privilege on Windows; elsewhere a directory symlink.
    await symlink(path.join(world.root, 'elsewhere'), path.join(dir, 'dist', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    const error = await installCopy(store, '1.4.2', { dir, integrity: null }).then(
      () => null,
      (e: unknown) => e,
    );

    expect((error as GrimoireError).code).toBe('INVALID');
    expect((error as GrimoireError).message).toContain('not a regular file');
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

  gitTest.runIf(permissionsApply)('removes nothing when the process records can’t be listed: a live process may run any copy', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['1.0.0', '2.0.0', '3.0.0']);
    await writeConfig(world.a.dir, '3.0.0');
    const running = await store.processes.register({ role: 'mcp', client: null, worktree: world.a.dir, pin: '1.0.0', pathSource: null });
    const undo = await makeUnlistable(path.join(store.dir, 'processes'));
    try {
      await expect(pruneCopies(store)).rejects.toMatchObject({ code: expect.stringMatching(/^(EPERM|EACCES)$/) });
    } finally {
      await undo();
      await running.unregister();
    }
    expect(await pkgListing(store)).toEqual(expect.arrayContaining(['1.0.0', '2.0.0', '3.0.0']));
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

  gitTest('a submodule’s checkout, named by core.worktree, is a registered worktree whose pin is kept', async ({ world }) => {
    const superproject = path.join(world.root, 'super');
    await mkdir(superproject);
    await git(superproject, ['init', '--quiet']);
    await git(superproject, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', world.remoteUrl, 'sub']);
    const dirs = (await findGitDirs(path.join(superproject, 'sub')))!;
    // The submodule's git dir lives in the superproject's .git/modules/, away from its checkout.
    expect(path.basename(path.dirname(dirs.commonDir))).toBe('modules');
    const store = new MachineLocalStore(dirs.commonDir);
    await installAll(store, world.root, ['1.0.0', '2.0.0']);
    await writeConfig(dirs.worktree, '1.0.0');

    const result = await pruneCopies(store);

    expect(result.removed).toEqual(['2.0.0']);
    expect(result.kept).toEqual([{ version: '1.0.0', why: ['pinned'] }]);
  });

  gitTest('a registered worktree whose pin can’t be read now keeps every copy: a main checkout git doesn’t record, a locked worktree that is away', async ({ world }) => {
    // `git clone --separate-git-dir`: the main checkout's .git is a file, and nothing in the git dir names the checkout.
    const separate = path.join(world.root, 'separate.git');
    await git(world.root, ['clone', '--quiet', '--separate-git-dir', separate, world.remoteUrl, 'sep']);
    await git(path.join(world.root, 'sep'), ['worktree', 'add', '--quiet', '-b', 'upgrade', path.join(world.root, 'sep-upgrade')]);
    const store = new MachineLocalStore((await findGitDirs(path.join(world.root, 'sep')))!.commonDir);
    await installAll(store, world.root, ['1.0.0', '1.1.0', '1.2.0']);
    await writeConfig(path.join(world.root, 'sep'), '1.0.0');
    await writeConfig(path.join(world.root, 'sep-upgrade'), '1.2.0');

    const unrecorded = await pruneCopies(store);

    // A linked worktree on removable media: locked, its folder away for now.
    const linked = await world.a.addWorktree('usb');
    const aStore = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(aStore, world.root, ['1.0.0', '1.1.0', '1.2.0']);
    await writeConfig(world.a.dir, '1.2.0');
    await writeConfig(linked.dir, '1.0.0');
    await world.a.git(['worktree', 'lock', linked.dir]);
    await rename(linked.dir, `${linked.dir}-unplugged`);

    const away = await pruneCopies(aStore);

    for (const result of [unrecorded, away]) {
      expect(result.removed).toEqual([]);
      expect(Object.fromEntries(result.kept.map((k) => [k.version, k.why]))).toEqual({
        '1.0.0': ['unknown-pin'],
        '1.1.0': ['previous', 'unknown-pin'],
        '1.2.0': ['pinned', 'unknown-pin'],
      });
    }
  });

  gitTest('a linked worktree whose folder is gone and isn’t locked keeps nothing (git prunes it too)', async ({ world }) => {
    const linked = await world.a.addWorktree('gone');
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await installAll(store, world.root, ['1.0.0', '1.1.0', '1.2.0']);
    await writeConfig(world.a.dir, '1.2.0');
    await writeConfig(linked.dir, '1.0.0');
    await rm(linked.dir, { recursive: true, force: true });

    const result = await pruneCopies(store);

    expect(result.removed).toEqual(['1.0.0']);
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
