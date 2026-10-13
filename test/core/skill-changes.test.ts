// Humans control the evolved-skill set with forward-only changes (spec §18
// Restore, delete, eject, acknowledge; Forks across clones; The skill ledger;
// §15 Eject, Delete and delivery off; ADR 0005): restore, delete, eject,
// acknowledge and unblock are human-only core ops, each one skill ledger
// record. Seam 1: the core against real git in temp repos.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { terminal } from './chore-support';
import { manualRun, ok, patchResult, proposer, SKILL, SKILL_V1, submit } from './proposer-support';
import { coreTest as test } from './support';

const SEEDS = '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n';
const TIMEOUTS = '\n## Timeouts\n\nRaise a timeout only after finding what the test waits on.\n';

const human = (ctx: CallContext) => terminal(ctx);

describe('restore', () => {
  test('with v1 → v2 → v3, restoring v1 makes v1 current: the confirmation lists v3 as undone and v2 as dropped, and pending proposals on the skill go stale', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const v1 = p.base;
    const v2 = ok(await p.core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${SEEDS}`, base: v1 }, cli)).version;
    const v3 = ok(await p.core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${SEEDS}${TIMEOUTS}`, base: v2 }, cli)).version;
    ok(await p.core.call('chore_abandon', { run: p.brief.run, reason: 'the skill moved' }, p.chores));
    const again = await manualRun({ ...p, base: v3 });
    const { proposal } = ok(await submit(again, patchResult(again)));
    expect(ok(await p.core.call('proposal_list', {}, cli)).pending).toEqual([proposal]);

    // The confirmation: what the restore undoes and drops, each dropped version diffed, before anything is written.
    const shown = ok(await p.core.call('skill_show', { name: SKILL, restore: v1 }, cli));
    expect(shown.restore).toMatchObject({
      skill: SKILL,
      version: v1,
      current: v3,
      undone: { kind: 'edit', version: v3 },
      dropped: [{ kind: 'edit', version: v2 }],
      lifts_block: false,
    });
    expect(shown.restore!.dropped[0]!.diff).toContain('+ ## Seeds');
    expect(shown.restore!.diff).toContain('- ## Timeouts');

    const restored = ok(await p.core.call('skill_restore', { name: SKILL, version: v1, base: v3 }, cli));
    expect(restored).toMatchObject({ name: SKILL, version: v1, from: v3, undone: { version: v3 }, dropped: [{ version: v2 }], stale: [proposal] });

    expect(ok(await p.core.call('skill_read', { name: SKILL }, grimoire.ctx))).toMatchObject({ version: v1, text: SKILL_V1 });
    const listed = ok(await p.core.call('proposal_list', {}, cli));
    expect(listed.proposals.find((row) => row.id === proposal)?.status).toBe('stale');
    expect(listed.pending).toEqual([]);
    // The ledger history reads what the restore did to each change.
    const history = ok(await p.core.call('skill_show', { name: SKILL }, cli)).skills[0]!.history!;
    expect(history.map((row) => [row.kind, row.version, row.fate ?? null])).toEqual([
      ['edit', v1, null],
      ['edit', v2, 'dropped'],
      ['edit', v3, 'undone'],
      ['restore', v1, null],
    ]);
  });
});
