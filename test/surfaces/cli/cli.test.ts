// Seam 3: the built `grimoire` CLI against temporary repos (spec §10, §7, §4).
// Thin: transport (argv, JSON stdin/stdout, exit codes) and gating, never
// business rules, which seam 1 covers.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { makeUnwritable, permissionsApply, trackPidFile } from '#harness';
import { isPidAlive } from '../../../src/machine-local/process-info';
import { expectRefUnmoved, trackerTip } from '../../core/support';
import { buildGrimoire, cli, cliAtTerminal, fakeEditor, humanEnv, lastJsonOnScreen } from './support';
import { cliTest, personAtShell, coreResult, until, machineOf, remoteTracker, syncedInBackground, closeThroughCli, MARKER_NAMES } from './cli-support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

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

  cliTest('`null` on a nullable field’s flag clears the field', async ({ a }) => {
    const { json: parent } = await cli(bin, ['create', 'Parent'], { cwd: a.dir });
    const { json: child } = await cli(bin, ['create', 'Child', '--parent', parent.id as string], { cwd: a.dir });

    const cleared = await cli(bin, ['update', child.id as string, '--parent', 'null'], { cwd: a.dir });

    expect(cleared.code, cleared.stdout).toBe(0);
    expect((await cli(bin, ['show', child.id as string], { cwd: a.dir })).json).toMatchObject({ parent: null });
  });

  cliTest('JSON on stdin may start with a byte order mark (Windows tools write one)', async ({ a }) => {
    const created = await cli(bin, ['create', '--input', '-'], { cwd: a.dir, input: '\uFEFF{"title": "From PowerShell"}' });

    expect(created.code, created.stdout).toBe(0);
    expect((await cli(bin, ['show', created.json.id as string], { cwd: a.dir })).json).toMatchObject({ title: 'From PowerShell' });
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
      ['update', 'gr-aaaaa', '--body-patch', '[{'], // not JSON
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
    // A human-only verb's help names what its person types.
    expect(help.json.confirmation).toMatch(/types the attempt handle to confirm/);
    expect((await cli(bin, ['settings', 'set', '--help'], { cwd: a.dir })).json.confirmation).toMatch(/types the key to confirm/);
    expect((await cli(bin, ['delete', '--help'], { cwd: a.dir })).json.confirmation).toMatch(/types the id to confirm/);
    expect((await cli(bin, ['release', '--help'], { cwd: a.dir })).json.confirmation).toMatch(/another person’s attempt.*types the issue id/);

    const close = await cli(bin, ['close', '--help'], { cwd: a.dir });
    expect(close.json.flags).toContainEqual(expect.objectContaining({ field: 'debrief', flag: '--debrief <json>', json: true }));
    // The underscored op name works as well.
    expect((await cli(bin, ['outcome_set', '--help'], { cwd: a.dir })).json).toEqual(help.json);

    const all = await cli(bin, ['--help'], { cwd: a.dir });
    expect(all.code).toBe(0);
    const verbs = (all.json.verbs as { verb: string }[]).map((entry) => entry.verb);
    expect(verbs).toEqual(expect.arrayContaining(['show', 'list', 'create', 'claim', 'close', 'delete', 'outcome set', 'settings', 'settings set', 'sync', 'sync status']));
    // Help needs no repo.
    expect((await cli(bin, ['delete', '--help'], { cwd: world.root })).code).toBe(0);
  });

  cliTest('a failure grimoire didn’t expect exits 1 with one INTERNAL error object, and the stack goes to stderr', async ({ a }) => {
    // The tracker ref names a tree, not a commit: nothing a core outcome covers.
    await a.git(['update-ref', 'refs/grimoire/tracker', await a.git(['rev-parse', 'HEAD^{tree}'])]);

    const run = await cli(bin, ['list'], { cwd: a.dir });

    expect(run.code).toBe(1);
    expect(run.json).toEqual({ error: { code: 'INTERNAL', message: expect.stringMatching(/unexpectedly/), retryable: false, details: {} } });
    expect(run.stderr).toMatch(/^grimoire: Error: .*\n\s+at /m);
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
        // sync has no MCP tool to point to.
        const sync = await expectRefUnmoved(a, () =>
          cli(bin, ['sync'], { cwd: a.dir, env: humanEnv({ CODEX_THREAD_ID: '019a-thread', CODEX_SANDBOX: 'windows' }) }),
        );
        expect(sync.json).toMatchObject({ error: { code: 'NOT_WRITABLE' } });
        const syncMessage = (sync.json.error as { message: string }).message;
        expect(syncMessage).toMatch(/Codex.*sandbox.*outside the sandbox/);
        expect(syncMessage).not.toMatch(/with the grimoire MCP tools instead/);

        const read = await cli(bin, ['list'], { cwd: a.dir });
        expect(read.code, read.stdout).toBe(0);
      } finally {
        await restore();
      }
    },
  );

  cliTest.skipIf(!permissionsApply)('a write refused below the directories the probe checks still gives NOT_WRITABLE', async ({ grimoire, a }) => {
    const settings = path.join(a.dir, '.git', 'grimoire', 'records', 'machine-settings');
    await mkdir(settings, { recursive: true });
    const restore = await makeUnwritable(settings);
    try {
      const run = await cliAtTerminal(bin, ['settings', 'set', 'dashboard.port', '4100'], {
        cwd: a.dir,
        answers: [{ when: /Type dashboard\.port to confirm/, type: 'dashboard.port' }],
      });

      expect(run.code, run.screen).toBe(1);
      expect(lastJsonOnScreen(run.screen)).toEqual({ error: { code: 'NOT_WRITABLE', message: expect.any(String), retryable: false, details: {} } });
    } finally {
      await restore();
    }
    expect(await coreResult(grimoire.core, 'settings_get', { key: 'dashboard.port' }, personAtShell(a))).toMatchObject({
      machine: { 'dashboard.port': { default: true } },
    });
  });
});

describe('the detached sync child', () => {
  cliTest('an attempt-ending CLI write spawns `sync --background`, which registers a process record and pushes', async ({
    world,
    a,
  }) => {
    // The remote takes a while, so the child is caught alive.
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });

    await closeThroughCli(bin, a);

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
    // The push waits at the remote until the test opens the gate (two minutes at
    // most, so a failed test leaves no hook looping), then fails: the child is
    // caught mid-push, and only a live child could have pushed. The hook names
    // its process (its Windows pid under Git Bash) in a pid file the leak guard
    // holds the test to.
    const signal = (name: string) => path.join(world.root, name);
    const sh = (file: string) => file.split(path.sep).join('/');
    const [hookPid, gate] = [signal('hook.pid'), signal('hook-gate')];
    trackPidFile(hookPid);
    await writeFile(
      path.join(world.remote, 'hooks', 'pre-receive'),
      `#!/bin/sh
pid=$$
[ -r /proc/$$/winpid ] && pid=$(cat /proc/$$/winpid)
echo "$pid $((($(date +%s) + 1) * 1000))" > '${sh(hookPid)}.tmp' && mv '${sh(hookPid)}.tmp' '${sh(hookPid)}'
i=0
while [ ! -f '${sh(gate)}' ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i+1)); done
exit 1
`,
      { mode: 0o755 },
    );

    await closeThroughCli(bin, a);
    const machine = machineOf(a);
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 1, 'the child’s process record');
    await until(async () => existsSync(hookPid), 'the child’s push to reach the remote');
    const hook = Number((await readFile(hookPid, 'utf8')).split(' ')[0]);
    const [child] = await machine.processes.live({ role: 'sync' });
    process.kill(child!.pid);
    await until(async () => (await machine.processes.live({ role: 'sync' })).length === 0, 'the child to die');

    const status = await cli(bin, ['sync', 'status'], { cwd: a.dir });
    // No sync finished: a child that runs to its end records the result, a failed push included.
    expect(status.json).toMatchObject({ pending_since: expect.any(String), last_result: null, failure: null });
    expect(await remoteTracker(a)).toBeNull();

    // Let the push end before the world goes: the hook runs in the remote, and
    // killing the child leaves its git running (on Windows only git's launcher
    // is in the child's job object; on POSIX git leads its own process group).
    // It fails once the gate opens. Waiting on the hook's own process, not on a
    // file it touches, holds under load: the gate stays until the hook is gone.
    await writeFile(gate, '');
    await until(async () => !isPidAlive(hook), 'the hook to exit');
  });
});

describe('grimoire skill edit', () => {
  // The editor session itself is covered in skill-edit.test.ts.
  cliTest('without an interactive terminal it gives HUMAN_ONLY, marked or not, never naming the marker, and opens no editor', async ({ a }) => {
    const editor = { GIT_EDITOR: 'false' };
    const noTty = await cli(bin, ['skill', 'edit', 'release-notes'], { cwd: a.dir, env: humanEnv(editor) });
    const marked = await cli(bin, ['skill', 'edit', 'release-notes'], { cwd: a.dir, env: humanEnv({ ...editor, CODEX_THREAD_ID: 'thread-1' }) });

    for (const run of [noTty, marked]) {
      expect(run.code, run.stderr).toBe(1);
      expect(run.json).toMatchObject({ error: { code: 'HUMAN_ONLY', retryable: false } });
      expect(run.stdout + run.stderr).not.toMatch(MARKER_NAMES);
    }
  });

  cliTest('--help prints the op’s input schema; the text comes from the editor, so the name is all it takes', async ({ a }) => {
    const help = await cli(bin, ['skill', 'edit', '--help'], { cwd: a.dir });

    expect(help.code, help.stderr).toBe(0);
    expect(help.json).toMatchObject({
      verb: 'skill edit',
      op: 'skill_edit',
      policy: 'human-only',
      usage: 'grimoire skill edit <name>',
      positionals: ['name'],
      input_schema: { type: 'object', properties: { name: expect.any(Object), text: expect.any(Object), base: expect.any(Object) } },
    });
    expect(help.json.confirmation).toMatch(/types the name to confirm/);
  });

  cliTest('at an interactive terminal it opens the git editor, and commits once the person types the name', async ({ grimoire, a }) => {
    const text = '---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\nOne line.\n';
    const editor = await fakeEditor([{ write: text }]);
    try {
      const run = await cliAtTerminal(bin, ['skill', 'edit', 'release-notes'], {
        cwd: a.dir,
        env: humanEnv(editor.env),
        answers: [{ when: /Type release-notes to commit/, type: 'release-notes' }],
      });

      expect(run.code, run.screen).toBe(0);
      expect(lastJsonOnScreen(run.screen)).toMatchObject({ name: 'release-notes', created: true, changed: true });
      expect(await coreResult(grimoire.core, 'skill_read', { name: 'release-notes' }, personAtShell(a))).toMatchObject({
        text: expect.stringContaining('One line.'),
      });
    } finally {
      await editor.cleanup();
    }
    await syncedInBackground(a);
  });

  cliTest('without a skill name, or with the text on the command line, it is a usage error', async ({ a }) => {
    for (const args of [['skill', 'edit'], ['skill', 'edit', 'release-notes', '--text', 'Hi']]) {
      const run = await cli(bin, args, { cwd: a.dir });
      expect(run.code, args.join(' ')).toBe(2);
      expect(run.json).toMatchObject({ usage_error: { help: 'grimoire skill edit --help' } });
      expect(run.stderr).toMatch(/usage: grimoire skill edit <name>/);
    }
  });
});

describe('grimoire wiki edit', () => {
  // The editor session itself is covered in wiki-edit.test.ts; the other wiki verbs in wiki-cli.test.ts.
  cliTest('at an interactive terminal it opens the git editor, and commits the page once the person types the slug', async ({ a }) => {
    const page = '---\ntitle: "Flaky port binding"\nkind: "failure"\nsummary: "Tests fail when two servers race for one port."\n---\nBind to port 0.\n';
    const editor = await fakeEditor([{ write: page }]);
    try {
      const run = await cliAtTerminal(bin, ['wiki', 'edit', 'flaky-port-binding'], {
        cwd: a.dir,
        env: humanEnv(editor.env),
        answers: [{ when: /Type "flaky-port-binding"/, type: 'flaky-port-binding' }],
      });

      expect(run.code, run.screen).toBe(0);
      expect(lastJsonOnScreen(run.screen)).toMatchObject({ slug: 'flaky-port-binding', created: true, changed: true });
      const shown = await cli(bin, ['wiki', 'show', 'flaky-port-binding'], { cwd: a.dir });
      expect(shown.json).toMatchObject({ title: 'Flaky port binding', body: 'Bind to port 0.\n' });
    } finally {
      await editor.cleanup();
    }
    await syncedInBackground(a);
  });
});
