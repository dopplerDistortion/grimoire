// Seam 3 (spec §10): the `grimoire` bin run directly (npx, a global install)
// hands every verb but init, leave and uninstall to the checkout's pinned,
// joined copy through the clone's launcher; with no launcher it prints the
// join command and exits 3. The built bin, real repos, a reporting copy.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, runCommand } from '#harness';
import { notSetUpLine } from '../../../src/installer';
import { MachineLocalStore } from '../../../src/machine-local';
import { joinClone, reportingPackage, reportOf, writeConfig } from '../../installer/support';
import { buildGrimoire, humanEnv } from './support';

let bin: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

function grimoire(args: string[], cwd: string, input = '') {
  return runCommand(process.execPath, [bin, ...args], { cwd, input, env: humanEnv(), timeoutMs: 60_000 });
}

describe('the bin in an installed checkout', () => {
  gitTest('runs the verb in the pinned copy, through the launcher, with the checkout as root', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await writeConfig(world.a.dir, '1.4.2');

    const show = reportOf(await grimoire(['show', 'gr-7k2pq'], world.a.dir));
    const mcp = reportOf(await grimoire(['mcp'], world.a.dir));

    expect(show).toMatchObject({ version: '1.4.2', args: ['show', 'gr-7k2pq'], info: { root: world.a.dir, pin: '1.4.2' } });
    expect(mcp.args).toEqual(['mcp']);
  });

  gitTest('with no launcher: the join command on stderr and exit 3; hooks keep their rules', async ({ world }) => {
    await writeConfig(world.a.dir, '1.4.2');

    const show = await grimoire(['show', 'gr-7k2pq'], world.a.dir);
    const start = await grimoire(['hook', 'session-start'], world.a.dir, '{}');
    const pre = await grimoire(['hook', 'pre-tool-use'], world.a.dir, '{}');

    expect([show.code, show.stdout, show.stderr]).toEqual([3, '', `${notSetUpLine('1.4.2')}\n`]);
    expect([start.code, start.stdout]).toEqual([0, `${notSetUpLine('1.4.2')}\n`]);
    expect([pre.code, pre.stdout, pre.stderr]).toEqual([0, '', '']);
  });

  gitTest('init, leave and uninstall, --version and --help always run as the version invoked', async ({ world }) => {
    await writeConfig(world.a.dir, '1.4.2');

    const version = await grimoire(['--version'], world.a.dir);
    const help = await grimoire(['--help'], world.a.dir);
    const init = await grimoire(['init', '--yes'], world.a.dir);

    expect(version.code).toBe(0);
    expect(help.code).toBe(0);
    // Not the join command: this version answered (it has no `init` verb yet, so a usage error).
    expect(init.stderr).not.toContain('npx @goksening/grimoire@1.4.2 init');
    expect(init.code).toBe(2);
  });
});
