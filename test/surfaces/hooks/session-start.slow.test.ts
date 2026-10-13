// Seam 3, against the wall clock (spec §15 The SessionStart fast path; §12;
// spike C B1, spike E P3, spike F B2): the real chain a client runs, the
// frozen bootstrap into a copy installed from the packed tarball, in a fresh
// linked worktree whose tracker serves an evolved skill. The first session
// start writes the missing copy and stubs, tells Claude Code to reload its
// skills and exits 0 well inside the clients' 10 s hook timeout; the next
// writes nothing and says nothing. Codex gets the same writes and never the
// Claude Code JSON (it rejects unknown keys).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, readFixture } from '#harness';
import { createCore } from '../../../src/core';
import { claudeHookArgs, installCopy, installLauncher, writeJoinRecord } from '../../../src/installer';
import { MachineLocalStore } from '../../../src/machine-local';
import { agentContext, initializeTracker } from '../../core/support';
import { packGrimoire, runEntry, writeConfig } from '../../installer/support';

const PIN = '1.0.0-test.157';
/** The clients' SessionStart hook timeout (spec §11: `timeout = 10`). */
const HOOK_BUDGET_MS = 10_000;
const RELOAD = '{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}\n';
const NOTES = '---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\nCreate `changes/<slug>.md`.\n';
const FOLDERS = ['.grimoire/skills/release-notes', '.claude/skills/grimoire-release-notes', '.agents/skills/grimoire-release-notes'];

let packed: Awaited<ReturnType<typeof packGrimoire>> | undefined;
beforeAll(async () => {
  packed = await packGrimoire(PIN);
});
afterAll(() => packed?.cleanup());

describe('the SessionStart fast path through the real chain', () => {
  gitTest('in a fresh worktree it writes the missing copy and stubs, prints reloadSkills and exits 0 within budget; a second run writes nothing and prints no flag', async ({
    world,
  }) => {
    await initializeTracker(world.a, world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball, integrity } = packed!;
    expect((await installCopy(store, PIN, { tarball, integrity })).status).toBe('installed');
    await installLauncher(store);
    await writeJoinRecord(store, PIN, { excerpt_mode: 'facts', codex_hook_hash: null, joined_at: Date.now() });
    await writeConfig(world.a.dir, PIN);
    await world.a.git(['add', '.grimoire/config.yml']);
    await world.a.git(['commit', '--quiet', '-m', 'pin grimoire']);
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      const edit = await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, { ...agentContext(world.a), surface: 'cli', client: null, evidence: {}, tty: true });
      expect(edit).toMatchObject({ ok: true });
    } finally {
      await core.close();
    }

    for (const [client, payload, wrote] of [
      ['claude-code', readFixture('claude-code/hook-payloads/session-start-startup.json'), RELOAD],
      ['codex', readFixture('codex/hook-payloads/session-start-startup.json'), ''],
    ] as const) {
      const fresh = await world.a.addWorktree(`fresh-${client}`);
      const timed = async () => {
        const started = Date.now();
        const run = await runEntry(claudeHookArgs('session-start'), { cwd: fresh.dir, projectDir: fresh.dir, input: payload });
        return { ...run, ms: Date.now() - started };
      };

      const first = await timed();
      const second = await timed();

      expect([first.code, first.stdout, first.stderr], client).toEqual([0, wrote, '']);
      expect(first.ms, client).toBeLessThan(HOOK_BUDGET_MS);
      expect(await readFile(path.join(fresh.dir, FOLDERS[0]!, 'SKILL.md'), 'utf8'), client).toBe(NOTES);
      for (const folder of FOLDERS) expect(await readFile(path.join(fresh.dir, folder, '.gitignore'), 'utf8'), `${client} ${folder}`).toBe('*\n');
      expect(await fresh.git(['status', '--porcelain', '--untracked-files=all']), client).toBe('');
      expect([second.code, second.stdout, second.stderr], client).toEqual([0, '', '']);
      expect(second.ms, client).toBeLessThan(HOOK_BUDGET_MS);
    }
  });
});

describe('the pin-mismatch notice through the real chain', () => {
  gitTest('a server still serving this worktree on an older pin: after a clear, the hook (always the checkout’s pin) says §8’s restart notice; a fresh start doesn’t', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const { tarball, integrity } = packed!;
    expect((await installCopy(store, PIN, { tarball, integrity })).status).toBe('installed');
    await installLauncher(store);
    await writeJoinRecord(store, PIN, { excerpt_mode: 'facts', codex_hook_hash: null, joined_at: Date.now() });
    await writeConfig(world.a.dir, PIN);
    // This test process stands in for the session's server, started before a pull moved the pin.
    const server = await store.processes.register({ role: 'mcp', client: 'claude-code', worktree: world.a.dir, pin: '0.9.0', pathSource: null });
    try {
      const run = (payload: string) => runEntry(claudeHookArgs('session-start'), { cwd: world.a.dir, projectDir: world.a.dir, input: readFixture(payload) });
      const cleared = await run('claude-code/hook-payloads/session-start-clear.json');
      expect([cleared.code, cleared.stdout, cleared.stderr]).toEqual([0, `grimoire: this checkout now pins ${PIN}; this session runs 0.9.0; restart it
`, '']);
      const fresh = await run('claude-code/hook-payloads/session-start-startup.json');
      expect([fresh.code, fresh.stdout, fresh.stderr]).toEqual([0, '', '']);
    } finally {
      await server.unregister();
    }
  });
});
