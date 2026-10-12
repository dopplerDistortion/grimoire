// Seam 3: the built `grimoire` CLI against temporary repos (spec §10, §7), continued
// from cli.test.ts: the human-only gate.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { CallContext } from '../../../src/core';
import { agentContext, expectRefUnmoved, fetchTracker, pushTracker, suffixQueue, T0 } from '../../core/support';
import { buildGrimoire, cli, cliAtTerminal, humanEnv, lastJsonOnScreen } from './support';
import { setAsideStrayEdit } from '../../../src/generated';
import { cliTest, personAtShell, coreResult, machineOf, syncedInBackground, MARKER_NAMES } from './cli-support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

describe('the human-only gate', () => {
  cliTest('under an agent marker, delete gives HUMAN_ONLY without naming the marker, and changes nothing', async ({ a }) => {
    const { json: created } = await cli(bin, ['create', 'Doomed'], { cwd: a.dir });
    const id = created.id as string;

    for (const marker of ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID']) {
      const run = await expectRefUnmoved(a, () =>
        cli(bin, ['delete', id], { cwd: a.dir, env: humanEnv({ [marker]: marker === 'AI_AGENT' ? 'claude-code_2-1-296_agent' : '1' }) }),
      );
      expect(run.code, marker).toBe(1);
      expect(run.json, marker).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
      expect((run.json.error as { message: string }).message, marker).not.toMatch(MARKER_NAMES);
    }
  });

  cliTest('without an interactive terminal, every human-only verb is refused', async ({ a }) => {
    const { json: created } = await cli(bin, ['create', 'Doomed'], { cwd: a.dir });
    const id = created.id as string;
    const calls: string[][] = [
      ['delete', id],
      ['assign', id, 'bob@example.com'],
      ['reopen', id, 'why not'],
      ['resolve', id],
      ['outcome', 'set', 'at-aaaaaaaa', 'pass', 'because'],
      ['settings', 'set', 'auto-sync', 'false'],
      ['purge', 'trace', 'at-aaaaaa', 'secret'],
      ['purge', 'session', 'at-aaaaaa', '0123456789abcdef0123456789abcdef', 'secret'],
    ];
    for (const args of calls) {
      const run = await expectRefUnmoved(a, () => cli(bin, args, { cwd: a.dir }));
      expect(run.code, args.join(' ')).toBe(1);
      expect(run.json, args.join(' ')).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    }
  });

  cliTest('at an interactive terminal, delete runs once the person types the id', async ({ grimoire, a }) => {
    const { json: created } = await cli(bin, ['create', 'Doomed'], { cwd: a.dir });
    const id = created.id as string;

    const run = await cliAtTerminal(bin, ['delete', id], { cwd: a.dir, answers: [{ when: /Type gr-\w+ to confirm/, type: id }] });

    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toEqual({ id, deleted: true, blocked_by_stripped: [] });
    const gone = await grimoire.core.call('show', { ref: id }, personAtShell(a));
    expect(gone).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  cliTest('at an interactive terminal, anything but the id cancels, and an agent marker still refuses', async ({ a }) => {
    const { json: created } = await cli(bin, ['create', 'Kept'], { cwd: a.dir });
    const id = created.id as string;

    const typo = await expectRefUnmoved(a, () =>
      cliAtTerminal(bin, ['delete', id], { cwd: a.dir, answers: [{ when: /to confirm/, type: 'gr-wrong' }] }),
    );
    expect(typo.code, typo.screen).toBe(1);
    expect(lastJsonOnScreen(typo.screen)).toMatchObject({ error: { code: 'INVALID', details: { fields: { confirmation: `must be ${id}` } } } });

    const agent = await expectRefUnmoved(a, () =>
      cliAtTerminal(bin, ['delete', id], { cwd: a.dir, env: humanEnv({ CODEX_THREAD_ID: '019a-thread' }) }),
    );
    expect(agent.code, agent.screen).toBe(1);
    expect(agent.screen).not.toMatch(/to confirm/);
    expect(lastJsonOnScreen(agent.screen)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
  });

  cliTest('skill record and skill discard confirm with the stray edit’s skill name', async ({ a }) => {
    // Upkeep found it (seam 1 covers how); the CLI only gates it.
    const stray = await setAsideStrayEdit(machineOf(a), {
      skill: 'release-notes',
      worktree: a.dir,
      path: '.grimoire/skills/release-notes/SKILL.md',
      text: '---\nname: release-notes\ndescription: Use when noting a change.\n---\n# Notes\n\nEdited by hand.\n',
      base: null,
      served: null,
    });

    expect((await cli(bin, ['skill', 'record', '--help'], { cwd: a.dir })).json).toMatchObject({ positionals: ['stray'], confirmation: expect.stringMatching(/types the skill’s name to confirm/) });
    expect((await cli(bin, ['skill', 'discard', stray!.id], { cwd: a.dir })).json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });

    const run = await cliAtTerminal(bin, ['skill', 'discard', stray!.id], { cwd: a.dir, answers: [{ when: /Type release-notes to confirm/, type: 'release-notes' }] });

    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toEqual({ discarded: [stray!.id] });
  });

  cliTest('settings set confirms with the setting’s key', async ({ grimoire, a }) => {
    const run = await cliAtTerminal(bin, ['settings', 'set', 'auto-sync', 'false'], {
      cwd: a.dir,
      answers: [{ when: /Type auto-sync to confirm/, type: 'auto-sync' }],
    });
    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ key: 'auto-sync', value: false, changed: true });
    expect(await coreResult(grimoire.core, 'settings_get', { key: 'auto-sync' }, personAtShell(a))).toMatchObject({
      store: { 'auto-sync': { value: false } },
    });
  });

  cliTest('purge trace needs the terminal, the typed attempt handle and a reason', async ({ grimoire, a }) => {
    const alice = personAtShell(a);
    const agent = agentContext(a);
    const { id } = (await coreResult(grimoire.core, 'create', { title: 'Leaky' }, alice)) as { id: string };
    const { attempt } = (await coreResult(grimoire.core, 'claim', { id }, agent)) as { attempt: string };
    await coreResult(grimoire.core, 'close', { id, reason: 'done', attempt, debrief: { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' } }, agent);
    expect((await cli(bin, ['purge', 'trace', '--help'], { cwd: a.dir })).json).toMatchObject({
      positionals: ['attempt', 'reason'],
      confirmation: expect.stringMatching(/types the attempt handle to confirm/),
    });

    const reasonless = await expectRefUnmoved(a, () => cliAtTerminal(bin, ['purge', 'trace', attempt], { cwd: a.dir, answers: [{ when: /to confirm/, type: attempt }] }));
    const typo = await expectRefUnmoved(a, () =>
      cliAtTerminal(bin, ['purge', 'trace', attempt, 'a token'], { cwd: a.dir, answers: [{ when: /to confirm/, type: 'at-wrong' }] }),
    );
    const run = await cliAtTerminal(bin, ['purge', 'trace', attempt, 'a token'], { cwd: a.dir, answers: [{ when: new RegExp(`Type ${attempt} to confirm`), type: attempt }] });

    expect(reasonless.code, reasonless.screen).not.toBe(0);
    expect(typo.code, typo.screen).toBe(1);
    expect(lastJsonOnScreen(typo.screen)).toMatchObject({ error: { code: 'INVALID', details: { fields: { confirmation: `must be ${attempt}` } } } });
    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ attempt, issue: id, purged: true, reason: 'a token', history: { pushed: false } });
    expect(await coreResult(grimoire.core, 'show', { ref: id }, alice)).toMatchObject({ past_attempts: [] });
  });

  cliTest('resolve takes its per-field picks as a JSON flag, so it runs at a terminal', async ({ world, grimoire, a }) => {
    const bobCore = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 60_000) });
    const alice = personAtShell(a);
    const bob = agentContext(world.b);
    const { id } = (await coreResult(grimoire.core, 'create', { title: 'Shared' }, alice)) as { id: string };
    await pushTracker(a);
    await fetchTracker(world.b);
    // Both clones retitle it; Bob's later title stands, Alice's is set aside.
    await coreResult(grimoire.core, 'update', { id, title: 'Alice’s title' }, alice);
    await coreResult(bobCore, 'update', { id, title: 'Bob’s title' }, bob);
    await pushTracker(world.b);
    await fetchTracker(a);

    const run = await cliAtTerminal(bin, ['resolve', id, '--fields', '{"title": "theirs"}'], {
      cwd: a.dir,
      answers: [{ when: /Type gr-\w+ to confirm/, type: id }],
    });

    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toEqual({ id, resolved: [{ field: 'title', took: 'theirs' }] });
    expect(await coreResult(grimoire.core, 'show', { ref: id }, alice)).toMatchObject({ title: 'Alice’s title', conflict: null });
  });

  cliTest('release --abandoned of another person’s attempt needs the terminal and the typed id; of your own, neither', async ({
    world,
    grimoire,
    a,
  }) => {
    const { json: created } = await cli(bin, ['create', 'Stale claim'], { cwd: a.dir });
    const id = created.id as string;
    // Bob claimed it from his agent on this clone, then went away.
    const bob: CallContext = { ...personAtShell(a), person: { name: world.b.identity.name, email: world.b.identity.email } };
    const { attempt } = (await coreResult(grimoire.core, 'claim', { id }, bob)) as { attempt: string };

    const piped = await expectRefUnmoved(a, () => cli(bin, ['release', id, attempt, '--abandoned'], { cwd: a.dir }));
    expect(piped.json).toMatchObject({ error: { code: 'NOT_ASSIGNEE' } });

    const run = await cliAtTerminal(bin, ['release', id, attempt, '--abandoned'], {
      cwd: a.dir,
      answers: [{ when: /Type gr-\w+ to confirm/, type: id }],
    });
    expect(run.code, run.screen).toBe(0);
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ id, attempt, ended: 'release-abandoned' });

    // Alice's own claim: no terminal needed.
    const { json: mine } = await cli(bin, ['claim', id], { cwd: a.dir });
    const own = await cli(bin, ['release', id, mine.attempt as string, '--abandoned'], { cwd: a.dir });
    expect(own.code, own.stdout).toBe(0);
    expect(own.json).toMatchObject({ ended: 'release-abandoned' });
    await syncedInBackground(a);
  });

  cliTest('release --abandoned of another person’s attempt asks for the id even when the handle is typed in capitals', async ({
    world,
    grimoire,
    a,
  }) => {
    const { json: created } = await cli(bin, ['create', 'Stale claim'], { cwd: a.dir });
    const id = created.id as string;
    const bob: CallContext = { ...personAtShell(a), person: { name: world.b.identity.name, email: world.b.identity.email } };
    const { attempt } = (await coreResult(grimoire.core, 'claim', { id }, bob)) as { attempt: string };

    const typo = await expectRefUnmoved(a, () =>
      cliAtTerminal(bin, ['release', id, attempt.toUpperCase(), '--abandoned'], { cwd: a.dir, answers: [{ when: /to confirm/, type: 'gr-wrong' }] }),
    );

    expect(typo.code, typo.screen).toBe(1);
    expect(lastJsonOnScreen(typo.screen)).toMatchObject({ error: { code: 'INVALID', details: { fields: { confirmation: `must be ${id}` } } } });
  });

  cliTest('release --abandoned asks for the id when the bare id names both sides of a collision', async ({ world, grimoire, a }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => new Date(T0.getTime() + 60_000) });
    await pushTracker(a);
    await fetchTracker(world.b);
    await coreResult(aliceCore, 'create', { title: 'Alice’s k1m0x' }, personAtShell(a));
    await coreResult(bobCore, 'create', { title: 'Bob’s k1m0x' }, agentContext(world.b));
    // Bob claimed his gr-k1m0x before anyone saw the collision; then a folds it.
    const { attempt } = (await coreResult(bobCore, 'claim', { id: 'gr-k1m0x' }, agentContext(world.b))) as { attempt: string };
    await pushTracker(world.b);
    await fetchTracker(a);

    const typo = await expectRefUnmoved(a, () =>
      cliAtTerminal(bin, ['release', 'gr-k1m0x', attempt, '--abandoned'], { cwd: a.dir, answers: [{ when: /to confirm/, type: 'gr-wrong' }] }),
    );

    expect(typo.code, typo.screen).toBe(1);
    expect(lastJsonOnScreen(typo.screen)).toMatchObject({
      error: { code: 'INVALID', details: { fields: { confirmation: 'must be gr-k1m0x' } } },
    });
  });
});
