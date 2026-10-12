// The human gate on skill proposals (spec §18 Review and decisions, Risk
// flags: the live evidence flag, Mechanical checks at accept, Pending
// lifecycle, The skill ledger; §15 reaching others; §20 the proposal screen's
// order): a person shows a proposal, acknowledges its red flags and decides
// it. Seam 1: the core against real git in temp repos.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { openTracker } from '../../src/tracker';
import { parseLedgerRecord } from '../../src/knowledge';
import { dashboard, terminal } from './chore-support';
import { ok, PAGE, patchResult, PORTS, proposer, SKILL, SKILL_V1, submit, type ProposerRun } from './proposer-support';
import { coreTest as test, trackerTip, TRACKER_REF } from './support';
import type { Checkout } from '#harness';

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
