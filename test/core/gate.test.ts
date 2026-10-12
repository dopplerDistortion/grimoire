// The human gate on skill proposals (spec §18 Review and decisions, Risk
// flags: the live evidence flag, Mechanical checks at accept, Pending
// lifecycle, The skill ledger; §15 reaching others; §20 the proposal screen's
// order): a person shows a proposal, acknowledges its red flags and decides
// it. Seam 1: the core against real git in temp repos.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { openTracker } from '../../src/tracker';
import { parseLedgerRecord, writeSkillChange } from '../../src/knowledge';
import { bundledRules, createScanner } from '../../src/scanner';
import { dashboard, terminal } from './chore-support';
import { createResult, manualRun, ok, PAGE, patchResult, PORTS, proposer, SKILL, SKILL_V1, submit, type ProposerRun } from './proposer-support';
import { agentContext, coreTest as test, fetchTracker, fetchTrackerFrom, pushTracker, trackerFile, trackerTip, TRACKER_REF } from './support';
import { fileIn, pinAndCommit } from '../generated/support';
import type { Checkout, GitWorld } from '#harness';

/**
 * A patch citing exactly the evidence minimum: the page, two of the failing
 * traces and the pass (3 traces from 3 issues, 2 failing).
 */
function minimalPatch(p: ProposerRun, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fails = p.fails.slice(0, 2);
  const base = patchResult(p);
  return {
    ...base,
    citations: [`page:${PAGE}`, ...fails.map((t) => `trace:${t}`), `trace:${p.passes[0]}`, `skill:${SKILL}`],
    claims: { ...(base.claims as object), failures: fails.map((trace) => ({ trace, line: 'a fixed port was already taken' })) },
    ...overrides,
  };
}

async function ledgerRecords(checkout: Checkout) {
  const tracker = await openTracker(checkout.dir);
  try {
    const view = await tracker.read();
    return [...(await view.ledgerFiles())].map(([id, bytes]) => parseLedgerRecord(id, bytes)!).filter((entry) => entry !== null);
  } finally {
    await tracker.close();
  }
}

const human = (ctx: CallContext) => terminal(ctx);

describe('the live evidence flag', () => {
  test('purging a cited failing trace drops the evidence below the minimum: proposal show lists a live red flag, accept is refused until it is acknowledged, and the acknowledgement is in the ledger', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, minimalPatch(p)));
    const cli = human(grimoire.ctx);

    const before = ok(await p.core.call('proposal_show', { id: proposal }, cli));
    expect(before).toMatchObject({ id: proposal, status: 'pending', red_flags: [] });

    ok(await p.core.call('purge_trace', { attempt: p.fails[0], reason: 'held a customer name' }, cli));

    const shown = ok(await p.core.call('proposal_show', { id: proposal }, cli));
    expect(shown.status).toBe('pending');
    expect(shown.red_flags).toEqual([expect.objectContaining({ flag: 'evidence', live: true })]);
    expect(shown.traces).toContainEqual(expect.objectContaining({ trace: p.fails[0], purged: true, outcome_at_drafting: 'fail', outcome_now: null }));
    // The slot stays taken while the flagged proposal waits.
    const listed = ok(await p.core.call('proposal_list', {}, cli));
    expect(listed.pending).toEqual([proposal]);

    const tip = await trackerTip(world.a);
    const refused = await p.core.call('proposal_accept', { id: proposal }, cli);
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { acks: expect.stringContaining('evidence') } } } });
    expect(await trackerTip(world.a)).toBe(tip);

    const accepted = ok(await p.core.call('proposal_accept', { id: proposal, acks: ['evidence'] }, cli));
    expect(accepted).toMatchObject({ id: proposal, status: 'accepted', skill: SKILL, version: shown.version, from: p.base });

    const accept = (await ledgerRecords(world.a)).find((record) => record.kind === 'accept');
    expect(accept).toMatchObject({ proposal, acks: ['evidence'], basis: 'human review', from: p.base, to: shown.version, surface: 'cli' });
    expect(accept!.saw).toEqual(expect.arrayContaining([p.base, shown.version]));
    // One commit holds the decision and the version text.
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('accept');
    const skill = ok(await p.core.call('skill_show', { name: SKILL }, cli));
    expect(skill.skills[0]).toMatchObject({ current: shown.version, served: shown.version, text: `${SKILL_V1}${PORTS}` });
    expect(ok(await p.core.call('proposal_show', { id: proposal }, dashboard(grimoire.ctx))).status).toBe('accepted');
  });
});

describe('accept', () => {
  test('accepting a patch makes its version current, refreshes the copy and stubs in every same-pin worktree, and stales the other pending proposals on that skill', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal: first } = ok(await submit(p, patchResult(p)));
    ok(await p.core.call('settings_set', { key: 'proposals.pending_limit', value: 2 }, cli));
    const again = await manualRun(p);
    const seeds = { ops: [{ op: 'append', text: '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n' }] };
    const { proposal: second } = ok(await submit(again, patchResult(again, seeds)));
    await pinAndCommit(world.a);
    const b = await world.a.addWorktree('b');

    const accepted = ok(await p.core.call('proposal_accept', { id: first, then_edit: true }, cli));
    expect(accepted).toMatchObject({ status: 'accepted', from: p.base, acks: [], edit: `grimoire skill edit ${SKILL}` });
    // The deciding process refreshes its same-pin worktrees after the call answers.
    await p.core.close();

    for (const wt of [world.a, b]) {
      expect(await fileIn(wt, `.grimoire/skills/${SKILL}/SKILL.md`), wt.dir).toBe(`${SKILL_V1}${PORTS}`);
      expect(await fileIn(wt, `.claude/skills/grimoire-${SKILL}/SKILL.md`), wt.dir).toContain(`name: grimoire-${SKILL}`);
      expect(await fileIn(wt, `.agents/skills/grimoire-${SKILL}/SKILL.md`), wt.dir).toContain(`name: grimoire-${SKILL}`);
    }
    const listed = ok(await p.core.call('proposal_list', {}, cli));
    expect(listed.proposals.map((row) => [row.id, row.status])).toEqual([
      [first, 'accepted'],
      [second, 'stale'],
    ]);
    expect(listed.pending).toEqual([]);
    expect(listed.history).toMatchObject({ accepted: 1, rejected: 0, accept_rate: 1, baseline: 0.29 });
    // A stale proposal can't be accepted: its base moved.
    expect(await p.core.call('proposal_accept', { id: second }, cli)).toMatchObject({ ok: false, error: { code: 'BASE_MOVED' } });
  });

  test('a create that would exceed the cap at accept becomes lapsed, which frees the slot; nothing is accepted', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal } = ok(await submit(p, createResult(p, 'free-ports', '# Free ports\n\nListen on port 0 and read the bound port back.\n')));
    ok(await p.core.call('settings_set', { key: 'skills.max_active', value: 1 }, cli));

    const lapsed = ok(await p.core.call('proposal_accept', { id: proposal }, cli));
    expect(lapsed).toMatchObject({ id: proposal, status: 'lapsed', reasons: ['at_cap'] });
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('accept');

    const shown = ok(await p.core.call('proposal_show', { id: proposal }, cli));
    expect(shown).toMatchObject({ status: 'lapsed', checks: null, decision: { kind: 'lapse', reason: 'at_cap' } });
    expect(ok(await p.core.call('proposal_list', {}, cli)).pending).toEqual([]);
    // The name's ledger holds the lapse, and no version: nothing became active.
    expect(ok(await p.core.call('skill_show', {}, cli)).skills.map((skill) => [skill.name, skill.status, skill.current])).toEqual([
      [SKILL, 'active', p.base],
      ['free-ports', 'none', null],
    ]);
    // The slot is free: a manual Skill Proposer run may start again.
    expect(await p.core.call('chore_start', { kind: 'skill-proposer', manual: true }, p.chores)).toMatchObject({ ok: true });
  });

  test('proposal show lists the checks, flags and diffs first and the claims last, labelled unverified', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const shown = ok(await p.core.call('proposal_show', { id: proposal }, human(grimoire.ctx)));
    const keys = Object.keys(shown);
    const order = ['checks', 'red_flags', 'description_diff', 'body_diff', 'traces', 'pages', 'scorecard', 'ledger', 'result', 'claims'];
    const at = order.map((key) => keys.indexOf(key));
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect(at).not.toContain(-1);
    expect(keys.at(-1)).toBe('claims');
    expect(shown.checks).toEqual({ passed: true, reasons: [], problems: {} });
    expect(shown.description_diff).toEqual(['  Fix flaky tests in this repo. Use when a test fails only sometimes.']);
    expect(shown.body_diff.filter((line) => line.startsWith('+ '))).toEqual(['+ ', '+ ## Ports', '+ ', '+ Bind test servers to port 0 and read the port back from the server.']);
    expect(shown.pages).toEqual([{ slug: PAGE, gone: false, quarantined: false, counts: true, changed_since: false }]);
    expect(shown.traces).toHaveLength(4);
    expect(shown.traces[0]).toMatchObject({ outcome_at_drafting: expect.any(String), outcome_now: expect.any(String), purged: false, quarantined: false, versions_read: [] });
    expect(shown.scorecard).toMatchObject({ version: p.base });
    expect(shown.ledger.map((record) => record.kind)).toEqual(['edit']);
    expect(shown.result.text).toBe(`${SKILL_V1}${PORTS}`);
    expect(shown.claims).toMatchObject({ unverified: true, rationale: expect.stringContaining('fixed ports'), model: 'claude-opus-5-5' });
  });
});

describe('reject, dismiss, reconsider', () => {
  test('a suspicious reject quarantines the cited traces and pages by default, and a later near-identical proposal is refused by the repeat check', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal } = ok(await submit(p, patchResult(p)));

    const rejected = ok(await p.core.call('proposal_reject', { id: proposal, reason: 'suspicious' }, cli));
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'suspicious' });
    expect([...rejected.quarantined.traces].sort()).toEqual([...p.fails, p.passes[0]!].sort());
    expect(rejected.quarantined.pages).toEqual([PAGE]);
    expect((await ledgerRecords(world.a)).find((record) => record.kind === 'reject')).toMatchObject({ proposal, reason: 'suspicious', basis: 'human review' });
    expect(ok(await p.core.call('proposal_show', { id: proposal }, cli)).status).toBe('rejected');

    // Lift the quarantine so a new run may cite the same evidence; the change itself stays refused.
    for (const trace of rejected.quarantined.traces) ok(await p.core.call('unquarantine', { trace }, cli));
    ok(await p.core.call('unquarantine', { page: PAGE }, cli));
    const again = await manualRun(p);
    const reworded = '\n## Ports\n\nBind  test servers to port 0 and read the port back from the server. \n';
    expect(ok(await submit(again, patchResult(again, { ops: [{ op: 'append', text: reworded }] })))).toMatchObject({ result: 'invalid', reasons: ['repeats_rejected'] });
  });

  test('reject with other needs text; quarantine goes only with suspicious; a suspicious reject may keep the evidence unquarantined', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal } = ok(await submit(p, patchResult(p)));
    expect(await p.core.call('proposal_reject', { id: proposal, reason: 'other' }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { text: expect.any(String) } } } });
    expect(await p.core.call('proposal_reject', { id: proposal, reason: 'one-off', quarantine: true }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const kept = ok(await p.core.call('proposal_reject', { id: proposal, reason: 'suspicious', quarantine: false }, cli));
    expect(kept.quarantined).toEqual({ traces: [], pages: [] });
    expect(await p.core.call('proposal_reject', { id: proposal, reason: 'one-off' }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  test('dismiss frees the slot without a verdict; reconsider brings it back only while the slot is free', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal: first } = ok(await submit(p, patchResult(p)));

    expect(ok(await p.core.call('proposal_dismiss', { id: first }, cli))).toMatchObject({ status: 'dismissed' });
    expect(ok(await p.core.call('proposal_list', {}, cli)).pending).toEqual([]);

    // Another proposal takes the free slot: reconsidering the dismissed one is refused.
    const again = await manualRun(p);
    const seeds = { ops: [{ op: 'append', text: '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n' }] };
    const { proposal: second } = ok(await submit(again, patchResult(again, seeds)));
    expect(await p.core.call('proposal_reconsider', { id: first }, cli)).toMatchObject({ ok: false, error: { code: 'PENDING_LIMIT', details: { pending: [second] } } });

    ok(await p.core.call('proposal_dismiss', { id: second }, cli));
    expect(ok(await p.core.call('proposal_reconsider', { id: first }, cli))).toMatchObject({ status: 'pending' });
    expect(ok(await p.core.call('proposal_list', {}, cli))).toMatchObject({ pending: [first], history: { dismissed: 1, accept_rate: null } });
    // Only a dismissed proposal is reconsidered.
    expect(await p.core.call('proposal_reconsider', { id: first }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('purge', () => {
  test('purging a proposal removes its record and leaves a tombstone that dominates a fold; purge_trace names the proposals citing a trace', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const { proposal } = ok(await submit(p, minimalPatch(p)));
    await pushTracker(world.a);

    const purged = ok(await p.core.call('purge_trace', { attempt: p.fails[0], reason: 'a customer name' }, cli));
    expect(purged.cited_by.proposals).toEqual([proposal]);

    const result = ok(await p.core.call('proposal_purge', { id: proposal, reason: 'quoted a secret' }, cli));
    expect(result).toMatchObject({ id: proposal, purged: true, changed: true, reason: 'quoted a secret', history: { pushed: true } });
    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, `purges/${proposal}.md`)).toContain('reason: "quoted a secret"');
    expect(await world.a.git(['ls-tree', '-r', '--name-only', tip, '--', 'knowledge/proposals'])).toBe('');
    expect(await p.core.call('proposal_show', { id: proposal }, cli)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { purged: expect.any(Object) } } });
    expect(ok(await p.core.call('proposal_list', {}, cli)).proposals).toEqual([]);

    // The remote still holds the proposal; a fold with it keeps the tombstone's word.
    await fetchTracker(world.a);
    ok(await p.core.call('sync', {}, cli));
    const folded = (await trackerTip(world.a))!;
    expect(await world.a.git(['ls-tree', '-r', '--name-only', folded, '--', 'knowledge/proposals'])).toBe('');
    expect(ok(await p.core.call('proposal_list', {}, cli)).proposals).toEqual([]);
  });
});

describe('the human-only gate', () => {
  test('every decision from an agent surface gives HUMAN_ONLY, and proposal show and list are for people only', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const agent = grimoire.ctx;
    const calls: [string, Record<string, unknown>][] = [
      ['proposal_accept', { id: proposal }],
      ['proposal_reject', { id: proposal, reason: 'incorrect' }],
      ['proposal_dismiss', { id: proposal }],
      ['proposal_reconsider', { id: proposal }],
      ['proposal_purge', { id: proposal, reason: 'x' }],
      ['proposal_show', { id: proposal }],
      ['proposal_list', {}],
    ];
    for (const [op, input] of calls) expect(await p.core.call(op, input, agent), op).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    // Without a TTY the CLI is no human surface for a decision.
    expect(await p.core.call('proposal_accept', { id: proposal }, { ...human(agent), tty: false })).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    expect(ok(await p.core.call('proposal_list', {}, { ...human(agent), tty: false })).pending).toEqual([proposal]);
  });
});

/** Clone b takes a's tracker as its own, so the two decide apart until they fold. */
async function share(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

async function exchange(world: GitWorld): Promise<void> {
  await fetchTrackerFrom(world.a, world.b);
  await fetchTrackerFrom(world.b, world.a);
}

/** A restore of `skill` to `to`, written as the restore op will (GOK-168). */
async function restore(checkout: Checkout, skill: string, to: string): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact({ op: 'restore', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'human', surface: 'cli' } }, async (draft) => {
      await writeSkillChange(draft, createScanner(bundledRules), { kind: 'restore', skill, to }, { actor: { kind: 'human' }, by: 'alice@example.com', surface: 'cli', clone: 'test-clone' });
      return { result: null };
    });
  } finally {
    await tracker.close();
  }
}

describe('derived statuses across clones and later changes', () => {
  test('an accept on one clone against a suspicious reject on another reads contested, withholding the accepted version until a human skill change settles it', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    await share(world);
    ok(await p.core.call('proposal_reject', { id: proposal, reason: 'suspicious', quarantine: false }, human(agentContext(world.b))));
    const accepted = ok(await p.core.call('proposal_accept', { id: proposal }, human(grimoire.ctx)));
    await exchange(world);

    for (const clone of [world.a, world.b]) {
      expect(ok(await p.core.call('proposal_show', { id: proposal }, human(agentContext(clone)))).status, clone.dir).toBe('contested');
      expect(ok(await p.core.call('skill_read', { name: SKILL }, agentContext(clone))).version, clone.dir).toBe(p.base);
    }
    // A human edit that follows both decisions settles it: the accept stands.
    ok(await p.core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${PORTS}8. Ask a human when nothing else works.\n`, base: accepted.version }, human(grimoire.ctx)));
    expect(ok(await p.core.call('proposal_show', { id: proposal }, human(grimoire.ctx))).status).toBe('accepted');
  });

  test('two accepts of different proposals on two clones: the losing side reads superseded; a restore off an accepted version makes it undone', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    ok(await p.core.call('settings_set', { key: 'proposals.pending_limit', value: 2 }, cli));
    const { proposal: first } = ok(await submit(p, patchResult(p)));
    const again = await manualRun(p);
    const seeds = { ops: [{ op: 'append', text: '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n' }] };
    const { proposal: second } = ok(await submit(again, patchResult(again, seeds)));
    await share(world);
    const onA = ok(await p.core.call('proposal_accept', { id: first }, cli));
    const onB = ok(await p.core.call('proposal_accept', { id: second }, human(agentContext(world.b))));
    await exchange(world);

    const [winner, loser] = onA.version! < onB.version! ? [first, second] : [second, first];
    const listed = ok(await p.core.call('proposal_list', {}, cli));
    expect(Object.fromEntries(listed.proposals.map((row) => [row.id, row.status]))).toEqual({ [winner!]: 'accepted', [loser!]: 'superseded' });

    await restore(world.a, SKILL, p.base);
    const after = ok(await p.core.call('proposal_list', {}, cli));
    expect(after.proposals.find((row) => row.id === winner)?.status).toBe('undone');
  });
});
