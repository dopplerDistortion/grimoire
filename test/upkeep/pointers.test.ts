// Upkeep's content pointer-file refresh (spec §13; §11 The manifest, drift):
// content entries that drifted from the pinned release's shipped text are
// rewritten and reported as "grimoire refreshed N pointer files: commit them";
// permission-bearing entries never are. Seam 1: upkeep driven directly
// against real checkouts.
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { SHIM_PATH } from '../../src/installer';
import { ADAPTER_DOC, adapterBlockBody, instructionRulesText } from '../../src/installer/texts';
import { MachineLocalStore } from '../../src/machine-local';
import { POINTER_REFRESH_RECORDS, refreshedPointerFiles, runUpkeep } from '../../src/upkeep';
import { installed, read } from './support';

describe('content pointer-file refresh', () => {
  gitTest('rewrites a drifted instruction file and reports it to commit', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');

    const report = await runUpkeep({ root });

    expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
    expect(report.notices).toContain('grimoire refreshed 1 pointer file: commit it');
    expect(report.runs).toContainEqual(
      expect.objectContaining({ part: 'pointer-refresh', status: 'ran', result: expect.objectContaining({ refreshed: ['.claude/rules/grimoire.md'] }) }),
    );
  });

  gitTest('keeps the refreshed files for status until they are committed', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');
    await world.a.git(['commit', '--quiet', '-am', 'my words']);
    const store = new MachineLocalStore(path.join(root, '.git'));

    await runUpkeep({ root });

    expect(await refreshedPointerFiles(store, root)).toMatchObject({ paths: ['.claude/rules/grimoire.md'] });
    await world.a.git(['commit', '--quiet', '-am', 'take the shipped text']);
    expect(await refreshedPointerFiles(store, root)).toBeNull();
    // The next pass drops the record too.
    await runUpkeep({ root, force: true });
    expect(await store.records.list(POINTER_REFRESH_RECORDS)).toEqual([]);
  });

  gitTest('a refreshed file that ends up as committed is nothing to commit', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    // An uncommitted edit that upkeep undoes leaves nothing to commit.
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');
    const store = new MachineLocalStore(path.join(root, '.git'));

    const report = await runUpkeep({ root });

    expect(report.notices).toContain('grimoire refreshed 1 pointer file: commit it');
    expect(await refreshedPointerFiles(store, root)).toBeNull();
  });

  gitTest('refreshes the AGENTS.md and adapter blocks in place, keeping the rest of each file', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const agents = await read(root, 'AGENTS.md');
    await writeFile(path.join(root, 'AGENTS.md'), `# My agents\n\nBe kind.\n\n${agents.replace('## grimoire', '## grimoire (edited)')}\nMore of mine.\n`);
    const adapter = await read(root, ADAPTER_DOC);
    await writeFile(path.join(root, ADAPTER_DOC), adapter.replace('# Issue tracker: grimoire', '# Issue tracker: something else'));

    const report = await runUpkeep({ root });

    expect(await read(root, 'AGENTS.md')).toBe(`# My agents\n\nBe kind.\n\n${agents}\nMore of mine.\n`);
    expect(await read(root, ADAPTER_DOC)).toBe(adapter);
    expect(report.notices).toContain('grimoire refreshed 2 pointer files: commit them');
  });

  gitTest('a drifted superseding adapter block stays the superseding one, above the other tracker’s doc', async ({ world }) => {
    const root = world.a.dir;
    await mkdir(path.join(root, 'docs/agents'), { recursive: true });
    await writeFile(path.join(root, ADAPTER_DOC), '# Issue tracker: GitHub\n\nIssues live on GitHub.\n');
    await installed(root, undefined, { adapter: 'top' });
    const adapter = await read(root, ADAPTER_DOC);
    expect(adapter).toContain(adapterBlockBody({ supersedes: true }));
    await writeFile(path.join(root, ADAPTER_DOC), adapter.replace('# Issue tracker: grimoire', '# Issue tracker: grimoire, mostly'));

    await runUpkeep({ root });

    expect(await read(root, ADAPTER_DOC)).toBe(adapter);
  });

  gitTest('a symlinked folder on the target’s path is skipped and reported, never written through', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const elsewhere = path.join(world.root, 'elsewhere-rules');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'grimoire.md'), 'somebody else’s file\n');
    await rm(path.join(root, '.claude/rules'), { recursive: true });
    // A junction on Windows (no privilege needed), a symlink elsewhere.
    await symlink(elsewhere, path.join(root, '.claude/rules'), process.platform === 'win32' ? 'junction' : 'dir');

    const report = await runUpkeep({ root });

    expect(await readFile(path.join(elsewhere, 'grimoire.md'), 'utf8')).toBe('somebody else’s file\n');
    expect(await readdir(elsewhere)).toEqual(['grimoire.md']);
    const run = report.runs.find((entry) => entry.part === 'pointer-refresh');
    expect(run?.result).toMatchObject({ refreshed: [], skipped: [{ path: '.claude/rules/grimoire.md', why: expect.stringMatching(/\.claude\/rules is a symlink/) }] });
    expect(report.notices).toContainEqual(expect.stringMatching(/^grimoire left \.claude\/rules\/grimoire\.md alone: \.claude\/rules is a symlink/));
  });

  gitTest('a symlinked target file is skipped and reported, never written through', async ({ world, skip }) => {
    const root = world.a.dir;
    await installed(root);
    const elsewhere = path.join(world.root, 'elsewhere.md');
    await writeFile(elsewhere, 'somebody else’s file\n');
    await rm(path.join(root, '.claude/rules/grimoire.md'));
    try {
      await symlink(elsewhere, path.join(root, '.claude/rules/grimoire.md'), 'file');
    } catch (error) {
      // Windows without the symlink privilege (or developer mode): the folder case above covers it.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') skip();
      throw error;
    }

    const report = await runUpkeep({ root });

    expect(await readFile(elsewhere, 'utf8')).toBe('somebody else’s file\n');
    expect((await lstat(path.join(root, '.claude/rules/grimoire.md'))).isSymbolicLink()).toBe(true);
    expect(report.notices).toContainEqual(expect.stringMatching(/^grimoire left \.claude\/rules\/grimoire\.md alone: .*symlink/));
  });

  gitTest('never touches a permission-bearing entry, a hook, the server entry or run.cjs, even when they drifted', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const settings = JSON.parse(await read(root, '.claude/settings.json')) as Record<string, any>;
    settings.permissions.allow = ['Bash(ls)'];
    settings.enabledMcpjsonServers = [];
    settings.hooks.SessionStart[0].hooks[0].timeout = 99;
    const drifted = {
      '.claude/settings.json': `${JSON.stringify(settings, null, 2)}\n`,
      '.mcp.json': `${JSON.stringify({ mcpServers: { grimoire: { command: 'node', args: ['elsewhere.js'] } } }, null, 2)}\n`,
      '.codex/config.toml': (await read(root, '.codex/config.toml')).replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"'),
      [SHIM_PATH]: '// my own shim\n',
    };
    for (const [file, text] of Object.entries(drifted)) await writeFile(path.join(root, file), text);

    const report = await runUpkeep({ root });

    for (const [file, text] of Object.entries(drifted)) expect(await read(root, file), file).toBe(text);
    expect(report.notices.filter((line) => line.includes('refreshed'))).toEqual([]);
  });
});
