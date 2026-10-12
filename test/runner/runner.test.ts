// Seam 1 (spec Testing Decisions; §16 The runner; spikes D (C3, P6) and F
// (C4, P7)): the runner, against stand-in `claude` and `codex` executables on
// PATH that record their argv, env, cwd and stdin. A due chore spawns the
// person's own client in a fresh, empty temp directory outside any repo, with
// the exact flags and the served bundle on stdin; its JSON answer goes through
// `chore_submit`, with exactly one fix-up respawn for an invalid answer.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { enableRunner, runChores, type RunnerKind } from '../../src/runner';
import { openTracker } from '../../src/tracker';
import { Clock, DEBRIEF, terminal } from '../core/chore-support';
import { coreTest as test, T0, type Grimoire } from '../core/support';
import { authStatus, claudeAnswer, claudeMaxTurns, codexAnswer, fakeAgents, gitAncestor, type FakeAgents } from './support';

function ok<T>(outcome: { ok: true; result: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw new Error(`call failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

let agents: FakeAgents | null = null;
afterEach(async () => {
  await agents?.cleanup();
  agents = null;
});

async function work(core: Core, ctx: CallContext, verdict: 'pass' | 'fail', title: string): Promise<string> {
  const { id } = ok(await core.call('create', { title, body: `Body of ${title}` }, ctx));
  const { attempt } = ok(await core.call('claim', { id }, ctx));
  if (verdict === 'pass') ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  else ok(await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx));
  return attempt;
}

interface Due {
  core: Core;
  clock: Clock;
  /** The batch's pairs, `<trace>@<outcome>`. */
  pairs: string[];
}

/** A settled fail and two passes: the Wiki Maintainer is due (at 1 pair); one fail doesn't make the Skill Proposer due after it. */
async function dueCompile(grimoire: Grimoire): Promise<Due> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now });
  ok(await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx)));
  const pairs = [
    `${await work(core, grimoire.ctx, 'fail', 'Fail 0')}@fail`,
    `${await work(core, grimoire.ctx, 'pass', 'Pass 1')}@pass`,
    `${await work(core, grimoire.ctx, 'pass', 'Pass 0')}@pass`,
  ];
  clock.advance(25);
  return { core, clock, pairs };
}

/** A valid compile: every pair to no_pattern. */
function noPatternAnswer(pairs: readonly string[]) {
  return { pages: [], consumption: pairs.map((pair) => ({ pair, no_pattern: 'nothing recurring' })), client: 'claude-code', model: 'claude-opus-5-5' };
}

async function enabled(kind: RunnerKind, root: string, plan: Parameters<FakeAgents['plan']>[1], extra: NodeJS.ProcessEnv = {}) {
  agents = await fakeAgents();
  await agents.plan(kind, plan);
  await enableRunner({ root, kind, allowApiBilling: false, env: agents.env(extra) });
  return agents;
}

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
