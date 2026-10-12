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
import { makeTempDir, removeDir, type Checkout } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { runLeave, type LeaveOptions, type LeaveReport } from '../../src/installer/leave';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { coreTest as test, fetchTracker, pushTracker, trackerTip } from '../core/support';
import { editSkill, existsIn, generatedFolders, gitStatus, NOTES, pinAndCommit, terminal } from '../generated/support';
import { joinClone, reportingPackage } from './support';
import { attemptDir, claimed, created, parseRecord, test as captureTest, type StoredRecord } from '../core/capture-support';
import { stripExcerptText } from '../../src/capture/session-record';
import { listStrayEdits } from '../../src/generated';

/** A person's answers, in order; each question asked is recorded. */
function answering(...answers: string[]): { ask(question: string): Promise<string | null>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? null;
    },
  };
}

interface Leaving {
  report: LeaveReport;
  asked: string[];
  said: string[];
}

/** Runs leave in `root` as Alice at a terminal, answering in order. */
async function leave(root: string, ctx: CallContext, answers: string[], options: Partial<LeaveOptions> = {}): Promise<Leaving> {
  const prompter = answering(...answers);
  const said: string[] = [];
  const env = await isolatedEnv();
  try {
    const report = await runLeave({
      root,
      ctx: { ...terminal(ctx), repo: { root, pin: null } },
      prompter,
      say: (text) => said.push(text),
      env: env.vars,
      capture: { claudeConfigDir: path.join(env.dir, 'claude'), codexHome: path.join(env.dir, 'codex'), home: env.dir },
      ...options,
    });
    return { report, asked: prompter.asked, said };
  } finally {
    await removeDir(env.dir);
  }
}

/** An environment whose control-channel folders live in a temp dir. */
async function isolatedEnv(): Promise<{ dir: string; vars: NodeJS.ProcessEnv }> {
  const dir = await makeTempDir('grimoire-leave-env-');
  return { dir, vars: { ...process.env, LOCALAPPDATA: dir, XDG_RUNTIME_DIR: dir } };
}

/** The checkout's tracked files' content, as git sees it in the working tree. */
async function trackedState(checkout: Checkout): Promise<string> {
  return `${await checkout.git(['ls-files', '-s'])}\n${await gitStatus(checkout)}\n${await checkout.git(['diff', 'HEAD'])}`;
}

async function joined(clone: Checkout): Promise<MachineLocalStore> {
  const store = new MachineLocalStore(path.join(clone.dir, '.git'));
  const parent = await makeTempDir('grimoire-leave-pkg-');
  try {
    await joinClone(store, VERSION, { dir: await reportingPackage(parent, VERSION), integrity: null });
  } finally {
    await removeDir(parent);
  }
  return store;
}

/** An evolved skill served into every worktree on this pin (the core's in-process refresh). */
async function serveSkill(core: Core, ctx: CallContext): Promise<void> {
  await editSkill(core, ctx, { name: 'release-notes', text: NOTES, base: null });
  await core.close();
}

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
