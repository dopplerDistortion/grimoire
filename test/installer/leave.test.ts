// Leave (spec §21 Leave; §6, §15 generated output, §14 cutting uncut
// contexts). Seam 1: the installer's leave run against real clones, with the
// person's answers scripted. What a clone holds afterwards is checked through
// git and the file system: the generated output of every registered
// worktree, the machine-local store with its copies and launcher, the clone's
// grimoire git config, the control channel's files and the local tracker ref.
// The terminal gate and the packed bin are seam 3 (leave-cli.test.ts).
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { removeDir } from '#harness';
import { VERSION } from '../../src/version';
import { coreTest as test, fetchTracker, pushTracker, trackerTip } from '../core/support';
import { existsIn, generatedFolders, pinAndCommit, terminal } from '../generated/support';
import { isolatedEnv, joined, leave, serveSkill, trackedState } from './leave-support';

describe('what leave removes', () => {
  test('in a clone with two worktrees: the generated output in both, the whole machine-local store with its copies and launcher; no tracked file changes', async ({
    world,
    grimoire,
  }) => {
    await pinAndCommit(world.a);
    const feature = await world.a.addWorktree('feature');
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    for (const checkout of [world.a, feature]) {
      for (const folder of generatedFolders('release-notes')) expect(await existsIn(checkout, folder), folder).toBe(true);
    }
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const before = [await trackedState(world.a), await trackedState(feature)];

    const { report } = await leave(world.a.dir, grimoire.ctx, ['leave']);

    expect(report.left).toBe(true);
    for (const checkout of [world.a, feature]) {
      for (const folder of generatedFolders('release-notes')) expect(await existsIn(checkout, folder), folder).toBe(false);
      // config.yml and the rest of .grimoire stay: they are committed.
      expect(await existsIn(checkout, '.grimoire/config.yml')).toBe(true);
    }
    expect([await trackedState(world.a), await trackedState(feature)]).toEqual(before);
    expect(existsSync(store.dir)).toBe(false);
    expect(report.removed.generated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ worktree: world.a.dir, path: '.grimoire/skills/release-notes' }),
        expect.objectContaining({ worktree: feature.dir, path: '.claude/skills/grimoire-release-notes' }),
      ]),
    );
    expect(report.removed.copies).toEqual([VERSION]);
    expect(report.removed.launcher).toBe(true);
  });

  test('the clone’s grimoire.* git config keys and its control-channel secret go; another clone’s secret and other config stay', async ({ world, grimoire }) => {
    await world.a.git(['config', 'grimoire.remote', 'origin']);
    await world.a.git(['config', 'grimoire.extra.key', 'x']);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const env = await isolatedEnv();
    try {
      const control = process.platform === 'win32' ? path.join(env.dir, 'grimoire', 'control') : path.join(env.dir, 'grimoire');
      await mkdir(control, { recursive: true, mode: 0o700 });
      const { cloneId } = await import('../../src/machine-local');
      const id = await cloneId(path.join(world.a.dir, '.git'));
      await writeFile(path.join(control, `${id.slice(0, 16)}.secret`), 'secret\n');
      await writeFile(path.join(control, 'ffffffffffffffff.secret'), 'another clone\n');

      const { report } = await leave(world.a.dir, grimoire.ctx, ['leave'], { env: env.vars });

      expect(report.removed.git_config.sort()).toEqual(['grimoire.extra.key', 'grimoire.remote']);
      expect((await world.a.gitResult(['config', '--get-regexp', '^grimoire\\.'])).code).toBe(1);
      expect(await world.a.git(['config', 'user.email'])).toBe(world.a.identity.email);
      expect(existsSync(path.join(control, `${id.slice(0, 16)}.secret`))).toBe(false);
      expect(existsSync(path.join(control, 'ffffffffffffffff.secret'))).toBe(true);
    } finally {
      await removeDir(env.dir);
    }
  });
});

describe('the local tracker ref', () => {
  test('when the remote holds its tip, the ref and its reflog go; the remote-tracking ref and the remote’s branch stay', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const tip = await trackerTip(world.a);

    const { report } = await leave(world.a.dir, grimoire.ctx, ['leave']);

    expect(report.removed.tracker_ref).toBe(tip);
    expect(report.kept.tracker_ref).toBeNull();
    expect(await trackerTip(world.a)).toBeNull();
    expect((await world.a.gitResult(['reflog', 'exists', 'refs/grimoire/tracker'])).code).not.toBe(0);
    expect(await world.a.git(['rev-parse', 'refs/remotes/origin/grimoire/tracker'])).toBe(tip);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe(`${tip}\trefs/heads/grimoire/tracker`);
  });

  test('with unpushed commits and no consent to push, it stays and the git update-ref -d command is given; nothing is pushed', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const pushed = await trackerTip(world.a);
    const core = grimoire.makeCore();
    expect(await core.call('settings_set', { key: 'auto-sync', value: false }, terminal(grimoire.ctx))).toMatchObject({ ok: true });
    expect(await core.call('create', { title: 'Written here, never pushed' }, grimoire.ctx)).toMatchObject({ ok: true });
    const tip = await trackerTip(world.a);

    const { report, asked } = await leave(world.a.dir, grimoire.ctx, ['n', 'leave']);

    expect(asked[0]).toMatch(/Push 2 unpushed tracker commits before leaving\?/);
    expect(report.left).toBe(true);
    expect(report.removed.tracker_ref).toBeNull();
    expect(report.kept.tracker_ref).toMatchObject({ tip, command: 'git update-ref -d refs/grimoire/tracker' });
    expect(await trackerTip(world.a)).toBe(tip);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe(`${pushed}\trefs/heads/grimoire/tracker`);
  });

  test('under auto-sync the final sync pushes the unpushed commits first, and then the ref goes', async ({ world, grimoire }) => {
    const core = grimoire.makeCore();
    expect(await core.call('create', { title: 'Written here' }, grimoire.ctx)).toMatchObject({ ok: true });
    const tip = await trackerTip(world.a);

    const { report, asked } = await leave(world.a.dir, grimoire.ctx, ['leave']);

    expect(asked).toHaveLength(1);
    expect(report.sync).toMatchObject({ state: 'pushed', pushed: true });
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe(`${tip}\trefs/heads/grimoire/tracker`);
    expect(report.removed.tracker_ref).toBe(tip);
    expect(await trackerTip(world.a)).toBeNull();
  });
});

describe('the gate', () => {
  test('anything but the typed confirmation cancels it, and nothing changes', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    await pushTracker(world.a);
    const tip = await trackerTip(world.a);

    await expect(leave(world.a.dir, grimoire.ctx, ['Leave'])).rejects.toMatchObject({ code: 'INVALID', details: { fields: { confirmation: 'must be leave' } } });

    expect(existsSync(store.dir)).toBe(true);
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(true);
    expect(await trackerTip(world.a)).toBe(tip);
  });
});
