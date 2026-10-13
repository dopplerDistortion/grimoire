// Shared by uninstall's seam-1 tests (uninstall.test.ts, uninstall.slow.test.ts):
// uninstall run in process as the clone's person at a terminal, and what the
// tests read back through git.
import path from 'node:path';
import { expect } from 'vitest';
import { makeTempDir, removeDir, type Clone } from '#harness';
import { createCore } from '../../src/core';
import { runUninstall, type UninstallOptions, type UninstallReport } from '../../src/installer/uninstall';
import { agentContext } from '../core/support';
import { terminal } from '../generated/support';
import { answering } from './leave-support';

export interface Uninstalling {
  report: UninstallReport;
  asked: string[];
  said: string[];
}

/** Runs uninstall in `clone` (or `root`) as its person at a terminal, answering in order. */
export async function uninstall(clone: Clone, answers: string[], options: Partial<UninstallOptions> & { root?: string } = {}): Promise<Uninstalling> {
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

export async function tip(clone: Clone, ref: string): Promise<string | null> {
  const run = await clone.gitResult(['rev-parse', '--verify', '--quiet', ref]);
  return run.code === 0 ? run.stdout.trim() : null;
}

export async function remoteTip(clone: Clone, ref = 'refs/heads/grimoire/tracker'): Promise<string> {
  return (await clone.git(['ls-remote', 'origin', ref])).split('\t')[0]!;
}

/** A teammate's tracker commit on top of the remote's tip, pushed from `clone`; its sha. */
export async function pushTrackerCommit(clone: Clone, message: string): Promise<string> {
  await clone.git(['fetch', '--quiet', 'origin', 'refs/heads/grimoire/tracker']);
  const tip = await clone.git(['rev-parse', 'FETCH_HEAD']);
  const sha = await clone.git(['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', message]);
  await clone.git(['push', '--quiet', 'origin', `${sha}:refs/heads/grimoire/tracker`]);
  return sha;
}

/** Runs one printed `git …` command (it quotes nothing) in `clone`; its exit code. */
export async function runPrinted(clone: Clone, command: string): Promise<number> {
  const [git, ...args] = command.split(' ');
  expect(git).toBe('git');
  return (await clone.gitResult(args)).code ?? -1;
}

/** A tracker commit the remote doesn't hold, with auto-sync off: uninstall asks before it pushes. */
export async function unpushedCommit(clone: Clone): Promise<void> {
  const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
  try {
    const ctx = terminal(agentContext(clone));
    expect(await core.call('settings_set', { key: 'auto-sync', value: false }, ctx)).toMatchObject({ ok: true });
  } finally {
    await core.close();
  }
}
