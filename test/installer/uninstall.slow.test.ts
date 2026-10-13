// Uninstall's heaviest seam-1 runs (spec §21 Uninstall; §12 init's tracker keyed
// on root R), apart from uninstall.test.ts: each runs uninstall and then init or
// uninstall again, or a core that generates and ejects a skill. Every git step is
// a real process (dozens per run), so on a loaded Windows machine one of these
// takes minutes; they run in the slow project, one file at a time.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { createCore } from '../../src/core';
import { VERSION } from '../../src/version';
import { agentContext } from '../core/support';
import { editSkill, existsIn, generatedFolders, NOTES } from '../generated/support';
import { initIn, replaceTrackerOnRemote } from './init-rules-support';
import { remoteTip, runPrinted, uninstall, unpushedCommit } from './uninstall-run-support';
import { differences, installedTest } from './uninstall-support';

/** The most one of these takes: the file's one install (init and a push), then uninstall and a second heavy run (init, uninstall again, or a skill generated and ejected). */
const HEAVY_MS = 300_000;

describe('uninstall in the clone’s only installed worktree (the heaviest runs)', { timeout: HEAVY_MS }, () => {
  installedTest('a fresh first install afterwards adopts the archived tracker', async ({ world }) => {
    const root = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await uninstall(world.a, ['uninstall']);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'Uninstall grimoire']);

    const { report } = await initIn(world.a.dir);

    expect(report.tracker).toMatchObject({ action: 'adopted', root });
  });

  installedTest('a kept local tracker with a different root from the remote stops a later init, naming both', async ({ world }) => {
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

  installedTest('a run stopped part way through the removal (as a kill would) finishes when run again, leave included', async ({ world, commits }) => {
    const { before } = commits;
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

  installedTest('the active evolved skills are offered for eject: an ejected one is kept as ordinary files, its generated output goes', async ({ world, commits }) => {
    const { before } = commits;
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
