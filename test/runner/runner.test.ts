// Seam 1 (spec Testing Decisions; §16 The runner; spikes D (C3, P6) and F
// (C4, P7)): the runner, against stand-in `claude` and `codex` executables on
// PATH that record their argv, env, cwd and stdin. A due chore spawns the
// person's own client in a fresh, empty temp directory outside any repo, with
// the exact flags and the served bundle on stdin; its JSON answer goes through
// `chore_submit`, with exactly one fix-up respawn for an invalid answer.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { MachineLocalStore } from '../../src/machine-local';
import { readRunnerLogs, runChores } from '../../src/runner';
import { openTracker } from '../../src/tracker';
import { coreTest as test } from '../core/support';
import { dueCompile, enabled, noPatternAnswer } from './scenario';
import { authStatus, claudeAnswer, claudeMaxTurns, codexAnswer, gitAncestor } from './support';

describe('the runner: a due compile through claude', () => {
  test('spawns the stand-in in an empty temp directory outside any repo, with the exact flags and the bundle on stdin, and submits its answer', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env({ CLAUDE_CODE_SIMPLE: '1' }), now: d.clock.now, due: true });

    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ kind: 'wiki-maintainer', result: 'compiled', spawns: 1 });
    expect(report.runs[0]!.summary).toMatch(/^grimoire chores: compile done, 3 traces, 0 pages/);

    const runs = fake.calls('claude').filter((call) => call.type === 'answer');
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    // The exact flag set (spec §16 Claude invocation, spike D C3).
    const schema = run.argv[run.argv.indexOf('--json-schema') + 1]!;
    const procedure = run.argv[run.argv.indexOf('--append-system-prompt-file') + 1]!;
    expect(run.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--max-turns',
      '3',
      '--no-session-persistence',
      '--append-system-prompt-file',
      procedure,
    ]);
    // The schema inline and minified: the Wiki Maintainer's result.
    expect(schema).toBe(JSON.stringify(JSON.parse(schema)));
    expect(JSON.parse(schema)).toMatchObject({ type: 'object', required: ['pages', 'consumption'] });
    expect(path.isAbsolute(procedure)).toBe(true);
    // A fresh, empty temp directory outside any git repo, deleted afterwards; the procedure file lives elsewhere.
    expect(run.cwdEntries).toEqual([]);
    expect(gitAncestor(run.cwd)).toBeNull();
    expect(existsSync(run.cwd)).toBe(false);
    expect(path.dirname(procedure)).not.toBe(run.cwd);
    // The env: CLAUDE_CODE_SIMPLE removed, auto memory off.
    expect(run.env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    // The bundle on stdin: a plain header line first (never a slash command), the batch and what was served.
    expect(run.stdin.startsWith('/')).toBe(false);
    expect(run.stdin.split('\n')[0]).toMatch(/^grimoire chore bundle/);
    for (const pair of d.pairs) expect(run.stdin).toContain(pair);
    // The billing guard ran with the child's exact env, before the run.
    const auth = fake.calls('claude').filter((call) => call.type === 'auth').at(-1)!;
    expect(auth.argv).toEqual(['auth', 'status', '--json']);
    expect(auth.env).toEqual(run.env);

    // The submit went through chore_submit: the record is the runner's, its actor the person plus runner:claude.
    const tracker = await openTracker(world.a.dir);
    try {
      const records = await (await tracker.read()).choreRuns.records();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ result: 'compiled', origin: 'runner', isolation: 'runner', actor: { person: world.a.identity.email, kind: 'agent', client: 'runner:claude' } });
    } finally {
      await tracker.close();
    }
  });
});

describe('the runner: the one fix-up respawn', () => {
  test('an invalid answer gets exactly one respawn, told the reason codes; the fixed answer compiles', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    // The first answer leaves a batch pair out of the consumption map.
    const fake = await enabled('claude', world.a.dir, {
      auth: authStatus('claude-ai'),
      answers: [claudeAnswer(noPatternAnswer(d.pairs.slice(1))), claudeAnswer(noPatternAnswer(d.pairs))],
    });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ kind: 'wiki-maintainer', result: 'compiled', spawns: 2 })]);
    const runs = fake.calls('claude').filter((call) => call.type === 'answer');
    expect(runs).toHaveLength(2);
    // The respawn reads the same bundle, plus why the first answer was refused; each spawn gets a fresh, empty cwd.
    expect(runs[0]!.stdin).not.toContain('Your previous answer was refused');
    expect(runs[1]!.stdin).toContain('# Your previous answer was refused');
    expect(runs[1]!.stdin).toMatch(/Reason codes: .*\S/);
    expect(runs[1]!.stdin.startsWith(runs[0]!.stdin.replace('# End of the bundle\n', ''))).toBe(true);
    expect(runs[1]!.cwdEntries).toEqual([]);
  });

  test('a second invalid answer ends the run failed: never a third spawn', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const invalid = claudeAnswer(noPatternAnswer(d.pairs.slice(1)));
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [invalid, invalid, invalid] });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'failed', spawns: 2 })]);
    expect(report.runs[0]!.reasons!.length).toBeGreaterThan(0);
    expect(fake.calls('claude').filter((call) => call.type === 'answer')).toHaveLength(2);
    // The failed run's record is committed with its reason codes (spec §16 One fix-up).
    const tracker = await openTracker(world.a.dir);
    try {
      const records = await (await tracker.read()).choreRuns.records();
      expect(records).toEqual([expect.objectContaining({ result: 'failed', origin: 'runner', isolation: 'runner' })]);
    } finally {
      await tracker.close();
    }
  });

  test('a child that fails (no structured output) ends the run consuming nothing', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [claudeMaxTurns()] });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'failed', spawns: 1, reasons: ['child_exit_1'] })]);
    // Abandoned: no record, and the compile is still due.
    const tracker = await openTracker(world.a.dir);
    try {
      expect(await (await tracker.read()).choreRuns.records()).toEqual([]);
    } finally {
      await tracker.close();
    }
    expect(report.summary).toContain('nothing consumed');
  });
});

describe('the runner: a due compile through codex', () => {
  test('runs the C4 fallback invocation with each listed MCP server switched off, a strict schema, the bundle on stdin and the answer from -o', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const listed = JSON.stringify([
      { name: 'usermcp', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'never-logged' } } },
      { name: 'my server', enabled: true, disabled_reason: null, transport: { type: 'stdio', command: 'x', args: [], env: null } },
    ]);
    // A strict answer: optional fields come back null.
    const answer = { pages: [], consumption: d.pairs.map((pair) => ({ pair, slugs: null, no_pattern: 'nothing recurring' })), client: 'codex', model: null };
    const fake = await enabled('codex', world.a.dir, {
      login: { stdout: '', stderr: 'Logged in using ChatGPT\n', code: 0 },
      mcp: { stdout: listed, code: 0 },
      answers: [codexAnswer(answer)],
    });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ kind: 'wiki-maintainer', result: 'compiled', spawns: 1, auth_method: 'chatgpt' })]);
    const calls = fake.calls('codex');
    const run = calls.find((call) => call.type === 'answer')!;
    const at = (flag: string) => run.argv[run.argv.indexOf(flag) + 1]!;
    expect(run.argv).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--cd',
      run.cwd,
      '--sandbox',
      'read-only',
      '--output-schema',
      at('--output-schema'),
      '-o',
      at('-o'),
      '-c',
      'features.apps=false',
      '-c',
      'features.plugins=false',
      '-c',
      'features.hooks=false',
      '-c',
      'notify=[]',
      '-c',
      'developer_instructions=""',
      '-c',
      'features.shell_tool=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'skills.include_instructions=false',
      '-c',
      'model_provider="openai"',
      '-c',
      'mcp_servers.usermcp.enabled=false',
      '-c',
      'mcp_servers."my server".enabled=false',
    ]);
    expect(run.argv).not.toContain('--ignore-user-config');
    expect(run.cwdEntries).toEqual([]);
    expect(gitAncestor(run.cwd)).toBeNull();
    expect(existsSync(run.cwd)).toBe(false);
    expect(path.dirname(at('--output-schema'))).not.toBe(run.cwd);
    // The bundle on stdin: the plain header, the procedure (Codex has no system prompt file), the batch.
    expect(run.stdin.split('\n')[0]).toMatch(/^grimoire chore bundle/);
    expect(run.stdin).toContain("You are grimoire's chore runner");
    for (const pair of d.pairs) expect(run.stdin).toContain(pair);
    // The MCP list ran the way the exec runs: its overrides, in its cwd and env.
    const list = calls.filter((call) => call.type === 'mcp').at(-1)!;
    expect(list.argv).toEqual([...run.argv.slice(run.argv.indexOf('-c'), run.argv.indexOf('mcp_servers.usermcp.enabled=false') - 1), 'mcp', 'list', '--json']);
    expect(list.cwd).toBe(run.cwd);
    expect(list.env).toEqual(run.env);
    expect(calls.filter((call) => call.type === 'login').at(-1)!.env).toEqual(run.env);
  });
});

describe('the runner log', () => {
  test('keeps each spawn’s stdout and stderr on this machine, and drops the output of a run whose answer failed the secret scan', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const token = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
    const leaky = {
      ...noPatternAnswer(d.pairs),
      pages: [{ op: 'create', slug: 'token-leak', title: 'Token leak', kind: 'failure', summary: 'A token.', body: `Use ${token} to log in.\n` }],
      consumption: d.pairs.map((pair) => ({ pair, slugs: ['token-leak'] })),
    };
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [claudeAnswer(leaky), claudeAnswer(noPatternAnswer(d.pairs))] });

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'compiled', spawns: 2 })]);
    const logs = await readRunnerLogs(new MachineLocalStore(path.join(world.a.dir, '.git')));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ run: report.runs[0]!.run, runner: 'claude', result: 'compiled', dropped: 'secret-scan' });
    expect(logs[0]!.spawns.map((spawn) => [spawn.stdout, spawn.stderr])).toEqual([
      ['', ''],
      ['', ''],
    ]);
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  test('a clean run keeps the output', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [{ ...claudeAnswer(noPatternAnswer(d.pairs)), stderr: 'a warning\n' }] });

    await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true });

    const logs = await readRunnerLogs(new MachineLocalStore(path.join(world.a.dir, '.git')));
    expect(logs).toEqual([expect.objectContaining({ result: 'compiled', spawns: [expect.objectContaining({ code: 0, stderr: 'a warning\n', failure: null })] })]);
    expect(logs[0]!.spawns[0]!.stdout).toContain('"structured_output"');
  });
});
