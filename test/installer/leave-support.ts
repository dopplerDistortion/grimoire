// Shared setup for leave's seam-1 tests (leave.test.ts, leave-offers.test.ts):
// leave run against real clones with the person's answers scripted, and the
// clone states the tests start from.
import { makeTempDir, removeDir, type Checkout } from '#harness';
import path from 'node:path';
import type { CallContext, Core } from '../../src/core';
import { runLeave, type LeaveOptions, type LeaveReport } from '../../src/installer/leave';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { editSkill, gitStatus, NOTES, terminal } from '../generated/support';
import { joinClone, reportingPackage } from './support';

/** A person's answers, in order; each question asked is recorded. */
export function answering(...answers: string[]): { ask(question: string): Promise<string | null>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? null;
    },
  };
}

export interface Leaving {
  report: LeaveReport;
  asked: string[];
  said: string[];
}

/** Runs leave in `root` as Alice at a terminal, answering in order. */
export async function leave(root: string, ctx: CallContext, answers: string[], options: Partial<LeaveOptions> = {}): Promise<Leaving> {
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
export async function isolatedEnv(): Promise<{ dir: string; vars: NodeJS.ProcessEnv }> {
  const dir = await makeTempDir('grimoire-leave-env-');
  return { dir, vars: { ...process.env, LOCALAPPDATA: dir, XDG_RUNTIME_DIR: dir } };
}

/** The checkout's tracked files' content, as git sees it in the working tree. */
export async function trackedState(checkout: Checkout): Promise<string> {
  return `${await checkout.git(['ls-files', '-s'])}\n${await gitStatus(checkout)}\n${await checkout.git(['diff', 'HEAD'])}`;
}

export async function joined(clone: Checkout): Promise<MachineLocalStore> {
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
export async function serveSkill(core: Core, ctx: CallContext): Promise<void> {
  await editSkill(core, ctx, { name: 'release-notes', text: NOTES, base: null });
  await core.close();
}
