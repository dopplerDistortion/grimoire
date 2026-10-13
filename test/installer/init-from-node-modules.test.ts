// `init --from-node-modules` (spec §10 Runtime, §11 Version copies): the
// version copy comes from the host repo's own devDependency, a packed
// grimoire npm installed into its node_modules, when that package is the
// version init installs. Absent, or at another version, it refuses before
// anything is written. Seam 1: the installer's runInit in process, against
// temporary clones; the package is a small packed folder, so no build runs.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitTest, type Clone } from '#harness';
import { readPerson } from '../../src/core/host';
import { listCopies } from '../../src/installer';
import { runInit, type InitFlags } from '../../src/installer/init';
import { MachineLocalStore } from '../../src/machine-local';
import { parseInitArgs } from '../../src/surfaces/cli/init';
import { npmCli, npmPack, reportingPackage } from './support';

const VERSION = '1.0.0-test.7';

const FLAGS: InitFlags = { yes: true, clients: null, excerpts: null, newTracker: false, adapter: false, upgrade: false, fromNodeModules: true };

/** Packs a grimoire package at `version` and installs it as a devDependency of the host repo `clone`; npm's integrity for it. */
async function devDependency(clone: Clone, version: string): Promise<string> {
  const { tarball, integrity } = npmPack(await reportingPackage(path.dirname(clone.dir), version), path.dirname(clone.dir));
  await writeFile(path.join(clone.dir, 'package.json'), `${JSON.stringify({ name: 'host', private: true })}\n`);
  const result = spawnSync(process.execPath, [npmCli(), 'install', '--save-dev', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', tarball], {
    cwd: clone.dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return integrity;
}

async function initFrom(clone: Clone, version = VERSION) {
  return runInit({
    root: clone.dir,
    flags: FLAGS,
    // The running package: a different folder, so the copy's source shows which one init took.
    source: { dir: await reportingPackage(path.join(path.dirname(clone.dir), 'running'), version), integrity: null },
    version,
    person: await readPerson(clone.dir),
    nonce: 'test',
    prompter: null,
    say: () => {},
  });
}

describe('init --from-node-modules', () => {
  it('is a flag of init', () => {
    expect(parseInitArgs(['--yes', '--from-node-modules']).flags).toMatchObject({ yes: true, fromNodeModules: true });
    expect(parseInitArgs(['--yes']).flags.fromNodeModules).toBe(false);
  });

  gitTest('copies the matching devDependency into the store, with the integrity npm recorded for it', { timeout: 180_000 }, async ({ world }) => {
    const integrity = await devDependency(world.a, VERSION);

    const report = await initFrom(world.a);

    expect(report.error).toBeUndefined();
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const [copy] = await listCopies(store);
    expect(copy).toMatchObject({ version: VERSION, integrity });
    const installed = await readFile(path.join(store.dir, 'pkg', VERSION, 'package.json'), 'utf8');
    expect(JSON.parse(installed)).toMatchObject({ name: '@goksening/grimoire', version: VERSION });
  });

  gitTest('refuses before anything is written when node_modules holds another version, or none', { timeout: 180_000 }, async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));

    await expect(initFrom(world.a)).rejects.toMatchObject({
      code: 'INVALID',
      message: expect.stringContaining('node_modules/@goksening/grimoire'),
      details: { version: VERSION, found: null },
    });

    await devDependency(world.a, '1.0.0-test.6');
    await expect(initFrom(world.a)).rejects.toMatchObject({
      code: 'INVALID',
      message: expect.stringMatching(/holds grimoire 1\.0\.0-test\.6.*1\.0\.0-test\.7/),
      details: { version: VERSION, found: '1.0.0-test.6' },
    });
    expect(await listCopies(store)).toEqual([]);
    expect(await world.a.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker'])).toMatchObject({ code: 1 });
  });
});
