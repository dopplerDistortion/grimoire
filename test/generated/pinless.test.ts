// Generated output exists only where a pin is (spec §15): upkeep at any pin
// removes copies and stubs from a registered worktree that pins no release,
// under every guard (grimoire's exact .gitignore only, never tracked paths,
// every path component lstat'ed, stray edits set aside first, never mid-merge
// or rebase), and a pin coming back brings them back. Seam 1, real worktrees.
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { Checkout } from '#harness';
import { STRAY_EDITS, type StrayEdit } from '../../src/generated';
import { MachineLocalStore } from '../../src/machine-local';
import { runUpkeep } from '../../src/upkeep';
import { coreTest as test } from '../core/support';
import { editSkill, existsIn, expectNoOutput, fileIn, generatedFolders, gitStatus, NOTES, pinAndCommit, writeInto } from './support';

/** Clone a with a `pre-install` branch at its first commit, then grimoire pinned on main; worktree b pinned too. */
async function installedWithHistory(world: { a: Checkout & { addWorktree(name: string): Promise<Checkout> } }) {
  await world.a.git(['branch', 'pre-install']);
  await pinAndCommit(world.a);
  return world.a.addWorktree('b');
}

describe('worktrees that pin no release', () => {
  test('switching a worktree to a pre-install branch removes its generated output, and switching back restores it', async ({ world, grimoire }) => {
    const b = await installedWithHistory(world);
    const core = grimoire.makeCore();
    await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    expect(await fileIn(b, '.grimoire/skills/release-notes/SKILL.md')).toBe(NOTES);

    await b.git(['switch', '--quiet', 'pre-install']);
    const away = await runUpkeep({ root: world.a.dir });

    await expectNoOutput(b, 'release-notes');
    expect(await existsIn(b, '.grimoire')).toBe(false);
    expect(await gitStatus(b)).toBe('');
    expect(away.runs.find((run) => run.part === 'generated-removal')).toMatchObject({ status: 'ran' });
    // Worktree a still pins this release: its output stays.
    expect(await fileIn(world.a, '.grimoire/skills/release-notes/SKILL.md')).toBe(NOTES);

    await b.git(['switch', '--quiet', 'b']);
    await runUpkeep({ root: world.a.dir });

    expect(await fileIn(b, '.grimoire/skills/release-notes/SKILL.md')).toBe(NOTES);
    expect(await fileIn(b, '.claude/skills/grimoire-release-notes/SKILL.md')).toContain('name: grimoire-release-notes');
    expect(await fileIn(b, '.agents/skills/grimoire-release-notes/SKILL.md')).toContain('name: grimoire-release-notes');
    expect(await gitStatus(b)).toBe('');
  });

  test('only folders with grimoire’s exact .gitignore go; tracked paths and paths through a link stay; a changed copy is saved as a stray edit first', async ({
    world,
    grimoire,
  }) => {
    const b = await installedWithHistory(world);
    const core = grimoire.makeCore();
    await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    await b.git(['switch', '--quiet', 'pre-install']);
    // A folder whose .gitignore isn't grimoire's, and one git tracks on this branch.
    await writeInto(b.dir, '.claude/skills/grimoire-kept/SKILL.md', 'kept\n');
    await writeInto(b.dir, '.claude/skills/grimoire-kept/.gitignore', '*\n!SKILL.md\n');
    await writeInto(b.dir, '.claude/skills/grimoire-tracked/SKILL.md', 'tracked\n');
    await writeInto(b.dir, '.claude/skills/grimoire-tracked/.gitignore', '*\n');
    await b.git(['add', '--force', '.claude/skills/grimoire-tracked']);
    await b.git(['commit', '--quiet', '-m', 'a stub committed by hand']);
    // `.agents/skills` here is a link to a folder elsewhere holding a grimoire-looking stub.
    const elsewhere = path.join(world.root, 'elsewhere');
    await writeInto(elsewhere, 'grimoire-release-notes/SKILL.md', 'not in this worktree\n');
    await writeInto(elsewhere, 'grimoire-release-notes/.gitignore', '*\n');
    const { rm } = await import('node:fs/promises');
    await rm(path.join(b.dir, '.agents', 'skills'), { recursive: true, force: true });
    await mkdir(path.join(b.dir, '.agents'), { recursive: true });
    await symlink(elsewhere, path.join(b.dir, '.agents', 'skills'), 'junction');
    // Someone edited the copy.
    await writeInto(b.dir, '.grimoire/skills/release-notes/SKILL.md', `${NOTES}\nMy own extra step.\n`);

    const report = await runUpkeep({ root: world.a.dir });

    expect(await existsIn(b, '.grimoire/skills/release-notes')).toBe(false);
    expect(await existsIn(b, '.claude/skills/grimoire-release-notes')).toBe(false);
    expect(await fileIn(b, '.claude/skills/grimoire-kept/SKILL.md')).toBe('kept\n');
    expect(await fileIn(b, '.claude/skills/grimoire-tracked/SKILL.md')).toBe('tracked\n');
    expect(await fileIn(elsewhere, 'grimoire-release-notes/SKILL.md')).toBe('not in this worktree\n');
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const strays = await store.records.list<StrayEdit>(STRAY_EDITS);
    expect(strays.map((entry) => entry.value)).toEqual([
      expect.objectContaining({ skill: 'release-notes', path: '.grimoire/skills/release-notes/SKILL.md', text: `${NOTES}\nMy own extra step.\n` }),
    ]);
    expect(report.notices).toContainEqual(expect.stringContaining('stray edit to release-notes'));
  });

  test('a worktree mid-merge keeps its generated output until the merge is done', async ({ world, grimoire }) => {
    const b = await installedWithHistory(world);
    const core = grimoire.makeCore();
    await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    await b.git(['switch', '--quiet', 'pre-install']);
    await b.commitFile('shared.txt', 'ours\n');
    await b.git(['switch', '--quiet', '-c', 'theirs', 'HEAD~1']);
    await b.commitFile('shared.txt', 'theirs\n');
    await b.git(['switch', '--quiet', 'pre-install']);
    expect((await b.gitResult(['merge', '--quiet', 'theirs'])).code).not.toBe(0);

    const report = await runUpkeep({ root: world.a.dir });

    for (const folder of generatedFolders('release-notes')) expect(await existsIn(b, folder), folder).toBe(true);
    expect(report.runs.find((run) => run.part === 'generated-removal')?.result).toMatchObject({
      worktrees: [expect.objectContaining({ worktree: b.dir, skipped: 'merge' })],
    });

    await b.git(['merge', '--abort']);
    await runUpkeep({ root: world.a.dir, force: true });
    await expectNoOutput(b, 'release-notes');
  });
});
