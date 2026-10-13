// Seam 3 (spec §10 Runtime, §7 the human-only gate, §16 The runner): the
// built CLI's runner verbs. Transport and gating only: `runner enable` and
// `runner disable` are human-only (no agent marker, an interactive terminal,
// a typed confirmation); `chore run` refuses agent markers but needs no
// terminal. The runner's own rules are seam 1's (test/runner).
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { MachineLocalStore } from '../../../src/machine-local';
import { enableRunner, readRunnerConfig } from '../../../src/runner';
import { coreTest as test } from '../../core/support';
import { agentsForTest } from '../../runner/scenario';
import { authStatus } from '../../runner/support';
import { buildGrimoire, cli, cliAtTerminal, lastJsonOnScreen } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

const storeOf = (dir: string) => new MachineLocalStore(path.join(dir, '.git'));

describe('runner enable and runner disable: human-only', () => {
  test('refused without a terminal and under an agent marker; nothing is stored', async ({ world }) => {
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('claude-ai') });

    const piped = await cli(bin, ['runner', 'enable', 'claude'], { cwd: world.a.dir, env: fake.env() });
    expect(piped.code, piped.stderr).toBe(1);
    expect(piped.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });

    const marked = await cliAtTerminal(bin, ['runner', 'enable', 'claude'], { cwd: world.a.dir, env: fake.env({ AI_AGENT: 'claude-code_2-1-296_agent' }) });
    expect(marked.code, marked.screen).toBe(1);
    expect(lastJsonOnScreen(marked.screen)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(marked.screen).not.toContain('AI_AGENT');
    expect(marked.screen).not.toMatch(/to confirm/);

    // The preflight never ran, and no config was stored.
    expect(fake.calls('claude')).toEqual([]);
    expect(await readRunnerConfig(storeOf(world.a.dir))).toBeNull();
  });

  test('at a terminal: the warnings, the preflight, the typed confirmation, then the config; disable confirms too', async ({ world }) => {
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('claude-ai') });

    const run = await cliAtTerminal(bin, ['runner', 'enable', 'claude'], { cwd: world.a.dir, env: fake.env(), answers: [{ when: /Type claude to confirm/, type: 'claude' }] });

    expect(run.code, run.screen).toBe(0);
    expect(run.screen.replace(/\s+/g, ' ')).toContain('5-hour and weekly limits');
    expect(run.screen.replace(/\s+/g, ' ')).toContain('policy gray zone');
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ runner: { kind: 'claude', binary: fake.claude, allow_api_billing: false, auth_method: 'claude.ai' } });
    expect(fake.calls('claude').map((call) => call.type)).toEqual(['auth']);
    expect(await readRunnerConfig(storeOf(world.a.dir))).toMatchObject({ kind: 'claude', binary: fake.claude });

    const status = await cli(bin, ['status', '--json'], { cwd: world.a.dir, env: fake.env() });
    expect(status.json.runner).toMatchObject({ enabled: true, kind: 'claude', runs_today: 0, runs_per_day: 6, paused_until: null });

    const typo = await cliAtTerminal(bin, ['runner', 'disable'], { cwd: world.a.dir, env: fake.env(), answers: [{ when: /to confirm/, type: 'codex' }] });
    expect(typo.code, typo.screen).toBe(1);
    expect(await readRunnerConfig(storeOf(world.a.dir))).not.toBeNull();
    const off = await cliAtTerminal(bin, ['runner', 'disable'], { cwd: world.a.dir, env: fake.env(), answers: [{ when: /Type claude to confirm/, type: 'claude' }] });
    expect(off.code, off.screen).toBe(0);
    expect(lastJsonOnScreen(off.screen)).toMatchObject({ disabled: true, was: { kind: 'claude' } });
    expect(await readRunnerConfig(storeOf(world.a.dir))).toBeNull();
  });

  test('a login that bills outside the plan asks whether to allow it; refusing stores nothing', async ({ world }) => {
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('api-key') });
    const env = fake.env({ ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' });

    const refused = await cliAtTerminal(bin, ['runner', 'enable', 'claude'], { cwd: world.a.dir, env, answers: [{ when: /Type allow to allow it/, type: 'no' }] });
    expect(refused.code, refused.screen).toBe(1);
    expect(lastJsonOnScreen(refused.screen)).toMatchObject({ error: { code: 'INVALID' } });
    expect(await readRunnerConfig(storeOf(world.a.dir))).toBeNull();

    const allowed = await cliAtTerminal(bin, ['runner', 'enable', 'claude'], {
      cwd: world.a.dir,
      env,
      answers: [
        { when: /Type allow to allow it/, type: 'allow' },
        { when: /Type claude to confirm/, type: 'claude' },
      ],
    });
    expect(allowed.code, allowed.screen).toBe(0);
    expect(await readRunnerConfig(storeOf(world.a.dir))).toMatchObject({ allow_api_billing: true, auth_method: 'api_key' });
  });
});

describe('chore run: refuses agent markers, needs no terminal', () => {
  test('under an agent marker, chore run --due and chore run <kind> are refused', async ({ world }) => {
    const fake = await agentsForTest();
    for (const args of [['chore', 'run', '--due'], ['chore', 'run', 'wiki-maintainer']]) {
      const run = await cli(bin, args, { cwd: world.a.dir, env: fake.env({ CODEX_THREAD_ID: '019a-thread' }) });
      expect(run.code, run.stderr).toBe(1);
      expect(run.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
      expect(run.stdout).not.toContain('CODEX_THREAD_ID');
    }
  });

  test('without a runner, chore run <kind> says to ask an agent', async ({ world }) => {
    const fake = await agentsForTest();
    const run = await cli(bin, ['chore', 'run', 'wiki-maintainer'], { cwd: world.a.dir, env: fake.env() });
    expect(run.code, run.stderr).toBe(1);
    expect(run.json).toMatchObject({ error: { code: 'INVALID' } });
    expect((run.json.error as { message: string }).message).toMatch(/ask an agent to run the grimoire-chores skill/);
  });

  test('from a scheduler (no terminal), chore run --due with nothing due exits 0 and starts no client', async ({ world, grimoire: _tracker }) => {
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('claude-ai') });
    await enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: false, env: fake.env() });

    const run = await cli(bin, ['chore', 'run', '--due'], { cwd: world.a.dir, env: fake.env() });

    expect(run.code, run.stdout).toBe(0);
    expect(run.json).toMatchObject({ runner: 'claude', runs: [], caps: { runs_today: 0 } });
    expect(run.json.why).toMatch(/Wiki Maintainer: no uncompiled settled traces/);
    // Only enable's preflight ran: nothing due starts nothing.
    expect(fake.calls('claude').map((call) => call.type)).toEqual(['auth']);
  });

  test('usage errors exit 2, and --help prints the verb', async ({ world }) => {
    const fake = await agentsForTest();
    expect((await cli(bin, ['chore', 'run'], { cwd: world.a.dir, env: fake.env() })).code).toBe(2);
    expect((await cli(bin, ['chore', 'run', '--due', 'wiki-maintainer'], { cwd: world.a.dir, env: fake.env() })).code).toBe(2);
    expect((await cli(bin, ['runner', 'enable', 'gemini'], { cwd: world.a.dir, env: fake.env() })).code).toBe(2);
    const help = await cli(bin, ['runner', 'enable', '--help'], { cwd: world.a.dir, env: fake.env() });
    expect(help.code).toBe(0);
    expect(help.json).toMatchObject({ verb: 'runner enable' });
  });
});
