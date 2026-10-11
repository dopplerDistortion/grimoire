// Seam 3: the built `grimoire` CLI against temporary repos (spec §10, §7, §4).
// Thin: transport (argv, JSON stdin/stdout, exit codes) and gating, never
// business rules, which seam 1 covers.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { makeUnwritable, permissionsApply, type Clone } from '#harness';
import type { CallContext, Core } from '../../../src/core';
import { MachineLocalStore } from '../../../src/machine-local';
import { coreTest, expectRefUnmoved, initializeTracker, trackerTip } from '../../core/support';
import { buildGrimoire, cli, cliAtTerminal, humanEnv, lastJsonOnScreen } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

/** coreTest whose clone `a` has a tracker, whether or not the test uses the in-process core. */
const cliTest = coreTest.extend('a', async ({ world }) => {
  await initializeTracker(world.a, world.a);
  return world.a;
});

/** What the CLI builds for a person at their own shell, without a terminal. */
function personAtShell(clone: Clone): CallContext {
  return {
    surface: 'cli',
    repo: { root: clone.dir, pin: null },
    person: { name: clone.identity.name, email: clone.identity.email },
    evidence: {},
    tty: false,
    nonce: 'test',
  };
}

async function coreResult(core: Core, name: string, input: unknown, ctx: CallContext): Promise<unknown> {
  const outcome = await core.call(name, input, ctx);
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function machineOf(clone: Clone): MachineLocalStore {
  return new MachineLocalStore(path.join(clone.dir, '.git'));
}

/** The remote's `grimoire/tracker` tip, or null. */
async function remoteTracker(clone: Clone): Promise<string | null> {
  const run = await clone.gitResult(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return run.stdout.split('\t')[0]?.trim() || null;
}

/**
 * Waits for the detached sync child of an attempt-ending write to push and
 * exit, so nothing runs in the world when it is removed.
 */
async function syncedInBackground(clone: Clone): Promise<void> {
  await until(async () => (await remoteTracker(clone)) === (await trackerTip(clone)), 'the background push');
  await until(async () => (await machineOf(clone).processes.live({ role: 'sync' })).length === 0, 'the sync child to exit');
}

/** Creates, claims and closes an issue through the CLI; returns the close's stdout. */
async function closeThroughCli(clone: Clone): Promise<Record<string, unknown>> {
  const { json: created } = await cli(bin, ['create', 'Ship it'], { cwd: clone.dir });
  const { json: claimed } = await cli(bin, ['claim', created.id as string], { cwd: clone.dir });
  const closed = await cli(bin, ['close', created.id as string, 'done', '--attempt', claimed.attempt as string], { cwd: clone.dir });
  expect(closed.code, closed.stdout + closed.stderr).toBe(0);
  return closed.json;
}

describe('the issue verbs', () => {
  cliTest('create → show → list → claim → close print exactly what the core returns', async ({ grimoire, a }) => {
    const ctx = personAtShell(a);
    const core = grimoire.core;

    const created = await cli(bin, ['create', '--title', 'Wire the CLI'], { cwd: a.dir });
    expect(created.code, created.stderr).toBe(0);
    expect(created.json).toEqual({ id: expect.stringMatching(/^gr-/), created: true });
    const id = created.json.id as string;

    const shown = await cli(bin, ['show', id], { cwd: a.dir });
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.json).toEqual(await coreResult(core, 'show', { ref: id }, ctx));

    const listed = await cli(bin, ['list'], { cwd: a.dir });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.json).toEqual(await coreResult(core, 'list', {}, ctx));

    const claimed = await cli(bin, ['claim', id], { cwd: a.dir });
    expect(claimed.code, claimed.stderr).toBe(0);
    const holder = ((await coreResult(core, 'show', { ref: id }, ctx)) as { open_attempts: { attempt: string; since: string }[] })
      .open_attempts[0]!;
    // The write id a claim prints is its handle.
    expect(claimed.json).toEqual({ id, attempt: holder.attempt, since: holder.since });

    const closed = await cli(bin, ['close', id, 'done', '--attempt', holder.attempt], { cwd: a.dir });
    expect(closed.code, closed.stderr).toBe(0);
    // A replay of the same close answers what the close did.
    const replay = (await coreResult(core, 'close', { id, reason: 'done', attempt: holder.attempt }, ctx)) as Record<string, unknown>;
    expect(closed.json).toEqual({ ...replay, replayed: undefined });
    expect(closed.json).toEqual({ id, attempt: holder.attempt, ended: 'done', outcome: 'pass' });
    expect(await coreResult(core, 'show', { ref: id }, ctx)).toMatchObject({ status: 'done', open_attempts: [] });
    await syncedInBackground(a);
  });
});

describe('input, output and exit codes', () => {
  cliTest('an error exits 1 with the core’s error object as the one JSON object on stdout', async ({ grimoire, a }) => {
    const ctx = personAtShell(a);
    const run = await cli(bin, ['show', 'gr-zzzzz'], { cwd: a.dir });

    expect(run.code).toBe(1);
    const expected = await grimoire.core.call('show', { ref: 'gr-zzzzz' }, ctx);
    expect(expected.ok).toBe(false);
    expect(run.json).toEqual({ error: (expected as { error: unknown }).error });
  });

  cliTest('the input comes as a JSON object on stdin with --input -, and flags add scalar fields', async ({ grimoire, a }) => {
    const input = JSON.stringify({ title: 'From stdin', labels: ['cli', 'json'], body: 'line one\nline two' });
    const created = await cli(bin, ['create', '--input', '-', '--idempotency-key', 'k-1'], { cwd: a.dir, input });
    expect(created.code, created.stdout).toBe(0);

    const shown = await coreResult(grimoire.core, 'show', { ref: created.json.id }, personAtShell(a));
    expect(shown).toMatchObject({ title: 'From stdin', labels: ['cli', 'json'], body: 'line one\nline two' });
    // The flag's idempotency key took effect: the same create replays.
    const again = await cli(bin, ['create', '--input', '-', '--idempotency_key=k-1'], { cwd: a.dir, input });
    expect(again.json).toEqual({ id: created.json.id, created: false });
  });

  cliTest('flags convert to the field’s type, repeat for lists, and `--no-<flag>` sets false', async ({ a }) => {
    for (const title of ['one', 'two', 'three']) await cli(bin, ['create', title, '--labels', 'x', '--labels', 'y'], { cwd: a.dir });

    const page = await cli(bin, ['list', '--limit', '2', '--label', 'x', '--label', 'y', '--no-unlabeled'], { cwd: a.dir });
    expect(page.code, page.stdout).toBe(0);
    expect(page.json).toMatchObject({ total: 3, rows: [{ title: 'one' }, { title: 'two' }] });
    const ready = await cli(bin, ['list', '--ready'], { cwd: a.dir });
    expect(ready.json).toMatchObject({ total: 3 });
  });

  cliTest('usage errors exit 2 with one JSON object on stdout', async ({ a }) => {
    const cases: string[][] = [
      [],
      ['no-such-verb'],
      ['show'], // not a usage error: the core's INVALID (below)
      ['show', 'gr-aaaaa', 'gr-bbbbb'],
      ['list', '--no-such-flag'],
      ['list', '--limit'],
      ['create', '--input', 'file.json'],
      ['update', 'gr-aaaaa', '--body-patch', '[]'],
      ['create', 'Title', '--title', 'Again'],
    ];
    for (const args of cases) {
      const run = await cli(bin, args, { cwd: a.dir });
      if (args.length === 1 && args[0] === 'show') {
        expect(run.code, args.join(' ')).toBe(1);
        expect(run.json).toMatchObject({ error: { code: 'INVALID' } });
        continue;
      }
      expect(run.code, `${args.join(' ')}: ${run.stdout}`).toBe(2);
      expect(run.json, args.join(' ')).toEqual({ usage_error: { message: expect.any(String), help: expect.stringMatching(/^grimoire .*--help$/) } });
    }
    const bad = await cli(bin, ['create', '--input', '-'], { cwd: a.dir, input: '[1, 2]' });
    expect(bad.code).toBe(2);
    const garbled = await cli(bin, ['create', '--input', '-'], { cwd: a.dir, input: '{"title": ' });
    expect(garbled.code).toBe(2);
    const twice = await cli(bin, ['create', 'Title', '--input', '-'], { cwd: a.dir, input: '{"title": "Other"}' });
    expect(twice.code).toBe(2);
  });

  cliTest('--help exits 0 with the verb’s input schema and flags; `<noun> <verb>` names `<noun>_<verb>`', async ({ world, a }) => {
    const help = await cli(bin, ['outcome', 'set', '--help'], { cwd: a.dir });
    expect(help.code).toBe(0);
    expect(help.json).toMatchObject({
      verb: 'outcome set',
      op: 'outcome_set',
      policy: 'human-only',
      positionals: ['attempt', 'verdict', 'reason'],
      input_schema: { type: 'object', required: ['attempt', 'verdict', 'reason'] },
    });
    expect(help.json.flags).toContainEqual(expect.objectContaining({ flag: '--verdict <value>', field: 'verdict', required: true }));

    const close = await cli(bin, ['close', '--help'], { cwd: a.dir });
    expect(close.json.flags).toContainEqual(expect.objectContaining({ field: 'debrief', flag: null, stdin_only: true }));
    // The underscored op name works as well.
    expect((await cli(bin, ['outcome_set', '--help'], { cwd: a.dir })).json).toEqual(help.json);

    const all = await cli(bin, ['--help'], { cwd: a.dir });
    expect(all.code).toBe(0);
    const verbs = (all.json.verbs as { verb: string }[]).map((entry) => entry.verb);
    expect(verbs).toEqual(expect.arrayContaining(['show', 'list', 'create', 'claim', 'close', 'delete', 'outcome set', 'settings', 'settings set', 'sync', 'sync status']));
    // Help needs no repo.
    expect((await cli(bin, ['delete', '--help'], { cwd: world.root })).code).toBe(0);
  });

  cliTest('outside any repository a call gives NO_REPO; --version stays a JSON object', async ({ world, a }) => {
    const outside = await cli(bin, ['list'], { cwd: world.root });
    expect(outside.code).toBe(1);
    expect(outside.json).toMatchObject({ error: { code: 'NO_REPO' } });
    expect((await cli(bin, ['--version'], { cwd: world.root })).json).toEqual({ version: expect.any(String) });
  });
});

describe('the actor', () => {
  cliTest('a CLI call is an agent’s under an agent marker, with the session from the shell env; otherwise a person’s', async ({ a }) => {
    const { json: created } = await cli(bin, ['create', 'Who wrote this'], { cwd: a.dir });
    const id = created.id as string;

    const human = await cli(bin, ['comment', id, 'by hand'], { cwd: a.dir });
    expect(human.json.actor).toEqual({ person: a.identity.email, kind: 'human', client: 'cli', nonce: expect.any(String) });

    const claude = await cli(bin, ['comment', id, 'from Claude Code'], {
      cwd: a.dir,
      env: humanEnv({ AI_AGENT: 'claude-code_2-1-296_agent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'sess-claude' }),
    });
    expect(claude.json.actor).toMatchObject({ kind: 'agent', client: 'claude-code', session: 'sess-claude' });

    const codex = await cli(bin, ['comment', id, 'from Codex'], {
      cwd: a.dir,
      env: humanEnv({ CODEX_THREAD_ID: 'thread-child', CODEX_SESSION_ID: 'thread-root' }),
    });
    expect(codex.json.actor).toMatchObject({ kind: 'agent', client: 'codex', session: 'thread-root', context: 'thread-child' });
  });
});

/** Every agent marker's name (spec §7); a refusal's message names none of them. */
const MARKER_NAMES = /AI_AGENT|CLAUDE_CODE_CHILD_SESSION|CODEX_CI|CODEX_THREAD_ID|marker/i;

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

  cliTest('release --abandoned of another person’s attempt needs the terminal and the typed id; of your own, neither', async ({
    world,
    grimoire,
    a,
  }) => {
    const { json: created } = await cli(bin, ['create', 'Dead claim'], { cwd: a.dir });
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

    // Alice's own dead claim: no terminal needed.
    const { json: mine } = await cli(bin, ['claim', id], { cwd: a.dir });
    const own = await cli(bin, ['release', id, mine.attempt as string, '--abandoned'], { cwd: a.dir });
    expect(own.code, own.stdout).toBe(0);
    expect(own.json).toMatchObject({ ended: 'release-abandoned' });
  });
});

describe('a shell that can’t write the live store', () => {
  cliTest.skipIf(!permissionsApply)(
    'a CLI write against an unwritable git directory gives NOT_WRITABLE with the ref unmoved; reads still work',
    async ({ a }) => {
      const restore = await makeUnwritable(path.join(a.dir, '.git'));
      try {
        const write = await expectRefUnmoved(a, () => cli(bin, ['create', 'Blocked'], { cwd: a.dir }));
        expect(write.code).toBe(1);
        expect(write.json).toEqual({ error: { code: 'NOT_WRITABLE', message: expect.any(String), retryable: false, details: {} } });
        expect((write.json.error as { message: string }).message).not.toMatch(/MCP/);

        // In a Codex agent's shell, the error says why and where writes work (spike F).
        const codex = await expectRefUnmoved(a, () =>
          cli(bin, ['create', 'Blocked'], { cwd: a.dir, env: humanEnv({ CODEX_THREAD_ID: '019a-thread', CODEX_SANDBOX: 'windows' }) }),
        );
        expect(codex.json).toMatchObject({ error: { code: 'NOT_WRITABLE' } });
        expect((codex.json.error as { message: string }).message).toMatch(/Codex.*sandbox.*\.git\/.*grimoire MCP tools/);

        const read = await cli(bin, ['list'], { cwd: a.dir });
        expect(read.code, read.stdout).toBe(0);
      } finally {
        await restore();
      }
    },
  );
});

describe('the detached sync child', () => {
  cliTest('an attempt-ending CLI write spawns `sync --background`, which registers a process record and pushes', async ({
    world,
    a,
  }) => {
    // The remote takes a while, so the child is caught alive.
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });

    await closeThroughCli(a);

    const machine = machineOf(a);
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 1, 'the child’s process record');
    expect((await machine.processes.live({ role: 'sync' }))[0]).toMatchObject({ client: 'cli', worktree: a.dir });
    await syncedInBackground(a);
    const status = await cli(bin, ['sync', 'status'], { cwd: a.dir });
    expect(status.json).toMatchObject({ pending_since: null, last_result: 'pushed' });
  });

  cliTest('`grimoire sync` fetches, folds and pushes now, in the foreground', async ({ grimoire, a }) => {
    await coreResult(grimoire.core, 'create', { title: 'Not pushed yet' }, personAtShell(a));
    expect(await remoteTracker(a)).toBeNull();

    const run = await cli(bin, ['sync'], { cwd: a.dir });

    expect(run.code, run.stdout).toBe(0);
    expect(run.json).toMatchObject({ state: 'pushed', remote: 'origin', local: await trackerTip(a) });
    expect(await remoteTracker(a)).toBe(await trackerTip(a));
  });

  cliTest('a sync child that dies leaves the sync-pending marker for upkeep', async ({ world, a }) => {
    // The push hangs, then fails: only a live child could have pushed.
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 5\nexit 1\n', { mode: 0o755 });

    await closeThroughCli(a);
    const machine = machineOf(a);
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 1, 'the child’s process record');
    const [child] = await machine.processes.live({ role: 'sync' });
    process.kill(child!.pid);
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 0, 'the child to die');

    const status = await cli(bin, ['sync', 'status'], { cwd: a.dir });
    expect(status.json.pending_since).toEqual(expect.any(String));
    expect(await remoteTracker(a)).toBeNull();
    // Let the orphaned push (and its hook) finish before the world goes.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  });
});
