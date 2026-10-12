// Shared by the Skill Proposer seam-1 tests: an evolved skill, failing traces,
// a pattern page and a compile, so the Skill Proposer is due, and the results
// and human decisions the tests submit.
import type { CallContext, ChoreBrief, ChoreReadResult, Core } from '../../src/core';
import { writeSkillChange } from '../../src/knowledge';
import { bundledRules, createScanner } from '../../src/scanner';
import { openTracker } from '../../src/tracker';
import type { Checkout, Clone } from '#harness';
import { choreAgent, Clock, commitChoreRun, compileRecord, putPage, terminal, workPair } from './chore-support';
import { T0, type Grimoire } from './support';

export function ok<T>(outcome: { ok: true; result: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw new Error(`call failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

export function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

export const SKILL = 'flaky-tests';
export const SKILL_V1 = skillText(
  SKILL,
  'Fix flaky tests in this repo. Use when a test fails only sometimes.',
  [
    '# Flaky tests',
    '',
    '1. Rerun the failing test alone with `npm test -- <file>`.',
    '2. Look for state shared between tests: globals, temp dirs, env vars.',
    '3. Pin random seeds with the `SEED` variable.',
    '4. Replace sleeps with waits on the event the test needs.',
    '5. Check the test for clock reads; inject the clock instead.',
    '6. Run the suite twice in a row before calling it fixed.',
    '7. Note the cause in the issue before closing it.',
    '',
  ].join('\n'),
);
export const PAGE = 'fixed-port-collisions';
export const PORTS = '\n## Ports\n\nBind test servers to port 0 and read the port back from the server.\n';

export interface ProposerRun {
  core: Core;
  clock: Clock;
  chores: CallContext;
  brief: ChoreBrief;
  /** The current version of the evolved skill. */
  base: string;
  fails: string[];
  passes: string[];
}

/** Every page of a run (or of one item), in order. */
export async function readAll(core: Core, ctx: CallContext, run: string, item?: string): Promise<ChoreReadResult[]> {
  const pages: ChoreReadResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = ok(await core.call('chore_read', { run, ...(item ? { item } : {}), ...(cursor ? { cursor } : {}) }, ctx));
    pages.push(page);
    if (!page.cursor) return pages;
    cursor = page.cursor;
  }
  throw new Error('chore_read never ended');
}

/**
 * An evolved skill, three failing traces on three issues and one pass, a
 * pattern page citing the fails and the compile that consumed them: the Skill
 * Proposer is due. Starts its run and reads everything, the page included.
 */
export async function proposer(
  grimoire: Grimoire,
  world: { a: Clone },
  options: { read?: boolean; work?: (core: Core) => Promise<{ fails: string[]; passes: string[] }> } = {},
): Promise<ProposerRun> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now });
  await core.call('settings_set', { key: 'chores.compile_pairs', value: 100 }, terminal(grimoire.ctx));
  const edited = ok(await core.call('skill_edit', { name: SKILL, text: SKILL_V1, base: null }, terminal(grimoire.ctx)));
  const work =
    options.work ??
    (async () => ({
      fails: [
        await workPair(core, grimoire.ctx, 'fail', 'Port clash in api tests'),
        await workPair(core, grimoire.ctx, 'fail', 'Port clash in worker tests'),
        await workPair(core, grimoire.ctx, 'fail', 'Port clash in e2e tests'),
      ],
      passes: [await workPair(core, grimoire.ctx, 'pass', 'Ports fixed in cli tests')],
    }));
  const { fails, passes } = await work(core);
  clock.advance(25);
  const version = await putPage(world.a, world.a, PAGE, [...fails, ...passes]);
  await commitChoreRun(world.a, world.a, compileRecord('cr-0000000001', clock.now().toISOString(), [...fails.map((t) => [t, 'fail'] as const), [passes[0]!, 'pass']], { [PAGE]: version }));
  const chores = await choreAgent(grimoire.ctx);
  const brief = ok(await core.call('chore_start', { kind: 'skill-proposer' }, chores));
  if (options.read !== false) {
    await readAll(core, chores, brief.run);
    await readAll(core, chores, brief.run, `page:${PAGE}`);
  }
  return { core, clock, chores, brief, base: edited.version, fails, passes };
}

/** A valid patch of the skill citing the page, the three fails and the pass. */
export function patchResult(p: ProposerRun, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'patch',
    target: SKILL,
    base_version: p.base,
    ops: [{ op: 'append', text: PORTS }],
    citations: [`page:${PAGE}`, ...p.fails.map((t) => `trace:${t}`), `trace:${p.passes[0]}`, `skill:${SKILL}`],
    claims: {
      rationale: 'Three test suites failed on fixed ports; the skill never says how to pick a port.',
      failures: p.fails.map((trace) => ({ trace, line: 'a fixed port was already taken' })),
      expected_signal: 'fewer reopened flaky-test issues',
      provenance: 'the fixed-port-collisions pattern page',
    },
    client: 'claude-code',
    model: 'claude-opus-5-5',
    ...overrides,
  };
}

export async function submit(p: ProposerRun, result: Record<string, unknown>) {
  return p.core.call('chore_submit', { run: p.brief.run, result }, p.chores);
}

/** Starts a manual Skill Proposer run and reads the page, the traces and the skill by item. */
export async function manualRun(p: ProposerRun): Promise<ProposerRun> {
  const brief = ok(await p.core.call('chore_start', { kind: 'skill-proposer', manual: true }, p.chores));
  for (const item of [`page:${PAGE}`, ...p.fails.map((t) => `trace:${t}`), `trace:${p.passes[0]}`, `skill:${SKILL}`]) await readAll(p.core, p.chores, brief.run, item);
  return { ...p, brief };
}

export const longBody = (lines: number) => Array.from({ length: lines }, (_, i) => `Step ${i + 1}: check the port the server bound.`).join('\n') + '\n';

export function createResult(p: ProposerRun, name: string, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { base_version: _base, ops: _ops, ...rest } = patchResult(p);
  return { ...rest, action: 'create', target: name, text: skillText(name, 'Pick free ports in tests. Use when a test binds a port.', body), ...overrides };
}

/** A human's delete of an evolved skill, written to the ledger as the gate will. */
export async function removeSkill(checkout: Checkout, clone: Clone, skill: string): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact({ op: 'delete', author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'human', surface: 'cli' } }, async (draft) => {
      await writeSkillChange(draft, createScanner(bundledRules), { kind: 'delete', skill, to: null }, { actor: { kind: 'human' }, by: clone.identity.email, surface: 'cli', clone: 'test-clone' });
      return { result: null };
    });
  } finally {
    await tracker.close();
  }
}

/** A human's decision on a proposal, written to the ledger as the gate will (GOK-165 brings the decision ops). */
export async function decide(checkout: Checkout, clone: Clone, kind: 'reject' | 'dismiss' | 'accept', skill: string, proposal: string, extra: { reason?: string; text?: string; at?: Date } = {}): Promise<void> {
  const tracker = await openTracker(checkout.dir, extra.at ? { clock: () => extra.at! } : {});
  try {
    await tracker.transact({ op: kind, author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'human', surface: 'cli' } }, async (draft) => {
      const change = { kind, skill, proposal, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.text ? { text: extra.text } : {}) };
      await writeSkillChange(draft, createScanner(bundledRules), change, { actor: { kind: 'human' }, by: clone.identity.email, surface: 'cli', clone: 'test-clone' });
      return { result: null };
    });
  } finally {
    await tracker.close();
  }
}
