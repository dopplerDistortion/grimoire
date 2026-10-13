// Uninstall (spec §21 Uninstall; §12 init's tracker keyed on root R). Seam 1:
// the installer's uninstall run against real clones that `init --yes`
// installed, with the person's answers scripted. What the clone holds
// afterwards is checked through git and the file system: the checkout's
// files against the commit before the install, the remote tracker, the local
// tracker ref and the machine-local store. The terminal gate and the built
// bin are seam 3 (uninstall-cli.test.ts); the heaviest runs are in
// uninstall.slow.test.ts.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir } from '#harness';
import { runUninstall } from '../../src/installer/uninstall';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { agentContext } from '../core/support';
import { terminal } from '../generated/support';
import { pushTrackerCommit, remoteTip, runPrinted, tip, uninstall, unpushedCommit } from './uninstall-run-support';
import { differences, installedTest } from './uninstall-support';

/** The most one of these takes beside a full check on a loaded Windows machine (each git step a process start of up to seconds): the file's one install (init and a push, in the first test to ask), then one uninstall run. */
const INSTALLED_MS = 240_000;

describe('uninstall in the clone’s only installed worktree', { timeout: INSTALLED_MS }, () => {
  installedTest('removes exactly the manifest’s entries, leaves the clone too, and never touches the remote tracker; the report gives the commit and the tracker commands', async ({ world, commits }) => {
    const { before } = commits;
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    expect(existsSync(store.dir)).toBe(true);
    const tracker = await remoteTip(world.a);

    const { report, asked, said } = await uninstall(world.a, ['uninstall']);

    expect(asked).toEqual([expect.stringMatching(/Type uninstall to confirm/)]);
    expect(report.problems).toEqual([]);
    expect(report.uninstalled).toBe(true);
    expect(await differences(world.a, before)).toEqual([]);
    // The remote tracker stays as it was; the local ref went, since the remote holds its tip.
    expect(await remoteTip(world.a)).toBe(tracker);
    expect(await tip(world.a, 'refs/grimoire/tracker')).toBeNull();
    expect(report.leave).toMatchObject({ left: true });
    expect(existsSync(store.dir)).toBe(false);
    expect(report.tracker).toEqual({
      remote: 'origin',
      delete: 'git push origin --delete grimoire/tracker',
      archive:
        'git fetch origin +refs/heads/grimoire/tracker:refs/remotes/origin/grimoire/tracker && git push origin refs/remotes/origin/grimoire/tracker:refs/tags/grimoire-tracker-archive && git push origin --force-with-lease=refs/heads/grimoire/tracker:refs/remotes/origin/grimoire/tracker --delete grimoire/tracker',
    });
    expect(report.commit?.paths).toEqual(expect.arrayContaining(['.grimoire/config.yml', '.grimoire/manifest.yml', '.mcp.json', 'AGENTS.md', '.claude/settings.json']));
    expect(report.commit?.command).toMatch(/^git add -A -- .* && git commit -m "Uninstall grimoire"$/);
    expect(report.commit?.pr).toContain('`npx @goksening/grimoire leave`');
    expect(report.commit?.message).toContain('`npx @goksening/grimoire leave`');
    expect(said.join('\n')).toMatch(/stays on the remote as an archive/);
    expect(said.join('\n')).toMatch(/Pushed excerpts stay in the remote’s history/);
  });

  installedTest('the printed archive command fetches first, so the tag holds what teammates pushed since; its delete is refused if the remote moved after that fetch', async ({ world }) => {
    const { report } = await uninstall(world.a, ['uninstall']);
    const steps = report.tracker.archive!.split(' && ');
    expect(steps).toHaveLength(3);
    // A teammate whose server is still installed keeps pushing tracker commits.
    const later = await pushTrackerCommit(world.b, 'later');

    expect(await runPrinted(world.a, steps[0]!)).toBe(0);
    expect(await runPrinted(world.a, steps[1]!)).toBe(0);
    expect(await remoteTip(world.a, 'refs/tags/grimoire-tracker-archive')).toBe(later);
    const latest = await pushTrackerCommit(world.b, 'latest');
    expect(await runPrinted(world.a, steps[2]!)).not.toBe(0);
    expect(await remoteTip(world.a)).toBe(latest);
  });

  installedTest('a read failing once confirmed (the manifest unreadable) is a report that stops at the checkout, never an error; leave removes nothing', async ({ world }) => {
    const manifest = path.join(world.a.dir, '.grimoire', 'manifest.yml');
    const said: string[] = [];
    const env = await makeTempDir('grimoire-uninstall-env-');
    try {
      const report = await runUninstall({
        root: world.a.dir,
        ctx: { ...terminal(agentContext(world.a)), repo: { root: world.a.dir, pin: null } },
        prompter: {
          ask: async () => {
            // Between the confirmation and the removal, the manifest can't be read (EISDIR stands in for EACCES).
            await rm(manifest);
            await mkdir(manifest);
            return 'uninstall';
          },
        },
        say: (text) => said.push(text),
        env: { ...process.env, LOCALAPPDATA: env, XDG_RUNTIME_DIR: env },
        capture: { claudeConfigDir: path.join(env, 'claude'), codexHome: path.join(env, 'codex'), home: env },
      });
      expect(report.uninstalled).toBe(false);
      expect(report.stopped).toBe('checkout');
      expect(report.problems.join('\n')).toMatch(/manifest/);
      expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(true);
      expect(existsSync(path.join(world.a.dir, '.mcp.json'))).toBe(true);
    } finally {
      await removeDir(env);
    }
  });

});

describe('uninstall while another worktree is still installed', { timeout: INSTALLED_MS }, () => {
  installedTest('removes this checkout’s files only: the clone stays joined, and it says to run grimoire leave once the others are uninstalled', async ({ world, commits }) => {
    const { before } = commits;
    const feature = await world.a.addWorktree('feature');
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));

    const { report, said } = await uninstall(world.a, ['uninstall']);

    expect(report.uninstalled).toBe(true);
    expect(report.leave).toBeNull();
    expect(report.still_installed).toEqual([feature.dir]);
    expect(await differences(world.a, before)).toEqual([]);
    expect(existsSync(path.join(feature.dir, '.grimoire', 'config.yml'))).toBe(true);
    expect(existsSync(store.dir)).toBe(true);
    expect(await tip(world.a, 'refs/grimoire/tracker')).not.toBeNull();
    expect(said.join('\n')).toMatch(/run grimoire leave/);
    expect(said.join('\n')).toMatch(/Excerpts already pushed stay in the history of grimoire\/tracker/);
  });
});

describe('the push, while another worktree is still installed', { timeout: INSTALLED_MS }, () => {
  installedTest('with auto-sync off it asks, and pushes the unpushed tracker commits only after the typed confirmation', async ({ world }) => {
    await world.a.addWorktree('feature');
    await unpushedCommit(world.a);
    const local = await tip(world.a, 'refs/grimoire/tracker');
    expect(await remoteTip(world.a)).not.toBe(local);

    const { report, asked } = await uninstall(world.a, ['y', 'uninstall']);

    expect(asked[0]).toMatch(/^Push 1 unpushed tracker commit once you confirm\? \[y\/N\]/);
    expect(report.sync).toMatchObject({ pushed: true });
    expect(await remoteTip(world.a)).toBe(local);
    expect(report.uninstalled).toBe(true);
  });
});

describe('what uninstall refuses, changing nothing', { timeout: INSTALLED_MS }, () => {
  installedTest('a typed confirmation that doesn’t match: nothing is pushed, nothing in the checkout or the store changes', async ({ world, commits }) => {
    const { installed } = commits;
    await unpushedCommit(world.a);
    const local = await tip(world.a, 'refs/grimoire/tracker');
    const remote = await remoteTip(world.a);

    await expect(uninstall(world.a, ['y', 'yes'])).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/not confirmed/) });

    expect(await remoteTip(world.a)).toBe(remote);
    expect(await tip(world.a, 'refs/grimoire/tracker')).toBe(local);
    expect(await differences(world.a, installed)).toEqual([]);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(true);
  });

  installedTest('a merge in progress', async ({ world, commits }) => {
    const { installed } = commits;
    await writeFile(path.join(world.a.dir, '.git', 'MERGE_HEAD'), `${installed}\n`);

    await expect(uninstall(world.a, [])).rejects.toMatchObject({ code: 'INVALID', details: { operation: 'merge' } });
    expect(await differences(world.a, installed)).toEqual([]);
  });

  installedTest('an unknown manifest kind names a release that can handle it', async ({ world, commits }) => {
    const { installed } = commits;
    const manifest = path.join(world.a.dir, '.grimoire', 'manifest.yml');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}  - {"path":"x.json","kind":"yaml-key","hash":"sha256:0","created":true}\n`);
    // The pin that wrote the manifest is a release newer than this one: it knows the kind.
    const newer = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
    const config = path.join(world.a.dir, '.grimoire', 'config.yml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/^version: .*$/m, `version: ${newer}`));

    await expect(uninstall(world.a, [])).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
      details: {
        // The manifest belongs to the install: the one UPGRADE_REQUIRED details shape (spec §5, §9).
        marker: 'install',
        why: 'newer',
        running: VERSION,
        pin: newer,
        requires: newer,
        remedies: [{ kind: 'upgrade', command: `npx @goksening/grimoire@${newer} uninstall`, text: expect.any(String) }],
      },
    });
    expect(await differences(world.a, installed)).toEqual(['.grimoire/config.yml', '.grimoire/manifest.yml']);
  });

  gitTest('a checkout grimoire isn’t installed in', async ({ world }) => {
    await world.a.commitFile('README.md', '# host\n');
    await expect(uninstall(world.a, [])).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/isn't installed/) });
  });
});
