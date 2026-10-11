// The launcher (spec §11): what it runs, and when it says grimoire isn't set
// up. The real launcher and the real bootstrap, against real temp repos; the
// copies are reporting packages, so each test sees exactly how a copy was
// entered. test/installer/packed.test.ts runs a real grimoire copy.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitTest, makeTempDir, removeDir } from '#harness';
import {
  claudeHookArgs,
  copyDir,
  inspectLauncher,
  installLauncher,
  launcherPath,
  launcherText,
  LAUNCHER_VERSION,
  MCP_ENTRY_ARGS,
  notSetUpLine,
  writeJoinRecord,
} from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';
import { joinClone, reportingPackage, reportOf, runEntry, writeConfig } from './support';

const CLAUDE_START = JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });

describe('a joined clone runs the pinned copy', () => {
  gitTest('every entry, started in a subdirectory, enters pkg/<pin>/dist/launch.mjs with its own args and the launcher’s info', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await writeConfig(world.a.dir, '1.4.2');
    const sub = path.join(world.a.dir, 'src');
    await mkdir(sub);

    const mcp = reportOf(await runEntry(MCP_ENTRY_ARGS, { cwd: sub }));
    const start = reportOf(await runEntry(claudeHookArgs('session-start'), { cwd: sub, projectDir: world.a.dir, input: CLAUDE_START }));
    const pre = reportOf(await runEntry(claudeHookArgs('pre-tool-use'), { cwd: world.a.dir, projectDir: world.a.dir, input: '{}' }));

    const info = { root: world.a.dir, pin: '1.4.2', home: store.dir, copy: copyDir(store, '1.4.2'), launcher: LAUNCHER_VERSION };
    expect(mcp).toEqual({ version: '1.4.2', args: ['mcp'], info, cwd: sub, stdin: '' });
    expect(start).toEqual({ version: '1.4.2', args: ['--from', world.a.dir, 'hook', 'session-start'], info, cwd: sub, stdin: CLAUDE_START });
    expect(pre).toMatchObject({ version: '1.4.2', args: ['--from', world.a.dir, 'hook', 'pre-tool-use'], info, stdin: '{}' });
  });

  gitTest('mixed pins in one clone: each worktree runs the copy its own config.yml pins', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await joinClone(store, '2.0.0', { dir: await reportingPackage(world.root, '2.0.0'), integrity: null });
    const linked = await world.a.addWorktree('upgrade');
    await writeConfig(world.a.dir, '1.4.2');
    await writeConfig(linked.dir, '2.0.0');

    const main = reportOf(await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir }));
    const other = reportOf(await runEntry(MCP_ENTRY_ARGS, { cwd: linked.dir }));

    expect([main.version, main.info.root]).toEqual(['1.4.2', world.a.dir]);
    expect([other.version, other.info.root, other.info.home]).toEqual(['2.0.0', linked.dir, store.dir]);
  });
});

describe('when this clone can’t run the pin, the launcher says so like the bootstrap does', () => {
  /** A clone with the launcher; `join` and `copy` say whether 1.4.2 is joined and installed. */
  async function cloneWith(root: string, { join, copy }: { join: boolean; copy: boolean }) {
    const store = new MachineLocalStore(path.join(root, '.git'));
    await installLauncher(store);
    if (copy) await joinClone(store, '1.4.2', { dir: await reportingPackage(path.dirname(root), '1.4.2'), integrity: null });
    if (!join) await store.records.remove('join', '1.4.2');
    if (join && !copy) await writeJoinRecord(store, '1.4.2', { excerpt_mode: 'facts', codex_hook_hash: null, joined_at: 0 });
    await writeConfig(root, '1.4.2');
    return store;
  }

  for (const [name, state] of [
    ['no join record for the pin', { join: false, copy: true }],
    ['no copy of the pin', { join: true, copy: false }],
  ] as const) {
    gitTest(`${name}: session-start prints the not-set-up line, mcp writes it to stderr and exits 3, pre-tool-use says nothing`, async ({ world }) => {
      await cloneWith(world.a.dir, state);

      const start = await runEntry(claudeHookArgs('session-start'), { cwd: world.a.dir, projectDir: world.a.dir, input: CLAUDE_START });
      const mcp = await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir });
      const pre = await runEntry(claudeHookArgs('pre-tool-use'), { cwd: world.a.dir, projectDir: world.a.dir });

      expect([start.code, start.stdout, start.stderr]).toEqual([0, `${notSetUpLine('1.4.2')}\n`, '']);
      expect([mcp.code, mcp.stdout, mcp.stderr]).toEqual([3, '', `${notSetUpLine('1.4.2')}\n`]);
      expect([pre.code, pre.stdout, pre.stderr]).toEqual([0, '', '']);
    });
  }

  gitTest('a checkout with no config.yml in a joined clone exits 0 and prints nothing', async ({ world }) => {
    await cloneWith(world.a.dir, { join: true, copy: true });
    const before = await world.a.addWorktree('before-install');

    for (const args of [MCP_ENTRY_ARGS, claudeHookArgs('session-start'), claudeHookArgs('pre-tool-use')]) {
      const r = await runEntry(args, { cwd: before.dir, projectDir: before.dir });
      expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    }
  });

  gitTest('a pin that isn’t strict semver is never run: mcp exits 3 naming it, hooks exit 0', async ({ world }) => {
    await cloneWith(world.a.dir, { join: true, copy: true });
    for (const pin of ['latest', '^1.4.2', 'v1.4.2', '1.4']) {
      await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), `version: ${pin}\n`);

      const mcp = await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir });
      const pre = await runEntry(claudeHookArgs('pre-tool-use'), { cwd: world.a.dir, projectDir: world.a.dir });

      expect(mcp.code, pin).toBe(3);
      expect(mcp.stderr, pin).toContain(JSON.stringify(pin));
      expect(mcp.stdout).toBe('');
      expect([pre.code, pre.stdout]).toEqual([0, '']);
    }
  });

  gitTest('a copy that fails to start fails mcp with the error, never a hook', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(store, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2', { failing: true }), integrity: null });
    await writeConfig(world.a.dir, '1.4.2');

    const mcp = await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir });
    const start = await runEntry(claudeHookArgs('session-start'), { cwd: world.a.dir, projectDir: world.a.dir, input: CLAUDE_START });

    expect(mcp.code).toBe(1);
    expect(mcp.stderr).toContain('the copy failed to start');
    expect([start.code, start.stdout, start.stderr]).toEqual([0, '', '']);
  });
});

describe('the launcher only moves forward', () => {
  async function store(): Promise<{ store: MachineLocalStore; cleanup: () => Promise<void> }> {
    const dir = await makeTempDir('grimoire-launcher-');
    await mkdir(path.join(dir, '.git'));
    return { store: new MachineLocalStore(path.join(dir, '.git')), cleanup: () => removeDir(dir) };
  }

  it('the first install writes it; the same version again keeps it', async () => {
    const { store: s, cleanup } = await store();
    try {
      const first = await installLauncher(s);
      const again = await installLauncher(s);

      expect([first.action, first.version]).toEqual(['written', LAUNCHER_VERSION]);
      expect(again.action).toBe('kept');
      expect(await readFile(launcherPath(s), 'utf8')).toBe(launcherText());
      expect(await inspectLauncher(s)).toEqual({ status: 'intact', version: LAUNCHER_VERSION });
    } finally {
      await cleanup();
    }
  });

  it('a newer intact launcher is never replaced by an older release', async () => {
    const { store: s, cleanup } = await store();
    try {
      // What a later release writes: its own body, under the same frozen header format.
      const body = "'use strict';\nconst LAUNCHER_VERSION = 7;\nmodule.exports = () => {};\n";
      const newer = `// grimoire-launcher 7 ${createHash('sha256').update(body).digest('hex')}\n${body}`;
      await mkdir(s.dir, { recursive: true });
      await writeFile(launcherPath(s), newer);

      const result = await installLauncher(s);

      expect([result.action, result.version]).toEqual(['kept', 7]);
      expect(await readFile(launcherPath(s), 'utf8')).toBe(newer);
    } finally {
      await cleanup();
    }
  });

  it('an older launcher, and one that fails its self-check, are replaced', async () => {
    const { store: s, cleanup } = await store();
    try {
      await installLauncher(s);
      const text = launcherText();
      const cases = {
        // Its hash still matches: intact, but older than this release's.
        older: text.replace(/^\/\/ grimoire-launcher \d+ /, '// grimoire-launcher 0 '),
        truncated: text.slice(0, Math.floor(text.length / 2)),
        edited: text.replace('process.exitCode = 3;', 'process.exitCode = 0;'),
        'no header': text.slice(text.indexOf('\n') + 1),
        empty: '',
      };
      for (const [name, damaged] of Object.entries(cases)) {
        await writeFile(launcherPath(s), damaged);

        const result = await installLauncher(s);

        expect(result.action, name).toBe('replaced');
        expect(await readFile(launcherPath(s), 'utf8'), name).toBe(text);
      }
    } finally {
      await cleanup();
    }
  });

  gitTest('a replaced corrupt launcher runs the copy again', async ({ world }) => {
    const s = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await joinClone(s, '1.4.2', { dir: await reportingPackage(world.root, '1.4.2'), integrity: null });
    await writeConfig(world.a.dir, '1.4.2');
    await writeFile(launcherPath(s), 'module.exports = (');

    const broken = await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir });
    await installLauncher(s);
    const repaired = await runEntry(MCP_ENTRY_ARGS, { cwd: world.a.dir });

    expect(broken.code).not.toBe(0);
    expect(reportOf(repaired).version).toBe('1.4.2');
  });
});
