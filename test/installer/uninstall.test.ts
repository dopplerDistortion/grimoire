// Uninstall (spec §21 Uninstall; §12 init's tracker keyed on root R). Seam 1:
// the installer's uninstall run against real clones that `init --yes`
// installed, with the person's answers scripted. What the clone holds
// afterwards is checked through git and the file system: the checkout's
// files against the commit before the install, the remote tracker, the local
// tracker ref and the machine-local store. The terminal gate and the built
// bin are seam 3 (uninstall-cli.test.ts).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, type Clone } from '#harness';
import { createCore } from '../../src/core';
import { runUninstall, type UninstallOptions, type UninstallReport } from '../../src/installer/uninstall';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { agentContext } from '../core/support';
import { editSkill, existsIn, generatedFolders, NOTES, terminal } from '../generated/support';
import { initIn, replaceTrackerOnRemote } from './init-rules-support';
import { answering } from './leave-support';
import { differences, installedRepo } from './uninstall-support';

interface Uninstalling {
  report: UninstallReport;
  asked: string[];
  said: string[];
}

/** Runs uninstall in `clone` (or `root`) as its person at a terminal, answering in order. */
async function uninstall(clone: Clone, answers: string[], options: Partial<UninstallOptions> & { root?: string } = {}): Promise<Uninstalling> {
  const prompter = answering(...answers);
  const said: string[] = [];
  const env = await makeTempDir('grimoire-uninstall-env-');
  try {
    const root = options.root ?? clone.dir;
    const report = await runUninstall({
      root,
      ctx: { ...terminal(agentContext(clone)), repo: { root, pin: null } },
      prompter,
      say: (text) => said.push(text),
      env: { ...process.env, LOCALAPPDATA: env, XDG_RUNTIME_DIR: env },
      capture: { claudeConfigDir: path.join(env, 'claude'), codexHome: path.join(env, 'codex'), home: env },
      ...options,
    });
    return { report, asked: prompter.asked, said };
  } finally {
    await removeDir(env);
  }
}

async function tip(clone: Clone, ref: string): Promise<string | null> {
  const run = await clone.gitResult(['rev-parse', '--verify', '--quiet', ref]);
  return run.code === 0 ? run.stdout.trim() : null;
}

async function remoteTip(clone: Clone, ref = 'refs/heads/grimoire/tracker'): Promise<string> {
  return (await clone.git(['ls-remote', 'origin', ref])).split('\t')[0]!;
}

/** A teammate's tracker commit on top of the remote's tip, pushed from `clone`; its sha. */
async function pushTrackerCommit(clone: Clone, message: string): Promise<string> {
  await clone.git(['fetch', '--quiet', 'origin', 'refs/heads/grimoire/tracker']);
  const tip = await clone.git(['rev-parse', 'FETCH_HEAD']);
  const sha = await clone.git(['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', message]);
  await clone.git(['push', '--quiet', 'origin', `${sha}:refs/heads/grimoire/tracker`]);
  return sha;
}

/** Runs one printed `git …` command (it quotes nothing) in `clone`; its exit code. */
async function runPrinted(clone: Clone, command: string): Promise<number> {
  const [git, ...args] = command.split(' ');
  expect(git).toBe('git');
  return (await clone.gitResult(args)).code ?? -1;
}

/** A tracker commit the remote doesn't hold, with auto-sync off: uninstall asks before it pushes. */
async function unpushedCommit(clone: Clone): Promise<void> {
  const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
  try {
    const ctx = terminal(agentContext(clone));
    expect(await core.call('settings_set', { key: 'auto-sync', value: false }, ctx)).toMatchObject({ ok: true });
  } finally {
    await core.close();
  }
}

describe('uninstall in the clone’s only installed worktree', () => {
  gitTest('removes exactly the manifest’s entries, leaves the clone too, and never touches the remote tracker; the report gives the commit and the tracker commands', async ({ world }) => {
    const { before } = await installedRepo(world.a);
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

  gitTest('the printed archive command fetches first, so the tag holds what teammates pushed since; its delete is refused if the remote moved after that fetch', async ({ world }) => {
    await installedRepo(world.a);
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

  gitTest('a fresh first install afterwards adopts the archived tracker', async ({ world }) => {
    await installedRepo(world.a);
    const root = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await uninstall(world.a, ['uninstall']);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'Uninstall grimoire']);

    const { report } = await initIn(world.a.dir);

    expect(report.tracker).toMatchObject({ action: 'adopted', root });
  });

  gitTest('a kept local tracker with a different root from the remote stops a later init, naming both', async ({ world }) => {
    await installedRepo(world.a);
    await unpushedCommit(world.a);
    const kept = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    const { report } = await uninstall(world.a, ['n', 'uninstall']);
    expect(report.leave?.kept.tracker_ref).toMatchObject({ command: 'git update-ref -d refs/grimoire/tracker' });
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'Uninstall grimoire']);
    // Someone mints a new tracker on the remote meanwhile.
    const other = await replaceTrackerOnRemote(world.b);

    await expect(initIn(world.a.dir)).rejects.toMatchObject({ details: expect.objectContaining({ local_root: kept, remote_root: other }) });
  });

  gitTest('a run stopped part way through the removal (as a kill would) finishes when run again, leave included', async ({ world }) => {
    const { before } = await installedRepo(world.a);
    let steps = 0;
    await expect(
      uninstall(world.a, ['uninstall'], {
        onRemovalStep: () => {
          if (++steps === 4) throw new Error('killed');
        },
      }),
    ).rejects.toThrow('killed');
    expect(existsSync(path.join(world.a.dir, '.grimoire', 'manifest.yml'))).toBe(true);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(true);

    const { report } = await uninstall(world.a, ['uninstall']);

    expect(report.uninstalled).toBe(true);
    expect(report.leave).toMatchObject({ left: true });
    expect(await differences(world.a, before)).toEqual([]);
  });

  gitTest('a read failing once confirmed (the manifest unreadable) is a report that stops at the checkout, never an error; leave removes nothing', async ({ world }) => {
    await installedRepo(world.a);
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

  gitTest('the active evolved skills are offered for eject: an ejected one is kept as ordinary files, its generated output goes', async ({ world }) => {
    const { before } = await installedRepo(world.a);
    // The core in this process generates output only in a worktree on its own pin.
    const config = path.join(world.a.dir, '.grimoire', 'config.yml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/^version: .*$/m, `version: ${VERSION}`));
    await world.a.git(['commit', '--quiet', '-am', 'pin this build']);
    const core = createCore({ autoSync: 'off' });
    try {
      await editSkill(core, agentContext(world.a), { name: 'release-notes', text: NOTES, base: null });
    } finally {
      await core.close();
    }
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(true);

    const { report, asked, said } = await uninstall(world.a, ['all', 'uninstall']);

    expect(asked[0]).toMatch(/Eject any into this checkout/);
    expect(asked[1]).toMatch(/Type uninstall to confirm/);
    // Auto-sync is on: the skill's and the eject's commits are pushed before leave removes the local ref.
    expect(said.join('\n')).toMatch(/Auto-sync is on: leave pushes 1 unpushed tracker commit, plus what ejecting writes first/);
    expect(report.leave?.removed.tracker_ref).toBe(await remoteTip(world.a));
    expect(report.ejected).toEqual([expect.objectContaining({ name: 'release-notes', files: ['.claude/skills/release-notes/SKILL.md', '.agents/skills/release-notes/SKILL.md'] })]);
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(false);
    expect(await readFile(path.join(world.a.dir, '.claude', 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toBe(NOTES);
    expect(await differences(world.a, before)).toEqual(['.agents/skills/release-notes/SKILL.md', '.claude/skills/release-notes/SKILL.md']);
    expect(report.uninstalled).toBe(true);
    // The ejected skill is part of the commit to make, so the team keeps it.
    expect(report.commit?.paths).toEqual(expect.arrayContaining(['.claude/skills/release-notes/SKILL.md', '.agents/skills/release-notes/SKILL.md']));
    expect(report.commit?.message).toContain('release-notes');
    expect(await runPrinted(world.a, report.commit!.command.split(' && ')[0]!)).toBe(0);
    expect(await world.a.git(['diff', '--cached', '--name-only', '--diff-filter=A', '--', '.claude/skills', '.agents/skills'])).toBe('.agents/skills/release-notes/SKILL.md\n.claude/skills/release-notes/SKILL.md');
  });
});

describe('uninstall while another worktree is still installed', () => {
  gitTest('removes this checkout’s files only: the clone stays joined, and it says to run grimoire leave once the others are uninstalled', async ({ world }) => {
    const { before } = await installedRepo(world.a);
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

describe('the push, while another worktree is still installed', () => {
  gitTest('with auto-sync off it asks, and pushes the unpushed tracker commits only after the typed confirmation', async ({ world }) => {
    await installedRepo(world.a);
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

describe('what uninstall refuses, changing nothing', () => {
  gitTest('a typed confirmation that doesn’t match: nothing is pushed, nothing in the checkout or the store changes', async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    await unpushedCommit(world.a);
    const local = await tip(world.a, 'refs/grimoire/tracker');
    const remote = await remoteTip(world.a);

    await expect(uninstall(world.a, ['y', 'yes'])).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/not confirmed/) });

    expect(await remoteTip(world.a)).toBe(remote);
    expect(await tip(world.a, 'refs/grimoire/tracker')).toBe(local);
    expect(await differences(world.a, installed)).toEqual([]);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(true);
  });

  gitTest('a merge in progress', async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    await writeFile(path.join(world.a.dir, '.git', 'MERGE_HEAD'), `${installed}\n`);

    await expect(uninstall(world.a, [])).rejects.toMatchObject({ code: 'INVALID', details: { operation: 'merge' } });
    expect(await differences(world.a, installed)).toEqual([]);
  });

  gitTest('an unknown manifest kind names a release that can handle it', async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    const manifest = path.join(world.a.dir, '.grimoire', 'manifest.yml');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}  - {"path":"x.json","kind":"yaml-key","hash":"sha256:0","created":true}\n`);
    // The pin that wrote the manifest is a release newer than this one: it knows the kind.
    const newer = `${Number(VERSION.split('.')[0]) + 1}.0.0`;
    const config = path.join(world.a.dir, '.grimoire', 'config.yml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(/^version: .*$/m, `version: ${newer}`));

    await expect(uninstall(world.a, [])).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
      details: { marker: 'manifest', remedies: [`npx @goksening/grimoire@${newer} uninstall`] },
    });
    expect(await differences(world.a, installed)).toEqual(['.grimoire/config.yml', '.grimoire/manifest.yml']);
  });

  gitTest('a checkout grimoire isn’t installed in', async ({ world }) => {
    await world.a.commitFile('README.md', '# host\n');
    await expect(uninstall(world.a, [])).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/isn't installed/) });
  });
});
