// Runner test scenarios on the core seam: settled pairs made through the
// core's own ops, a clock the tests move, and stand-ins enabled as the runner.
import { expect, onTestFinished } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { GrimoireError } from '../../src/errors';
import { readStatus, STATUS_FACTS } from '../../src/installer/status';
import { enableRunner, type RunnerKind } from '../../src/runner';
import { Clock, DEBRIEF, terminal } from '../core/chore-support';
import { T0, type Grimoire } from '../core/support';
import { fakeAgents, type FakeAgents, type Plan } from './support';

export function ok<T>(outcome: { ok: true; result: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw new Error(`call failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

/** One attempt worked to its end: a pass (closed done) or a fail (released). Returns its handle. */
export async function work(core: Core, ctx: CallContext, verdict: 'pass' | 'fail', title: string): Promise<string> {
  const { id } = ok(await core.call('create', { title, body: `Body of ${title}` }, ctx));
  const { attempt } = ok(await core.call('claim', { id }, ctx));
  if (verdict === 'pass') ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  else ok(await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx));
  return attempt;
}

export interface Due {
  core: Core;
  clock: Clock;
  /** The batch's pairs, `<trace>@<outcome>`. */
  pairs: string[];
}

/** A settled fail and two passes: the Wiki Maintainer is due (at 1 pair); one fail doesn't make the Skill Proposer due after it. */
export async function dueCompile(grimoire: Grimoire): Promise<Due> {
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
export function noPatternAnswer(pairs: readonly string[]) {
  return { pages: [], consumption: pairs.map((pair) => ({ pair, no_pattern: 'nothing recurring' })), client: 'claude-code', model: 'claude-opus-5-5' };
}

/** Stand-ins on PATH, removed after the test. */
export async function agentsForTest(): Promise<FakeAgents> {
  const agents = await fakeAgents();
  onTestFinished(() => agents.cleanup());
  return agents;
}

/** Stand-ins answering `plan`, and the runner enabled for `kind` (no API billing). */
export async function enabled(kind: RunnerKind, root: string, plan: Plan, extra: NodeJS.ProcessEnv = {}): Promise<FakeAgents> {
  const agents = await agentsForTest();
  await agents.plan(kind, plan);
  await enableRunner({ root, kind, allowApiBilling: false, env: agents.env(extra) });
  return agents;
}

/** The runner fact of `status`. */
export async function runnerFact(root: string, now: Date): Promise<Record<string, unknown>> {
  const { report } = await readStatus({ root, now, facts: STATUS_FACTS.filter((fact) => fact.key === 'runner') });
  return report.runner as Record<string, unknown>;
}

/** The GrimoireError `promise` rejects with. */
export async function expectError(promise: Promise<unknown>): Promise<GrimoireError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(GrimoireError);
  return error as GrimoireError;
}
