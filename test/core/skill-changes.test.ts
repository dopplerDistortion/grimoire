// Humans control the evolved-skill set with forward-only changes (spec §18
// Restore, delete, eject, acknowledge; Forks across clones; The skill ledger;
// §15 Eject, Delete and delivery off; ADR 0005): restore, delete, eject,
// acknowledge and unblock are human-only core ops, each one skill ledger
// record. Seam 1: the core against real git in temp repos.
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import type { GitWorld } from '#harness';
import { terminal } from './chore-support';
import { createResult, manualRun, ok, patchResult, PORTS, proposer, readAll, SKILL, SKILL_V1, skillText, submit } from './proposer-support';
import { agentContext, coreTest as test, fetchTracker, fetchTrackerFrom, pushTracker, TRACKER_REF, trackerTip } from './support';
import { existsIn, expectNoOutput, fileIn, gitStatus, NOTES, NOTES_DESCRIPTION, pinAndCommit, writeInto } from '../generated/support';

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

    // What the restore undid is negative evidence; what it dropped may be proposed again.
    const after = await manualRun({ ...p, base: v1 });
    expect(ok(await submit(after, patchResult(after, { ops: [{ op: 'append', text: TIMEOUTS }] })))).toMatchObject({
      result: 'invalid',
      reasons: ['repeats_rejected'],
    });
    expect(ok(await submit(after, patchResult(after, { ops: [{ op: 'append', text: SEEDS }] })))).toMatchObject({ proposal: expect.stringMatching(/^pp-/) });
  });

  test('a restore that undoes a restore makes the change that restore made negative evidence, in the repeat check and the Proposer digest alike', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const v1 = p.base;
    const v2 = ok(await p.core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${SEEDS}`, base: v1 }, cli)).version;
    ok(await p.core.call('skill_restore', { name: SKILL, version: v1, base: v2 }, cli));
    // Back to v2: this undoes the first restore (v2 → v1, the Seeds section removed).
    const shown = ok(await p.core.call('skill_show', { name: SKILL, restore: v2 }, cli)).restore!;
    expect(shown.undone).toMatchObject({ kind: 'restore', version: v1 });
    ok(await p.core.call('skill_restore', { name: SKILL, version: v2, base: v1 }, cli));
    ok(await p.core.call('chore_abandon', { run: p.brief.run, reason: 'the skill moved' }, p.chores));

    const again = await manualRun({ ...p, base: v2 });
    const [digest] = (await readAll(p.core, p.chores, again.brief.run, 'ledger')).flatMap((page) => page.items);
    expect(digest!.text).toContain(`undone change ${v2.slice(0, 12)} -> ${v1.slice(0, 12)}`);
    expect(digest!.text).not.toContain(`undone change none`);
    const removeSeeds = [{ op: 'replace', anchor: SEEDS.trimStart(), text: '' }];
    expect(ok(await submit(again, patchResult(again, { ops: removeSeeds })))).toMatchObject({ result: 'invalid', reasons: ['repeats_rejected'] });
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

  test('restore, delete and eject each commit only against the version the person saw: without a base they are refused', async ({ world, grimoire }) => {
    const core = grimoire.makeCore();
    const cli = human(grimoire.ctx);
    const v1 = ok(await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, cli)).version;
    const v2 = ok(await core.call('skill_edit', { name: 'release-notes', text: `${NOTES}${SEEDS}`, base: v1 }, cli)).version;
    const tip = await trackerTip(world.a);
    for (const [op, input] of [
      ['skill_restore', { name: 'release-notes', version: v1 }],
      ['skill_delete', { name: 'release-notes' }],
      ['skill_eject', { name: 'release-notes' }],
    ] as const) {
      expect(await core.call(op, input, cli), op).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { base: expect.any(String) } } } });
      // A base that is no longer current: BASE_MOVED, nothing written.
      expect(await core.call(op, { ...input, base: v1 }, cli), op).toMatchObject({ ok: false, error: { code: 'BASE_MOVED', details: { current: v2 } } });
    }
    expect(await trackerTip(world.a)).toBe(tip);
    await core.close();
  });

  test('a proposal naming a deleted skill is invalid (blocked_name) until a human unblocks the name', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const cli = human(grimoire.ctx);
    const ports = ok(await p.core.call('skill_edit', { name: 'free-ports', text: FREE_PORTS, base: null }, cli));
    ok(await p.core.call('skill_delete', { name: 'free-ports', base: ports.version }, cli));
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

describe('eject', () => {
  test('eject writes the current text into both client folders of the chosen worktree and blocks the name; no stub for it is generated anywhere afterwards, and an existing target is refused', async ({
    world,
    grimoire,
  }) => {
    const core = grimoire.makeCore();
    const cli = human(grimoire.ctx);
    const notes = ok(await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, cli));
    const ports = ok(await core.call('skill_edit', { name: 'free-ports', text: FREE_PORTS, base: null }, cli));
    await pinAndCommit(world.a);
    const b = await world.a.addWorktree('b');
    // A hand-written folder of free-ports already sits in one client folder of b.
    await writeInto(b.dir, '.agents/skills/free-ports/SKILL.md', 'hand-written\n');

    const tip = await trackerTip(world.a);
    expect(await core.call('skill_eject', { name: 'free-ports', worktree: b.dir, base: ports.version }, cli)).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('.agents/skills/free-ports') } } },
    });
    expect(await existsIn(b, '.claude/skills/free-ports')).toBe(false);
    expect(await core.call('skill_eject', { name: 'release-notes', worktree: path.dirname(world.a.dir), base: notes.version }, cli)).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { worktree: expect.any(String) } } },
    });
    expect(await trackerTip(world.a)).toBe(tip);

    const ejected = ok(await core.call('skill_eject', { name: 'release-notes', worktree: b.dir, base: notes.version }, cli));
    expect(ejected).toMatchObject({
      name: 'release-notes',
      version: notes.version,
      files: ['.claude/skills/release-notes/SKILL.md', '.agents/skills/release-notes/SKILL.md'],
    });
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('eject');
    await core.close();

    // The refresh that removed the stubs left the ejected files alone.
    for (const file of ejected.files) expect(await fileIn(b, file), file).toBe(NOTES);
    // Ordinary files the person commits: untracked, with no grimoire .gitignore.
    expect(await gitStatus(b)).toContain('.claude/skills/release-notes/SKILL.md');
    for (const wt of [world.a, b]) {
      await expectNoOutput(wt, 'release-notes');
      expect(await fileIn(wt, '.grimoire/skills/free-ports/SKILL.md'), wt.dir).toBe(FREE_PORTS);
    }
    expect(await existsIn(world.a, '.claude/skills/release-notes')).toBe(false);

    const next = grimoire.makeCore();
    expect(ok(await next.call('skill_show', { name: 'release-notes' }, cli)).skills[0]).toMatchObject({ status: 'ejected', blocked: true, served: null });
    expect(ok(await next.call('skill_list', {}, grimoire.ctx)).skills.map((skill) => skill.name)).toEqual(['free-ports']);
    // A hand-written skill from now on: grimoire won't restore over it.
    expect(await next.call('skill_restore', { name: 'release-notes', version: notes.version, base: null }, cli)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('eject of a version served nowhere', () => {
  test('eject refuses the withheld version of a suspicious-contested accept and writes nothing', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    await share(world);
    ok(await p.core.call('proposal_reject', { id: proposal, reason: 'suspicious', quarantine: false }, human(agentContext(world.b))));
    const accepted = ok(await p.core.call('proposal_accept', { id: proposal }, human(grimoire.ctx)));
    await exchange(world);
    const shown = ok(await p.core.call('skill_show', { name: SKILL }, human(grimoire.ctx))).skills[0]!;
    expect(shown.current).toBe(accepted.version);
    expect(await servedIn(p.core, grimoire.ctx, SKILL)).toBe(p.base);

    const tip = await trackerTip(world.a);
    expect(await p.core.call('skill_eject', { name: SKILL, base: accepted.version }, human(grimoire.ctx))).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('acknowledge') } } },
    });
    expect(await existsIn(world.a, `.claude/skills/${SKILL}`)).toBe(false);
    expect(await existsIn(world.a, `.agents/skills/${SKILL}`)).toBe(false);
    expect(await trackerTip(world.a)).toBe(tip);
  });
});

/** Clone b takes a's tracker as its own, so the two write apart from here until they fold. */
async function share(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

/** Each clone fetches the other's tracker: both now read the fold of the two. */
async function exchange(world: GitWorld): Promise<void> {
  await fetchTrackerFrom(world.a, world.b);
  await fetchTrackerFrom(world.b, world.a);
}

/** What `ctx`'s clone serves agents of a skill: the version, or the error code. */
async function servedIn(core: Core, ctx: CallContext, name = 'release-notes'): Promise<string> {
  const read = await core.call('skill_read', { name }, ctx);
  return read.ok ? read.result.version : read.error.code;
}

describe('acknowledge', () => {
  test('a fork of two creates across two clones is resolved by acknowledging the chosen version, on both clones', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await share(world);
    const bob = agentContext(world.b);
    const texts = [skillText('release-notes', NOTES_DESCRIPTION, '# Alice’s way\n'), skillText('release-notes', NOTES_DESCRIPTION, '# Bob’s way\n')];
    ok(await core.call('skill_edit', { name: 'release-notes', text: texts[0], base: null }, human(ctx)));
    ok(await core.call('skill_edit', { name: 'release-notes', text: texts[1], base: null }, human(bob)));
    await exchange(world);
    const shown = ok(await core.call('skill_show', { name: 'release-notes' }, human(ctx))).skills[0]!;
    const lower = shown.current!;
    const higher = shown.superseded[0]!.version!;
    expect(lower < higher).toBe(true);
    expect(await servedIn(core, bob)).toBe(lower);

    // Not a side of the fork: refused.
    expect(await core.call('skill_acknowledge', { name: 'release-notes', version: 'f'.repeat(64) }, human(ctx))).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { version: expect.stringContaining(higher) } } },
    });
    const acked = ok(await core.call('skill_acknowledge', { name: 'release-notes', version: higher }, human(ctx)));
    expect(acked).toMatchObject({ name: 'release-notes', version: higher, from: lower, superseded: [lower], settled: [] });
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('acknowledge');
    await pushTracker(world.a);
    await fetchTracker(world.b);

    for (const on of [ctx, bob]) {
      expect(await servedIn(core, on)).toBe(higher);
      const after = ok(await core.call('skill_show', { name: 'release-notes' }, human(on))).skills[0]!;
      expect(after).toMatchObject({ current: higher, superseded: [] });
      expect(after.history!.at(-1)).toMatchObject({ kind: 'acknowledge', version: higher, by: world.a.identity.email });
    }
    // Nothing left to acknowledge.
    expect(await core.call('skill_acknowledge', { name: 'release-notes', version: higher }, human(ctx))).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  test('a suspicious-contested accept is served nowhere until acknowledged; siding with the reject keeps the previous version and reads the proposal rejected', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    await share(world);
    const bob = agentContext(world.b);
    ok(await p.core.call('proposal_reject', { id: proposal, reason: 'suspicious', quarantine: false }, human(bob)));
    const accepted = ok(await p.core.call('proposal_accept', { id: proposal }, human(grimoire.ctx)));
    await exchange(world);
    expect(await servedIn(p.core, grimoire.ctx, SKILL)).toBe(p.base);
    const contested = ok(await p.core.call('skill_show', { name: SKILL }, human(grimoire.ctx))).skills[0]!;
    expect(contested.contested).toEqual([{ proposal, accepted: [accepted.version], rejected: ['suspicious'], withheld: true }]);

    const acked = ok(await p.core.call('skill_acknowledge', { name: SKILL, version: p.base }, human(bob)));
    expect(acked).toMatchObject({ version: p.base, settled: [proposal], superseded: [] });
    await exchange(world);
    for (const on of [grimoire.ctx, bob]) {
      expect(await servedIn(p.core, on, SKILL)).toBe(p.base);
      expect(ok(await p.core.call('skill_show', { name: SKILL }, human(on))).skills[0]).toMatchObject({ current: p.base, contested: [] });
      expect(ok(await p.core.call('proposal_show', { id: proposal }, human(on)))).toMatchObject({ status: 'rejected', decision: { kind: 'reject', reason: 'suspicious' } });
    }
  });

  test('a contest settled by edits stays accepted when a later fork is acknowledged to a version other than the accepted one', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    await share(world);
    const bob = agentContext(world.b);
    ok(await p.core.call('proposal_reject', { id: proposal, reason: 'too-vague' }, human(bob)));
    const accepted = ok(await p.core.call('proposal_accept', { id: proposal }, human(grimoire.ctx)));
    await exchange(world);
    expect(ok(await p.core.call('proposal_show', { id: proposal }, human(grimoire.ctx)))).toMatchObject({ status: 'contested' });

    // Each clone edits on: either edit settles the contest in the accept's favour, and the two fork.
    const text = `${SKILL_V1}${PORTS}`;
    ok(await p.core.call('skill_edit', { name: SKILL, text: `${text}${SEEDS}`, base: accepted.version }, human(grimoire.ctx)));
    ok(await p.core.call('skill_edit', { name: SKILL, text: `${text}${TIMEOUTS}`, base: accepted.version }, human(bob)));
    await exchange(world);
    expect(ok(await p.core.call('proposal_show', { id: proposal }, human(grimoire.ctx)))).toMatchObject({ status: 'accepted' });
    const forked = ok(await p.core.call('skill_show', { name: SKILL }, human(grimoire.ctx))).skills[0]!;
    const other = forked.superseded[0]!.version!;

    ok(await p.core.call('skill_acknowledge', { name: SKILL, version: other }, human(grimoire.ctx)));
    expect(ok(await p.core.call('proposal_show', { id: proposal }, human(grimoire.ctx)))).toMatchObject({ status: 'accepted', decision: { kind: 'accept' } });
  });

  test('every one of these ops from an agent surface gives HUMAN_ONLY', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const v1 = ok(await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, human(ctx))).version;
    const tip = await trackerTip(world.a);
    const marked: CallContext = { ...human(ctx), evidence: { agentMarkers: ['CLAUDECODE'] } };
    const calls: [string, Record<string, unknown>][] = [
      ['skill_restore', { name: 'release-notes', version: v1, base: v1 }],
      ['skill_delete', { name: 'release-notes', base: v1 }],
      ['skill_eject', { name: 'release-notes', base: v1 }],
      ['skill_acknowledge', { name: 'release-notes', version: v1 }],
      ['skill_unblock', { name: 'release-notes' }],
    ];
    for (const [op, input] of calls) {
      for (const on of [ctx, marked]) expect(await core.call(op, input, on), `${op} ${on.surface}`).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    }
    expect(await trackerTip(world.a)).toBe(tip);
  });
});
