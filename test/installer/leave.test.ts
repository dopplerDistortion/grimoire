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
});
