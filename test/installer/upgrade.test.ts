// Seam 3 for `init --upgrade` (spec Testing Decisions; §21 Upgrade, the frozen
// cross-pin contract): two releases packed with npm and installed the way npx
// installs them, run as a person runs them in a clone with a linked worktree.
// Each release is reached afterwards only through the frozen bootstrap and the
// shell shim, so what answers is the version copy each worktree pins.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, runCommand, type Checkout } from '#harness';
import { claudeHookArgs, MCP_ENTRY_ARGS } from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';
import { cli, humanEnv } from '../surfaces/cli/support';
import { npxInstall, packGrimoire, runEntry } from './support';

const OLD = '1.0.0-test.1';
const NEW = '1.0.0-test.2';

let packs: Awaited<ReturnType<typeof packGrimoire>>[] = [];
let npxDir: string | undefined;
/** Each release's bin, as npx installed it. */
const bins = new Map<string, string>();
beforeAll(async () => {
  packs = [await packGrimoire(OLD), await packGrimoire(NEW)];
  npxDir = await makeTempDir('grimoire-npx-');
  for (const [i, version] of [OLD, NEW].entries()) {
    const prefix = path.join(npxDir, version);
    await mkdir(prefix);
    bins.set(version, npxInstall(packs[i]!.tarball, prefix));
  }
}, 240_000);
afterAll(async () => {
  for (const pack of packs) await pack.cleanup();
  if (npxDir) await removeDir(npxDir);
});

/** `npx @goksening/grimoire@<version> init …` in `cwd`, without a terminal. */
function init(version: string, cwd: string, args: readonly string[]) {
  return cli(bins.get(version)!, ['init', ...args], { cwd });
}

async function changedPaths(checkout: Checkout): Promise<string[]> {
  const out = await checkout.git(['status', '--porcelain', '--untracked-files=all']);
  return out === '' ? [] : out.split('\n').map((line) => line.slice(3)).sort();
}

/** The version the bootstrap's MCP server reports, started in `cwd` as an agent client starts it. */
async function serverVersion(cwd: string): Promise<string | undefined> {
  const client = new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [...MCP_ENTRY_ARGS], cwd, env: process.env as Record<string, string>, stderr: 'pipe' }));
  try {
    const listed = await client.callTool({ name: 'list', arguments: {} });
    expect(listed.isError).toBeFalsy();
    return client.getServerVersion()?.version;
  } finally {
    await client.close();
  }
}

/** The launcher, one version newer than the one the releases ship (as a later release would write it). */
async function newerLauncher(file: string): Promise<string> {
  const current = await readFile(file, 'utf8');
  const body = current.slice(current.indexOf('\n') + 1).replace(/^const LAUNCHER_VERSION = (\d+);$/m, (_, n: string) => `const LAUNCHER_VERSION = ${Number(n) + 1};`);
  const version = /^const LAUNCHER_VERSION = (\d+);$/m.exec(body)![1];
  const text = `// grimoire-launcher ${version} ${createHash('sha256').update(body, 'utf8').digest('hex')}\n${body}`;
  await writeFile(file, text);
  return text;
}

// Two inits, three MCP servers and the hooks, each a real process: room for a loaded machine.
describe('init --upgrade across two packed releases', { timeout: 300_000 }, () => {
  gitTest('moves one worktree: only its files change, the reported paths are exact, and the other worktree keeps its pin and keeps working', async ({ world }) => {
    const installed = await init(OLD, world.a.dir, ['--yes']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    const other = await world.a.addWorktree('feature');
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    // A later release moved the launcher forward; both releases' bootstraps still run through it.
    const launcher = await newerLauncher(path.join(store.dir, 'launcher.cjs'));

    const run = await init(NEW, world.a.dir, ['--upgrade', '--yes']);

    expect(run.code, run.stdout + run.stderr).toBe(0);
    const report = run.json as Record<string, any>;
    expect(report.upgrade).toMatchObject({ from: OLD, to: NEW, direction: 'upgrade', other_worktrees: [{ worktree: other.dir, pin: OLD }] });
    expect(report.upgrade.commit.paths).toEqual(await changedPaths(world.a));
    expect(report.upgrade.commit.paths).toEqual(['.grimoire/config.yml']);
    expect(report.upgrade.commit.command).toBe(`git add .grimoire/config.yml && git commit -m "Upgrade grimoire to ${NEW}"`);
    expect(await changedPaths(other)).toEqual([]);
    expect(await readFile(path.join(other.dir, '.grimoire/config.yml'), 'utf8')).toMatch(new RegExp(`^version: ${OLD.replace(/\./g, '\\.')}$`, 'm'));
    expect(report.machine.launcher).toBe('kept');

    // Each worktree runs its own pin, through the same frozen bootstrap and the newer launcher.
    expect(await serverVersion(world.a.dir)).toBe(NEW);
    expect(await serverVersion(other.dir)).toBe(OLD);
    for (const [dir, version] of [[world.a.dir, NEW], [other.dir, OLD]] as const) {
      const shim = await runCommand(process.execPath, ['.grimoire/run.cjs', '--version'], { cwd: dir, env: humanEnv() });
      expect(JSON.parse(shim.stdout)).toEqual({ version });
      const hook = await runEntry(claudeHookArgs('session-start'), { cwd: dir, projectDir: dir, input: '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}' });
      expect([hook.code, hook.stderr]).toEqual([0, '']);
      expect(hook.stdout).not.toMatch(/isn't set up/);
    }

    // Back down with the older release's own command: the launcher stays where it is.
    const down = await init(OLD, world.a.dir, ['--upgrade', '--yes']);
    expect(down.code, down.stdout + down.stderr).toBe(0);
    expect((down.json as Record<string, any>).upgrade).toMatchObject({ from: NEW, to: OLD, direction: 'downgrade', commit: { paths: [] } });
    expect(await changedPaths(world.a)).toEqual([]);
    expect(await readFile(path.join(store.dir, 'launcher.cjs'), 'utf8')).toBe(launcher);
    expect(await serverVersion(world.a.dir)).toBe(OLD);
  });
});
