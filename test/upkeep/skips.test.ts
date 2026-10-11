// When upkeep skips (spec §13 When it skips; §21 step 2): the per-worktree
// part leaves a worktree alone mid-merge, in a process whose version differs
// from its pin, and while an upgrade-in-progress record names another pin;
// clone-wide parts carry on through all of these. Seam 1, real worktrees.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, type Checkout, type RunResult } from '#harness';
import { UPGRADE_RECORDS } from '../../src/installer';
import { instructionRulesText } from '../../src/installer/texts';
import { MachineLocalStore } from '../../src/machine-local';
import { runUpkeep, type GitOperation, type UpkeepPart } from '../../src/upkeep';
import { VERSION } from '../../src/version';
import { installed, read } from './support';

const DRIFTED = '# grimoire\n\nmy own words\n';

/** A clone-wide part that only notes it ran. */
function clonePart(ran: string[]): UpkeepPart {
  return { name: 'noting', scope: 'clone', run: async () => (ran.push('noting'), {}) };
}

/** A branch `other` and this one each change shared.txt, then `args` brings other's change here: a conflict. */
async function conflicting(wt: Checkout, args: readonly string[]): Promise<RunResult> {
  await wt.git(['switch', '--quiet', '-c', 'other']);
  await wt.commitFile('shared.txt', 'theirs\n');
  await wt.git(['switch', '--quiet', '-']);
  await wt.commitFile('shared.txt', 'ours\n');
  return wt.gitResult(args);
}

async function drift(root: string): Promise<void> {
  await writeFile(path.join(root, '.claude/rules/grimoire.md'), DRIFTED);
}

describe('the per-worktree part skips', () => {
  gitTest('a worktree with a merge in progress, while clone-wide parts still run', async ({ world }) => {
    const root = world.a.dir;
    await world.a.commitFile('shared.txt', 'base\n');
    await world.a.git(['switch', '--quiet', '-c', 'other']);
    await world.a.commitFile('shared.txt', 'theirs\n');
    await world.a.git(['switch', '--quiet', 'main']);
    await world.a.commitFile('shared.txt', 'ours\n');
    expect((await world.a.gitResult(['merge', '--quiet', 'other'])).code).not.toBe(0);
    await installed(root);
    await drift(root);
    const ran: string[] = [];

    const report = await runUpkeep({ root, parts: [clonePart(ran), ...(await defaultParts())] });

    expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', status: 'skipped', why: 'merge' }));
    expect(ran).toEqual(['noting']);

    await world.a.git(['merge', '--abort']);
    await runUpkeep({ root });
    expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
  });

  /** Each git operation stopped half-done in a linked worktree (its marks live in that worktree's own git dir). */
  const stopped: readonly (readonly [GitOperation, (wt: Checkout) => Promise<void>])[] = [
    ['rebase', async (wt) => expect((await conflicting(wt, ['rebase', 'other'])).code).not.toBe(0)],
    ['cherry-pick', async (wt) => expect((await conflicting(wt, ['cherry-pick', 'other'])).code).not.toBe(0)],
    [
      'revert',
      async (wt) => {
        await wt.commitFile('shared.txt', 'a\n');
        await wt.commitFile('shared.txt', 'b\n');
        expect((await wt.gitResult(['revert', '--no-edit', 'HEAD~1'])).code).not.toBe(0);
      },
    ],
    ['bisect', async (wt) => void (await wt.git(['bisect', 'start']))],
  ];
  for (const [operation, stop] of stopped) {
    gitTest(`a linked worktree with a ${operation} in progress`, async ({ world }) => {
      const wt = await world.a.addWorktree('feature');
      await wt.commitFile('shared.txt', 'base\n');
      await stop(wt);
      await installed(world.a.dir);
      await installed(wt.dir);
      await drift(wt.dir);

      const report = await runUpkeep({ root: world.a.dir });

      expect(await read(wt.dir, '.claude/rules/grimoire.md')).toBe(DRIFTED);
      expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', worktree: wt.dir, status: 'skipped', why: operation }));
      expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', worktree: world.a.dir, status: 'ran' }));
    });
  }

  gitTest('a worktree that pins another version than the process runs', async ({ world }) => {
    const root = world.a.dir;
    await installed(root, '9.9.9');
    await drift(root);
    const ran: string[] = [];

    const report = await runUpkeep({ root, parts: [clonePart(ran), ...(await defaultParts())] });

    expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', status: 'skipped', why: 'pin' }));
    expect(ran).toEqual(['noting']);
  });

  gitTest('a worktree whose upgrade-in-progress record names another pin, printing how to finish or discard it', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await drift(root);
    const store = new MachineLocalStore(path.join(root, '.git'));
    await store.coordination.write(UPGRADE_RECORDS, 'upgrade-a', { worktree: root, from: VERSION, to: '9.9.9', started_at: Date.now() });
    const ran: string[] = [];

    const report = await runUpkeep({ root, parts: [clonePart(ran), ...(await defaultParts())] });

    expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', status: 'skipped', why: 'upgrade' }));
    expect(report.notices).toContainEqual(
      expect.stringContaining('finish with `npx @goksening/grimoire@9.9.9 init --upgrade`, or discard with `git restore`'),
    );
    expect(ran).toEqual(['noting']);
  });

  gitTest('every part, while the machine marker needs a newer grimoire: nothing is written that couldn’t be recorded', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await drift(root);
    const store = new MachineLocalStore(path.join(root, '.git'));
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, 'format'), 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');
    const ran: string[] = [];

    const report = await runUpkeep({ root, parts: [clonePart(ran), ...(await defaultParts())] });

    expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'noting', status: 'skipped', why: 'markers' }));
    expect(report.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', status: 'skipped', why: 'markers' }));
    expect(ran).toEqual([]);
  });

  gitTest('every registered worktree on this pin is refreshed, and one on another pin is left alone', async ({ world }) => {
    const same = await world.a.addWorktree('same');
    const other = await world.a.addWorktree('other');
    await installed(world.a.dir);
    await installed(same.dir);
    await installed(other.dir, '9.9.9');
    for (const dir of [world.a.dir, same.dir, other.dir]) await drift(dir);

    const report = await runUpkeep({ root: world.a.dir });

    expect(await read(world.a.dir, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
    expect(await read(same.dir, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
    expect(await read(other.dir, '.claude/rules/grimoire.md')).toBe(DRIFTED);
    expect(report.notices).toContain('grimoire refreshed 1 pointer file: commit it');
    expect(report.notices).toContainEqual(expect.stringMatching(/^grimoire refreshed 1 pointer file in .*same: commit it$/));
  });
});

async function defaultParts(): Promise<readonly UpkeepPart[]> {
  return (await import('../../src/upkeep')).UPKEEP_PARTS.filter((part) => part.scope === 'worktree');
}
