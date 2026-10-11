// The shell shim, `.grimoire/run.cjs` (spec §10, §11): committed, dependency
// free, found by its own location; `run.cjs pin` answers without loading a
// copy. Seam 3: the shim's real text, run by real node in real repos.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, runCommand } from '#harness';
import { installLauncher, joinCommand, notSetUpLine, SHIM_PATH, shimText } from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';
import { joinClone, reportingPackage, reportOf, writeConfig } from './support';

async function writeShim(root: string): Promise<string> {
  const file = path.join(root, SHIM_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, shimText());
  return file;
}

function shim(file: string, args: string[], cwd: string) {
  return runCommand(process.execPath, [file, ...args], { cwd, input: '', timeoutMs: 60_000 });
}

describe('run.cjs pin, answered without loading a copy', () => {
  gitTest('prints the pin and exits 0, with no launcher or copy anywhere', async ({ world }) => {
    const file = await writeShim(world.a.dir);
    await writeConfig(world.a.dir, '2.0.0-rc.1');

    const r = await shim(file, ['pin'], world.root);

    expect([r.code, r.stdout, r.stderr]).toEqual([0, '2.0.0-rc.1\n', '']);
  });

  gitTest('even beside a launcher that would throw if it were loaded', async ({ world }) => {
    const file = await writeShim(world.a.dir);
    await writeConfig(world.a.dir, '1.4.2');
    await mkdir(path.join(world.a.dir, '.git', 'grimoire'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.git', 'grimoire', 'launcher.cjs'), "throw new Error('loaded');\n");

    const r = await shim(file, ['pin'], world.a.dir);

    expect([r.code, r.stdout]).toEqual([0, '1.4.2\n']);
  });

  gitTest('exits 2 with no config.yml (a branch from before the install), so CI fails closed', async ({ world }) => {
    const file = await writeShim(world.a.dir);

    const r = await shim(file, ['pin'], world.a.dir);

    expect([r.code, r.stdout]).toEqual([2, '']);
    expect(r.stderr).toContain('config.yml');
  });

  gitTest('exits 3 for a pin that isn’t strict semver', async ({ world }) => {
    const file = await writeShim(world.a.dir);
    for (const pin of ['latest', '^1.4.2', 'v1.4.2', '1.4', '01.4.2']) {
      await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), `version: ${pin}\ninstall_format: 1\n`);

      const r = await shim(file, ['pin'], world.a.dir);

      expect([r.code, r.stdout], pin).toEqual([3, '']);
      expect(r.stderr, pin).toContain(JSON.stringify(pin));
    }
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), 'install_format: 1\n');
    expect((await shim(file, ['pin'], world.a.dir)).code).toBe(3);
  });
});

describe('run.cjs <verb> runs the pinned copy in this process', () => {
  gitTest('from any cwd, for its own checkout: the copy gets the verb’s args and the shim’s checkout as root', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await writeConfig(world.a.dir, '1.4.2');
    const file = await writeShim(world.a.dir);
    const sub = path.join(world.a.dir, 'docs');
    await mkdir(sub);

    const report = reportOf(await shim(file, ['show', 'gr-7k2pq', '--input', '-'], sub));

    expect(report).toMatchObject({ version: '1.4.2', args: ['show', 'gr-7k2pq', '--input', '-'], info: { root: world.a.dir, pin: '1.4.2' }, cwd: sub });
  });

  gitTest('a linked worktree’s shim reaches the main checkout’s launcher', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    const linked = await world.a.addWorktree('feature');
    await writeConfig(linked.dir, '1.4.2');
    const file = await writeShim(linked.dir);

    const report = reportOf(await shim(file, ['list'], linked.dir));

    expect(report.info).toMatchObject({ root: linked.dir, home: store.dir });
  });

  gitTest('exits 3 with the join command on stderr when this machine has no launcher, or no copy of the pin', async ({ world }) => {
    await writeConfig(world.a.dir, '1.4.2');
    const file = await writeShim(world.a.dir);

    const noLauncher = await shim(file, ['list'], world.a.dir);
    await installLauncher(new MachineLocalStore(path.join(world.a.dir, '.git')));
    const noCopy = await shim(file, ['list'], world.a.dir);

    for (const r of [noLauncher, noCopy]) {
      expect([r.code, r.stdout, r.stderr]).toEqual([3, '', `${notSetUpLine('1.4.2')}\n`]);
      expect(r.stderr).toContain(joinCommand('1.4.2'));
    }
  });
});
