// Seam 3 (spec Testing Decisions; §21 Leave, §7 the human-only gate): `leave`
// as a person runs it, `npx @goksening/grimoire leave` at a newer release
// than the clone's pin, packed with npm and installed the way npx installs
// it, at a real terminal (a pseudo console), in temporary clones with a bare
// remote. Removal reads only frozen lists, so the newer release removes what
// the older one installed.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, makeTempDir, readFixture, removeDir, runCommand, type Checkout } from '#harness';
import { createCore } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import { agentContext } from '../core/support';
import { editSkill, existsIn, generatedFolders, gitStatus, NOTES } from '../generated/support';
import { cli, cliAtTerminal, humanEnv, lastJsonOnScreen } from '../surfaces/cli/support';
import { npxInstall, packGrimoire } from './support';

/** The pin the clone is installed at, and the newer release that leaves it. */
const OLD = '1.0.0-test.1';
const NEW = '1.0.0-test.2';

const packages: { cleanup: () => Promise<void> }[] = [];
const prefixes: string[] = [];
let oldBin = '';
let newBin = '';
beforeAll(async () => {
  for (const [version, set] of [
    [OLD, (bin: string) => (oldBin = bin)],
    [NEW, (bin: string) => (newBin = bin)],
  ] as const) {
    const packed = await packGrimoire(version);
    packages.push(packed);
    const prefix = await makeTempDir('grimoire-npx-');
    prefixes.push(prefix);
    set(npxInstall(packed.tarball, prefix));
  }
}, 480_000);
afterAll(async () => {
  for (const packed of packages) await packed.cleanup();
  for (const prefix of prefixes) await removeDir(prefix);
});

/** `npx @goksening/grimoire@OLD init --yes`, committed and pushed: the clone as a teammate left it. */
async function installOld(checkout: Checkout): Promise<MachineLocalStore> {
  const run = await cli(oldBin, ['init', '--yes'], { cwd: checkout.dir });
  expect(run.code, run.stdout + run.stderr).toBe(0);
  await checkout.git(['add', '-A']);
  await checkout.git(['commit', '--quiet', '-m', 'install grimoire']);
  await checkout.git(['push', '--quiet', 'origin', 'HEAD']);
  return new MachineLocalStore(path.join(checkout.dir, '.git'));
}

/** The checkout's tracked files, their content and git's status of them. */
async function trackedState(checkout: Checkout): Promise<string> {
  return `${await checkout.git(['ls-files', '-s'])}\n${await gitStatus(checkout)}\n${await checkout.git(['diff', 'HEAD'])}`;
}

const CONFIRM = { when: /Type leave to confirm/, type: 'leave' };

describe('leave at a newer release', () => {
  gitTest(
    'in a clone with two worktrees on an older pin, it removes the generated output in both and the whole machine-local store; no tracked file in either changes',
    { timeout: 240_000 },
    async ({ world }) => {
      const store = await installOld(world.a);
      const feature = await world.a.addWorktree('feature');
      const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
      try {
        await editSkill(core, agentContext(world.a), { name: 'release-notes', text: NOTES, base: null });
      } finally {
        await core.close();
      }
      // The old pin's SessionStart hook writes each worktree's generated output.
      for (const checkout of [world.a, feature]) {
        const hook = await runCommand(process.execPath, [oldBin, 'hook', 'session-start'], {
          cwd: checkout.dir,
          input: readFixture('claude-code/hook-payloads/session-start-startup.json'),
          env: humanEnv(),
        });
        expect(hook.code, hook.stdout + hook.stderr).toBe(0);
        for (const folder of generatedFolders('release-notes')) expect(await existsIn(checkout, folder), `${checkout.dir} ${folder}`).toBe(true);
      }
      expect(existsSync(path.join(store.dir, 'pkg', OLD))).toBe(true);
      const before = [await trackedState(world.a), await trackedState(feature)];

      const run = await cliAtTerminal(newBin, ['leave'], { cwd: world.a.dir, answers: [CONFIRM] });

      expect(run.code, run.screen).toBe(0);
      for (const checkout of [world.a, feature]) {
        for (const folder of generatedFolders('release-notes')) expect(await existsIn(checkout, folder), `${checkout.dir} ${folder}`).toBe(false);
      }
      expect([await trackedState(world.a), await trackedState(feature)]).toEqual(before);
      expect(existsSync(store.dir)).toBe(false);
      // Auto-sync pushed the skill's commit first, so the remote holds the tip and the local ref went.
      expect((await world.a.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker'])).code).not.toBe(0);
      expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toMatch(/refs\/heads\/grimoire\/tracker$/);
      expect((await world.a.gitResult(['config', '--get-regexp', '^grimoire\\.'])).code).toBe(1);
      expect(run.screen).toMatch(/still pins grimoire/);
    },
  );

  gitTest('with unpushed tracker commits and no push, the local ref stays and the git update-ref -d command is printed', { timeout: 180_000 }, async ({ world }) => {
    await installOld(world.a);
    // A tracker commit the remote doesn't hold, with auto-sync off: leave asks before it pushes.
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      const ctx = { ...agentContext(world.a), surface: 'cli' as const, client: null, evidence: {}, tty: true };
      expect(await core.call('settings_set', { key: 'auto-sync', value: false }, ctx)).toMatchObject({ ok: true });
    } finally {
      await core.close();
    }
    const tip = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);

    const run = await cliAtTerminal(newBin, ['leave'], { cwd: world.a.dir, answers: [{ when: /before leaving\? \[y\/N\]/, type: 'n' }, CONFIRM] });

    expect(run.code, run.screen).toBe(0);
    expect(run.screen).toContain('git update-ref -d refs/grimoire/tracker');
    expect(await world.a.git(['rev-parse', 'refs/grimoire/tracker'])).toBe(tip);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
  });
});

describe('the gate', () => {
  gitTest('agent markers, no terminal, --yes and a missing typed confirmation are each refused, and nothing changes', { timeout: 180_000 }, async ({ world }) => {
    const store = await installOld(world.a);
    const tip = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);

    const marked = await cli(newBin, ['leave'], { cwd: world.a.dir, env: humanEnv({ AI_AGENT: 'claude-code_2-1-296_agent' }) });
    expect(marked.code).toBe(1);
    expect(marked.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(JSON.stringify(marked.json)).not.toMatch(/AI_AGENT/);
    const markedAtTerminal = await cliAtTerminal(newBin, ['leave'], { cwd: world.a.dir, env: humanEnv({ CODEX_THREAD_ID: 'thread-1' }) });
    expect(lastJsonOnScreen(markedAtTerminal.screen)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(markedAtTerminal.screen).not.toMatch(/to confirm/);

    const piped = await cli(newBin, ['leave'], { cwd: world.a.dir });
    expect(piped.code).toBe(1);
    expect(piped.json).toMatchObject({ error: { code: 'HUMAN_ONLY', message: expect.stringMatching(/interactive terminal/) } });

    const withYes = await cli(newBin, ['leave', '--yes'], { cwd: world.a.dir });
    expect(withYes.code).toBe(2);
    expect(withYes.json).toMatchObject({ usage_error: { message: expect.stringMatching(/never takes --yes/) } });

    const typo = await cliAtTerminal(newBin, ['leave'], { cwd: world.a.dir, answers: [{ when: /Type leave to confirm/, type: 'leave please' }] });
    expect(lastJsonOnScreen(typo.screen)).toMatchObject({ error: { code: 'INVALID', details: { fields: { confirmation: 'must be leave' } } } });

    expect(existsSync(path.join(store.dir, 'pkg', OLD))).toBe(true);
    expect(await world.a.git(['rev-parse', 'refs/grimoire/tracker'])).toBe(tip);
  });

  gitTest('a live grimoire mcp process makes it refuse, listing the process, before anything is asked', { timeout: 180_000 }, async ({ world }) => {
    const store = await installOld(world.a);
    let server: ChildProcess | null = null;
    try {
      server = spawn(process.execPath, [oldBin, 'mcp'], { cwd: world.a.dir, env: humanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let record = null;
      for (let i = 0; i < 200 && record === null; i++) {
        record = (await store.processes.live({ role: 'mcp' }))[0] ?? null;
        if (record === null) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(record).not.toBeNull();

      const run = await cliAtTerminal(newBin, ['leave'], { cwd: world.a.dir });

      expect(run.code).toBe(1);
      expect(run.screen).not.toMatch(/to confirm/);
      expect(lastJsonOnScreen(run.screen)).toMatchObject({
        error: { code: 'BUSY', details: { processes: [expect.objectContaining({ pid: record!.pid, role: 'mcp', worktree: world.a.dir })] } },
      });
      expect(existsSync(path.join(store.dir, 'pkg', OLD))).toBe(true);
    } finally {
      if (server) {
        const exited = new Promise((resolve) => server!.once('exit', resolve));
        server.stdin?.end();
        server.kill();
        await exited;
      }
    }
  });
});
