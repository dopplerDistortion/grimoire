// Leave's preflight offers (spec §21 Leave; §14 cutting uncut contexts, §15
// stray edits). Seam 1, as leave.test.ts: release the attempts held from this
// machine, cut the contexts still uncut, purge unpushed excerpt text, stop to
// record stray edits or copy out folders moved aside; and the guards that
// keep someone's files out of the removal.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { Checkout } from '#harness';
import { stripExcerptText } from '../../src/capture/session-record';
import { listStrayEdits } from '../../src/generated';
import { MachineLocalStore } from '../../src/machine-local';
import { attemptDir, claimed, created, parseRecord, test as captureTest, type StoredRecord } from '../core/capture-support';
import { coreTest as test, fetchTracker, pushTracker } from '../core/support';
import { existsIn, generatedFolders, NOTES, pinAndCommit } from '../generated/support';
import { joined, leave, serveSkill } from './leave-support';

/** The session records of `attempt` on the remote's tracker branch (the local ref may be gone). */
async function remoteSessionRecords(checkout: Checkout, id: string, attempt: string): Promise<(StoredRecord & { raw: string })[]> {
  const tip = (await checkout.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
  const dir = `${attemptDir(id, attempt)}/sessions`;
  const listed = await checkout.gitResult(['ls-tree', '--name-only', `${tip}:${dir}`]);
  if (listed.code !== 0) return [];
  const names = listed.stdout.split('\n').filter(Boolean);
  return Promise.all(
    names.map(async (name) => {
      const raw = (await checkout.gitResult(['cat-file', 'blob', `${tip}:${dir}/${name}`])).stdout;
      return { ...parseRecord(name, raw), raw };
    }),
  );
}

describe('the offers', () => {
  captureTest('releasing the open attempts held from this machine ends them as abandoned, and the final sync pushes the release', async ({ world, grimoire, capture }) => {
    const id = await created(capture.core, grimoire.ctx, 'Held here');
    const attempt = await claimed(capture.core, grimoire.ctx, id);

    const { report, asked } = await leave(world.a.dir, grimoire.ctx, ['y', 'n', 'leave'], { capture: capture.options });

    expect(asked[0]).toMatch(/Release them as abandoned before leaving\?/);
    // Releasing ends every held attempt: there is nothing left to cut.
    expect(asked.some((question) => /Cut the/.test(question))).toBe(false);
    expect(report.released).toEqual([{ id, attempt }]);
    const tip = (await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    const end = await world.a.git(['cat-file', 'blob', `${tip}:${attemptDir(id, attempt)}/end.md`]);
    expect(end).toMatch(/abandoned/);
    expect(report.removed.tracker_ref).toBe(tip);
  });

  captureTest('cutting the uncut contexts attaches their session records to the open attempt; the purge strips their excerpt text before the push', async ({ world, grimoire, capture }) => {
    const id = await created(capture.core, grimoire.ctx, 'Still open');
    const attempt = await claimed(capture.core, grimoire.ctx, id);

    const { report, asked } = await leave(world.a.dir, grimoire.ctx, ['n', '', 'y', 'leave'], { capture: capture.options });

    expect(asked[1]).toMatch(/Cut the 1 bound context still uncut and attach their session records \(excerpt mode excerpts\)\?/);
    expect(asked[2]).toMatch(/Purge the unpushed excerpt text before the push\?/);
    expect(report.released).toEqual([]);
    expect(report.cut).toMatchObject({ contexts: 1, attached: 1 });
    expect(report.purged).toBeGreaterThan(0);
    const records = await remoteSessionRecords(world.a, id, attempt);
    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toMatchObject({ context: 'main', facts: 'scanned' });
    // No excerpt text is left to strip.
    expect(stripExcerptText(Buffer.from(records[0]!.raw))).toBeNull();
    expect(report.sync).toMatchObject({ pushed: true });
  });

  test('stray edits are listed, saved ones and copies edited since; stopping to record them saves each and removes nothing', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const feature = await world.a.addWorktree('feature');
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    const edited = `${NOTES}\nAlso bump the version in \`package.json\`.\n`;
    await writeFile(path.join(feature.dir, '.grimoire', 'skills', 'release-notes', 'SKILL.md'), edited);

    const { report, said } = await leave(world.a.dir, grimoire.ctx, ['y']);

    expect(report).toMatchObject({ left: false, stopped: 'stray-edits' });
    expect(report.stray_edits).toEqual([{ id: null, skill: 'release-notes', worktree: feature.dir, path: '.grimoire/skills/release-notes/SKILL.md' }]);
    const saved = await listStrayEdits(store);
    expect(saved).toMatchObject([{ skill: 'release-notes', worktree: feature.dir, text: edited }]);
    expect(said).toContain(`  grimoire skill record ${saved[0]!.id}`);
    expect(existsSync(store.dir)).toBe(true);
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(true);
  });
});

describe('folders upkeep moved aside', () => {
  test('are listed before they go with the store: stopping to copy them out removes nothing; going on removes them', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const aside = path.join(store.dir, 'moved-aside', '20261012T000000-0a0b0c0d');
    await mkdir(path.join(aside, '.claude', 'skills', 'grimoire-mine'), { recursive: true });
    await writeFile(path.join(aside, '.claude', 'skills', 'grimoire-mine', 'SKILL.md'), 'my own skill\n');

    const stopped = await leave(world.a.dir, grimoire.ctx, ['y']);

    expect(stopped.report).toMatchObject({ left: false, stopped: 'moved-aside' });
    expect(stopped.said).toContain(`  ${aside}`);
    expect(existsSync(path.join(aside, '.claude', 'skills', 'grimoire-mine', 'SKILL.md'))).toBe(true);

    const gone = await leave(world.a.dir, grimoire.ctx, ['n', 'leave']);

    expect(gone.report.left).toBe(true);
    expect(existsSync(store.dir)).toBe(false);
  });
});

describe('what leave never removes', () => {
  test('a grimoire-* folder without grimoire’s .gitignore, a generated folder holding someone’s file, and a generated path git tracks', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    await mkdir(path.join(world.a.dir, '.claude', 'skills', 'grimoire-mine'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.claude', 'skills', 'grimoire-mine', 'SKILL.md'), 'my own skill\n');
    await writeFile(path.join(world.a.dir, '.agents', 'skills', 'grimoire-release-notes', 'notes.txt'), 'mine\n');
    await mkdir(path.join(world.a.dir, '.grimoire', 'skills', 'tracked'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.grimoire', 'skills', 'tracked', '.gitignore'), '*\n');
    await writeFile(path.join(world.a.dir, '.grimoire', 'skills', 'tracked', 'SKILL.md'), 'committed\n');
    await world.a.git(['add', '-f', '.grimoire/skills/tracked/SKILL.md']);
    await world.a.git(['commit', '--quiet', '-m', 'force-add a copy']);

    const { report } = await leave(world.a.dir, grimoire.ctx, ['leave']);

    expect(await existsIn(world.a, '.claude/skills/grimoire-mine/SKILL.md')).toBe(true);
    expect(await existsIn(world.a, '.agents/skills/grimoire-release-notes/notes.txt')).toBe(true);
    expect(await existsIn(world.a, '.grimoire/skills/tracked/SKILL.md')).toBe(true);
    expect(await existsIn(world.a, '.claude/skills/grimoire-release-notes')).toBe(false);
    expect(report.kept.generated).toEqual(
      expect.arrayContaining([
        { worktree: world.a.dir, path: '.claude/skills/grimoire-mine', why: expect.stringMatching(/\.gitignore/) },
        { worktree: world.a.dir, path: '.agents/skills/grimoire-release-notes', why: expect.stringMatching(/notes\.txt/) },
        { worktree: world.a.dir, path: '.grimoire/skills/tracked', why: expect.stringMatching(/git tracks/) },
      ]),
    );
  });
});
