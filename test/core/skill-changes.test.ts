// Humans control the evolved-skill set with forward-only changes (spec §18
// Restore, delete, eject, acknowledge; Forks across clones; The skill ledger;
// §15 Eject, Delete and delivery off; ADR 0005): restore, delete, eject,
// acknowledge and unblock are human-only core ops, each one skill ledger
// record. Seam 1: the core against real git in temp repos.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { terminal } from './chore-support';
import { createResult, manualRun, ok, patchResult, proposer, SKILL, SKILL_V1, skillText, submit } from './proposer-support';
import { coreTest as test, TRACKER_REF, trackerTip } from './support';
import { expectNoOutput, fileIn, NOTES, pinAndCommit } from '../generated/support';

const SEEDS = '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n';
const TIMEOUTS = '\n## Timeouts\n\nRaise a timeout only after finding what the test waits on.\n';

const human = (ctx: CallContext) => terminal(ctx);
const FREE_PORTS = skillText('free-ports', 'Pick free ports in tests. Use when a test binds a port.', '# Free ports\n\nBind to port 0.\n');

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

describe('delete and unblock', () => {
  test('a delete removes the copy and stubs from every same-pin worktree and blocks the name; restoring it is refused at the cap, and below the cap succeeds and lifts the block', async ({
    world,
    grimoire,
  }) => {
    const core = grimoire.makeCore();
    const cli = human(grimoire.ctx);
    const notes = ok(await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, cli));
    ok(await core.call('skill_edit', { name: 'free-ports', text: FREE_PORTS, base: null }, cli));
    await pinAndCommit(world.a);
    const b = await world.a.addWorktree('b');

    const deleted = ok(await core.call('skill_delete', { name: 'release-notes', base: notes.version }, cli));
    expect(deleted).toMatchObject({ name: 'release-notes', from: notes.version, stale: [] });
    // The deciding process refreshes its same-pin worktrees after the call answers.
    await core.close();
    for (const wt of [world.a, b]) {
      await expectNoOutput(wt, 'release-notes');
      expect(await fileIn(wt, '.grimoire/skills/free-ports/SKILL.md'), wt.dir).toBe(FREE_PORTS);
    }
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('skill-delete');

    const next = grimoire.makeCore();
    expect(await next.call('skill_read', { name: 'release-notes' }, grimoire.ctx)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const shown = ok(await next.call('skill_show', {}, cli));
    expect(shown.skills.map((skill) => [skill.name, skill.status, skill.blocked])).toEqual([
      ['free-ports', 'active', false],
      ['release-notes', 'deleted', true],
    ]);
    expect(shown.active).toBe(1);
    // A blocked name can't be created again.
    expect(await next.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });

    // At the cap, restoring the deleted skill counts like a create: refused, in the confirmation and the op alike.
    ok(await next.call('settings_set', { key: 'skills.max_active', value: 1 }, cli));
    expect(await next.call('skill_show', { name: 'release-notes', restore: notes.version }, cli)).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('cap') } } },
    });
    const tip = await trackerTip(world.a);
    expect(await next.call('skill_restore', { name: 'release-notes', version: notes.version, base: null }, cli)).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('cap') } } },
    });
    expect(await trackerTip(world.a)).toBe(tip);

    // Below the cap it succeeds, and lifts the name's block as part of the restore.
    ok(await next.call('settings_set', { key: 'skills.max_active', value: 2 }, cli));
    const plan = ok(await next.call('skill_show', { name: 'release-notes', restore: notes.version }, cli)).restore;
    expect(plan).toMatchObject({ current: null, status: 'deleted', lifts_block: true, undone: { kind: 'delete', version: null }, dropped: [] });
    const restored = ok(await next.call('skill_restore', { name: 'release-notes', version: notes.version, base: null }, cli));
    expect(restored).toMatchObject({ version: notes.version, from: null, lifted_block: true });
    expect(ok(await next.call('skill_read', { name: 'release-notes' }, grimoire.ctx))).toMatchObject({ version: notes.version, text: NOTES });
    expect(ok(await next.call('skill_show', { name: 'release-notes' }, cli)).skills[0]).toMatchObject({ status: 'active', blocked: false });
  });

  test('a proposal naming a deleted skill is invalid (blocked_name) until a human unblocks the name', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    ok(await p.core.call('skill_edit', { name: 'free-ports', text: FREE_PORTS, base: null }, cli));
    ok(await p.core.call('skill_delete', { name: 'free-ports' }, cli));
    expect(await p.core.call('skill_unblock', { name: SKILL }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });

    const body = '# Ports in tests\n\nAsk the operating system for a port: listen on port 0, then read the bound port back.\n';
    expect(ok(await submit(p, createResult(p, 'free-ports', body)))).toMatchObject({ result: 'invalid', reasons: ['blocked_name'] });

    const lifted = ok(await p.core.call('skill_unblock', { name: 'free-ports' }, cli));
    expect(lifted).toMatchObject({ name: 'free-ports', record: expect.any(String) });
    expect(ok(await p.core.call('skill_show', { name: 'free-ports' }, cli)).skills[0]).toMatchObject({ status: 'deleted', blocked: false });
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('unblock');

    // The run's one fix-up: the same create, now that the name is free.
    const proposed = ok(await submit(p, createResult(p, 'free-ports', body)));
    expect(proposed).toMatchObject({ proposal: expect.stringMatching(/^pp-/) });
  });
});
