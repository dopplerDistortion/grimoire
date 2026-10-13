// Seam 1 (spec §16 Billing guard, Caps; spike D P6, spike F C4): before every
// run the billing guard asks the client, with the child's exact env, which
// login it would bill, and refuses anything but the plan unless API billing
// is allowed; `none` is always refused. At most 6 runs a day, and a 6 h pause
// after 2 consecutive failures, both shown in status.
import { describe, expect } from 'vitest';
import { enableRunner, runChores } from '../../src/runner';
import { choreAgent, Clock } from '../core/chore-support';
import { coreTest as test, T0 } from '../core/support';
import { agentsForTest, dueCompile, enabled, expectError, noPatternAnswer, ok, runnerFact } from './scenario';
import { authStatus, claudeAnswer, claudeMaxTurns, codexAnswer } from './support';

describe('the runner: the billing guard', () => {
  test('with ANTHROPIC_API_KEY set and no allow_api_billing, the run is refused before anything starts', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });

    const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env({ ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' }), now: d.clock.now, due: true }));

    expect(error.code).toBe('INVALID');
    expect(error.message).toContain('ANTHROPIC_API_KEY');
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toEqual([]);
    // No run started: nothing counts against the cap, and the compile is still due.
    expect(await runnerFact(world.a.dir, d.clock.now())).toMatchObject({ runs_today: 0 });
    expect(ok(await d.core.call('chore_start', {}, await choreAgent(grimoire.ctx)))).toMatchObject({ kind: 'wiki-maintainer' });
  });

  test('a claude login that bills outside the plan is refused without allow_api_billing', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai') });
    await fake.plan('claude', { auth: authStatus('api-key-helper'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });

    const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true }));

    expect(error.code).toBe('INVALID');
    expect(error.details.preflight).toMatchObject({ auth_method: 'api_key_helper' });
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toEqual([]);
  });

  test('with allow_api_billing, authMethod api_key is accepted and shown in status', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('api-key'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });
    const env = fake.env({ ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' });
    const { runner } = await enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: true, env });
    expect(runner).toMatchObject({ kind: 'claude', binary: fake.claude, allow_api_billing: true, auth_method: 'api_key' });

    const report = await runChores({ root: world.a.dir, core: d.core, env, now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'compiled', auth_method: 'api_key' })]);
    expect(await runnerFact(world.a.dir, d.clock.now())).toMatchObject({
      enabled: true,
      kind: 'claude',
      allow_api_billing: true,
      auth_method: 'api_key',
      bills_api: true,
      runs_today: 1,
    });
  });

  test('authMethod none is always refused, even with allow_api_billing', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await agentsForTest();
    await fake.plan('claude', { auth: authStatus('none'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });

    // At enable: refused, and nothing stored.
    const atEnable = await expectError(enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: true, env: fake.env() }));
    expect(atEnable.details.preflight).toMatchObject({ auth_method: 'none' });
    expect(await runnerFact(world.a.dir, d.clock.now())).toMatchObject({ enabled: false });

    // Before a run: refused too.
    await fake.plan('claude', { auth: authStatus('claude-ai') });
    await enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: true, env: fake.env() });
    await fake.plan('claude', { auth: authStatus('none'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });
    const atRun = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true }));
    expect(atRun.details.preflight).toMatchObject({ auth_method: 'none' });
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toEqual([]);
  });

  test('codex: CODEX_API_KEY or OPENAI_API_KEY refuses the run, and so does a login that is not ChatGPT', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const plan = { login: { stdout: 'Logged in using ChatGPT\n', code: 0 }, mcp: { stdout: '[]', code: 0 }, answers: [codexAnswer(noPatternAnswer(d.pairs))] };
    const fake = await enabled('codex', world.a.dir, plan);
    for (const variable of ['CODEX_API_KEY', 'OPENAI_API_KEY']) {
      const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env({ [variable]: 'sk-FAKE' }), now: d.clock.now, due: true }));
      expect(error.message).toContain(variable);
    }
    await fake.plan('codex', { ...plan, login: { stdout: 'Logged in using an API key - sk-proj-***ABCD\n', code: 0 } });
    const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true }));
    expect(error.details.preflight).toMatchObject({ auth_method: 'api_key' });
    // The login's output (a masked key) is never echoed.
    expect(JSON.stringify(error.details) + error.message).not.toContain('sk-proj');
    expect(fake.calls('codex').filter((call) => call.type === 'answer')).toEqual([]);
  });

  test('codex: a failing MCP server list refuses the run', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const login = { stdout: 'Logged in using ChatGPT\n', code: 0 };
    const fake = await enabled('codex', world.a.dir, { login, mcp: { stdout: '[]', code: 0 } });
    await fake.plan('codex', { login, mcp: { stdout: '', stderr: 'Error loading config.toml', code: 1 }, answers: [codexAnswer(noPatternAnswer(d.pairs))] });

    const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true }));

    expect(error.details.preflight).toMatchObject({ mcp_list: 'failed' });
    expect(fake.calls('codex').filter((call) => call.type === 'answer')).toEqual([]);
  });
});

describe('the runner: caps', () => {
  /** A manual Skill Proposer run that finds nothing to propose: repeatable, and a success. */
  const noAction = claudeAnswer({ action: 'no_action', client: 'claude-code', model: 'claude-opus-5-5' });

  test('the 7th run in a day is refused; the cap covers the last 24 hours, and status shows it', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: Array.from({ length: 8 }, () => noAction) });
    const run = () => runChores({ root: world.a.dir, core, env: fake.env(), now: clock.now, kind: 'skill-proposer' });
    for (let i = 0; i < 6; i++) {
      expect((await run()).runs).toEqual([expect.objectContaining({ kind: 'skill-proposer', result: 'no_action', spawns: 1 })]);
      clock.advance(1);
    }

    const refusal = await expectError(run());

    expect(refusal.code).toBe('NOT_DUE');
    expect(refusal.message).toContain('6 runs');
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toHaveLength(6);
    expect(await runnerFact(world.a.dir, clock.now())).toMatchObject({ runs_today: 6, runs_per_day: 6, next_run_at: new Date(T0.getTime() + 24 * 3_600_000).toISOString() });
    // A day after the first run, a run may start again.
    clock.advance(18);
    expect((await run()).runs).toHaveLength(1);
  });

  test('two consecutive failures pause the runner for 6 h, shown in status; a success in between resets the count', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [claudeMaxTurns(), noAction, claudeMaxTurns(), claudeMaxTurns(), noAction] });
    const run = () => runChores({ root: world.a.dir, core, env: fake.env(), now: clock.now, kind: 'skill-proposer' });

    expect((await run()).runs[0]).toMatchObject({ result: 'failed' });
    expect(await runnerFact(world.a.dir, clock.now())).toMatchObject({ consecutive_failures: 1, paused_until: null });
    expect((await run()).runs[0]).toMatchObject({ result: 'no_action' });
    expect(await runnerFact(world.a.dir, clock.now())).toMatchObject({ consecutive_failures: 0 });
    expect((await run()).runs[0]).toMatchObject({ result: 'failed' });
    clock.advance(1);
    expect((await run()).runs[0]).toMatchObject({ result: 'failed' });
    const pausedUntil = new Date(clock.now().getTime() + 6 * 3_600_000).toISOString();
    expect(await runnerFact(world.a.dir, clock.now())).toMatchObject({ paused_until: pausedUntil, last: { result: 'failed' } });

    const refusal = await expectError(run());
    expect(refusal.code).toBe('NOT_DUE');
    expect(refusal.details).toMatchObject({ paused_until: pausedUntil });
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toHaveLength(4);

    clock.advance(6);
    expect((await run()).runs[0]).toMatchObject({ result: 'no_action' });
    expect(await runnerFact(world.a.dir, clock.now())).toMatchObject({ paused_until: null });
  });
});
