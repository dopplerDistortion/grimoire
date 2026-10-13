// Seam 3 (spec Testing Decisions; §21 Uninstall, §7 the human-only gate):
// `uninstall` as a person runs it, through the built CLI at a real terminal
// (a pseudo console), in temporary clones with a bare remote that `init --yes`
// installed. What the clone holds afterwards is checked through git.
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, type Clone } from '#harness';
import { createCore } from '../../src/core';
import { agentContext } from '../core/support';
import { terminal } from '../generated/support';
import { buildGrimoire, cli, cliAtTerminal, humanEnv, lastJsonOnScreen } from '../surfaces/cli/support';
import { differences, installedRepo, USER_AGENTS } from './uninstall-support';

let bin = '';
let cleanup: () => Promise<void> = async () => {};
let envDir = '';
beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
  envDir = await makeTempDir('grimoire-uninstall-cli-env-');
}, 240_000);
afterAll(async () => {
  await cleanup();
  await removeDir(envDir);
});

/** A person's shell whose control-channel folders live in a temp dir. */
function person(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return humanEnv({ LOCALAPPDATA: envDir, XDG_RUNTIME_DIR: envDir, ...extra });
}

const CONFIRM = { when: /Type uninstall to confirm/, type: 'uninstall' };

async function remoteTip(clone: Clone): Promise<string> {
  return (await clone.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
}

async function localTip(clone: Clone): Promise<string | null> {
  const run = await clone.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker']);
  return run.code === 0 ? run.stdout.trim() : null;
}

describe('uninstall at a terminal', () => {
  gitTest('in a fully installed repo, git diff shows exactly the manifest’s entries removed; the person’s content stays and the remote tracker is intact', { timeout: 240_000 }, async ({ world }) => {
    const { before } = await installedRepo(world.a);
    const tracker = await remoteTip(world.a);

    const run = await cliAtTerminal(bin, ['uninstall'], { cwd: world.a.dir, env: person(), answers: [CONFIRM] });

    expect(run.code, run.screen).toBe(0);
    // The report is too wide for the terminal's lines to parse back whole: its fields are checked on the screen.
    expect(run.screen).toMatch(/"uninstalled": true/);
    expect(await differences(world.a, before)).toEqual([]);
    expect(await readFile(path.join(world.a.dir, 'AGENTS.md'), 'utf8')).toBe(USER_AGENTS);
    expect(await remoteTip(world.a)).toBe(tracker);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
    const screen = run.screen.replace(/\s+/g, ' ');
    expect(screen).toContain('Commit the removal: git add -A --');
    expect(screen).toContain('npx @goksening/grimoire leave');
    expect(screen).toContain('git push origin --delete grimoire/tracker');
  });
});

describe('the gate', () => {
  gitTest('agent markers, no terminal, --yes, a git operation in progress and a missing typed confirmation are each refused; nothing is pushed or changed', { timeout: 300_000 }, async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    // An unpushed tracker commit, with auto-sync off: uninstall asks before it pushes.
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      expect(await core.call('settings_set', { key: 'auto-sync', value: false }, terminal(agentContext(world.a)))).toMatchObject({ ok: true });
    } finally {
      await core.close();
    }
    const local = await localTip(world.a);
    const remote = await remoteTip(world.a);
    const unchanged = async () => {
      expect(await differences(world.a, installed)).toEqual([]);
      expect(await localTip(world.a)).toBe(local);
      expect(await remoteTip(world.a)).toBe(remote);
      expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(true);
    };

    const marked = await cli(bin, ['uninstall'], { cwd: world.a.dir, env: person({ AI_AGENT: 'claude-code_2-1-296_agent' }) });
    expect(marked.code).toBe(1);
    expect(marked.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(JSON.stringify(marked.json)).not.toMatch(/AI_AGENT/);
    const markedAtTerminal = await cliAtTerminal(bin, ['uninstall'], { cwd: world.a.dir, env: person({ CODEX_THREAD_ID: 'thread-1' }) });
    expect(lastJsonOnScreen(markedAtTerminal.screen)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(markedAtTerminal.screen).not.toMatch(/to confirm/);

    const piped = await cli(bin, ['uninstall'], { cwd: world.a.dir, env: person() });
    expect(piped.code).toBe(1);
    expect(piped.json).toMatchObject({ error: { code: 'HUMAN_ONLY', message: expect.stringMatching(/interactive terminal/) } });

    const yes = await cli(bin, ['uninstall', '--yes'], { cwd: world.a.dir, env: person() });
    expect(yes.code).toBe(2);
    expect(yes.json).toMatchObject({ usage_error: { message: expect.stringMatching(/never takes --yes/) } });

    await writeFile(path.join(world.a.dir, '.git', 'MERGE_HEAD'), `${installed}\n`);
    const merging = await cliAtTerminal(bin, ['uninstall'], { cwd: world.a.dir, env: person() });
    expect(lastJsonOnScreen(merging.screen)).toMatchObject({ error: { code: 'INVALID', details: { operation: 'merge' } } });
    expect(merging.screen).not.toMatch(/to confirm/);
    await rm(path.join(world.a.dir, '.git', 'MERGE_HEAD'));

    // Yes to the push, then no confirmation: nothing is pushed.
    const declined = await cliAtTerminal(bin, ['uninstall'], {
      cwd: world.a.dir,
      env: person(),
      answers: [
        { when: /before leaving\? \[y\/N\]/, type: 'y' },
        { when: /Type uninstall to confirm/, type: 'no' },
      ],
    });
    expect(lastJsonOnScreen(declined.screen)).toMatchObject({ error: { code: 'INVALID', message: expect.stringMatching(/not confirmed/) } });
    await unchanged();
  });
});
