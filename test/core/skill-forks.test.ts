// Skill forks across clones (spec §18 Forks across clones; ADR 0010): two
// clones change one evolved skill apart, and the merged view decides what is
// current from the ledger alone, never by the clock and never by merging text.
// Decisions the dashboard will make (accept, reject, restore, delete,
// acknowledge) are written here through the knowledge engine's change writer,
// the one every decision op uses.
import { createHash } from 'node:crypto';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { writeSkillChange, type SkillChange } from '../../src/knowledge';
import { bundledRules, createScanner } from '../../src/scanner';
import { openTracker } from '../../src/tracker';
import type { Clone, GitWorld } from '#harness';
import { agentContext, coreTest as test, fetchTracker, fetchTrackerFrom, pushTracker, TRACKER_REF } from './support';

const scanner = createScanner(bundledRules);

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function notes(line: string): string {
  return `---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\n${line}\n`;
}

/** Records one decision or change in `checkout`'s tracker, as a human in the dashboard. */
async function decide(clone: Clone, change: SkillChange): Promise<string> {
  const store = await openTracker(clone.dir);
  try {
    const author = { name: clone.identity.name, email: clone.identity.email };
    const write = await store.transact({ op: change.kind, author, actor: { kind: 'human', client: 'dashboard', nonce: 'n' } }, async (draft) => {
      const written = await writeSkillChange(draft, scanner, change, {
        actor: { kind: 'human', client: 'dashboard', nonce: 'n' },
        by: clone.identity.email,
        surface: 'dashboard',
        clone: clone.identity.email.startsWith('alice') ? 'c10e00000000000a' : 'c10e00000000000b',
      });
      return { result: written.record };
    });
    return write.result;
  } finally {
    await store.close();
  }
}

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

async function served(core: Core, ctx: CallContext, name = 'release-notes') {
  const [read, listed] = await Promise.all([core.call('skill_read', { name }, ctx), core.call('skill_list', {}, ctx)]);
  return {
    version: read.ok ? read.result.version : read.error.code,
    listed: listed.ok ? listed.result.skills.map((skill) => skill.name) : [],
  };
}

/** What both clones serve after the fold: they must agree. */
async function servedOnBoth(core: Core, world: GitWorld, name = 'release-notes') {
  const [onA, onB] = [await served(core, agentContext(world.a), name), await served(core, agentContext(world.b), name)];
  expect(onB).toEqual(onA);
  return onA;
}

const BASE = notes('Create `changes/<slug>.md`.');

/** v1 of release-notes, made in clone a and shared with b. */
async function sharedSkill(world: GitWorld, core: Core, ctx: CallContext): Promise<string> {
  const created = await core.call('skill_edit', { name: 'release-notes', text: BASE, base: null }, terminal(ctx));
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  await share(world);
  return created.result.version;
}

describe('skill forks across two clones', () => {
  test('two accepts from one base fold so that the lower version hash serves, and the other is superseded', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);
    const fromAlice = notes('Create `changes/<slug>.md` with a `kind:` line.');
    const fromBob = notes('Create `changes/<slug>.md` with a `summary:` line.');
    const [lower, higher] = [fromAlice, fromBob].sort((x, y) => (versionOf(x) < versionOf(y) ? -1 : 1));

    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-alice', text: fromAlice });
    await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-bob', text: fromBob });
    await exchange(world);

    expect(await servedOnBoth(core, world)).toEqual({ version: versionOf(lower!), listed: ['release-notes'] });
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));
    expect(shown).toMatchObject({
      ok: true,
      result: {
        skills: [
          {
            name: 'release-notes',
            status: 'active',
            current: versionOf(lower!),
            served: versionOf(lower!),
            superseded: [{ kind: 'accept', version: versionOf(higher!) }],
          },
        ],
      },
    });
  });

  test('two creates of one name on two clones: the lower version hash serves', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await share(world);
    const bob = agentContext(world.b);
    const fromAlice = notes('Alice’s way.');
    const fromBob = notes('Bob’s way.');

    await core.call('skill_edit', { name: 'release-notes', text: fromAlice, base: null }, terminal(ctx));
    await core.call('skill_edit', { name: 'release-notes', text: fromBob, base: null }, terminal(bob));
    await exchange(world);

    const lower = [versionOf(fromAlice), versionOf(fromBob)].sort()[0];
    expect(await servedOnBoth(core, world)).toEqual({ version: lower, listed: ['release-notes'] });
  });

  test('a human edit after the fork settles it: the skill continues from the edit on every clone', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);
    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('One.') });
    await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-2', text: notes('Two.') });
    await exchange(world);
    const standing = (await served(core, ctx)).version;

    const settled = await core.call('skill_edit', { name: 'release-notes', text: notes('Both.'), base: standing }, terminal(ctx));
    await pushTracker(world.a);
    await fetchTracker(world.b);

    expect(settled).toMatchObject({ ok: true, result: { from: standing, version: versionOf(notes('Both.')) } });
    expect(await servedOnBoth(core, world)).toEqual({ version: versionOf(notes('Both.')), listed: ['release-notes'] });
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));
    expect(shown).toMatchObject({ ok: true, result: { skills: [{ superseded: [] }] } });
  });

  test('a delete on one side beats a restore on the other', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const v1 = await sharedSkill(world, core, ctx);
    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('Two.') });
    await share(world);

    await decide(world.a, { kind: 'delete', skill: 'release-notes', to: null });
    await decide(world.b, { kind: 'restore', skill: 'release-notes', to: v1 });
    await exchange(world);

    expect(await servedOnBoth(core, world)).toEqual({ version: 'NOT_FOUND', listed: [] });
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));
    expect(shown).toMatchObject({ ok: true, result: { skills: [{ status: 'deleted', served: null, blocked: true }] } });
  });

  test('a delete on one side beats an accept on the other, and the deleted name stays blocked', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);

    await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('Two.') });
    await decide(world.a, { kind: 'delete', skill: 'release-notes', to: null });
    await exchange(world);
    const recreate = await core.call('skill_edit', { name: 'release-notes', text: notes('Again.'), base: null }, terminal(ctx));

    expect(await servedOnBoth(core, world)).toEqual({ version: 'NOT_FOUND', listed: [] });
    expect(recreate).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('blocked') } } } });
  });

  test('lifting a deleted name’s block lets a human create it again, continuing its ledger', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);
    await decide(world.a, { kind: 'delete', skill: 'release-notes', to: null });
    await decide(world.a, { kind: 'unblock', skill: 'release-notes', to: null });

    const recreated = await core.call('skill_edit', { name: 'release-notes', text: notes('Fresh.'), base: null }, terminal(ctx));
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));

    expect(recreated).toMatchObject({ ok: true, result: { from: null, created: true } });
    expect(await served(core, ctx)).toEqual({ version: versionOf(notes('Fresh.')), listed: ['release-notes'] });
    expect(shown).toMatchObject({
      ok: true,
      result: { skills: [{ status: 'active', blocked: false, history: [{ kind: 'edit' }, { kind: 'delete' }, { kind: 'unblock' }, { kind: 'edit' }] }] },
    });
  });

  test('a current version failing the content checks (conflict markers, a secret) is served nowhere; the previous one keeps serving', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const v1 = await sharedSkill(world, core, ctx);
    const marked = notes('<<<<<<< ours\nOne.\n=======\nTwo.\n>>>>>>> theirs');
    const leaky = notes(`export GITHUB_TOKEN=ghp_${'Z9y8X7w6V5u4'.repeat(3)}`);

    await decide(world.a, { kind: 'record', skill: 'release-notes', text: marked });
    const afterMarkers = await served(core, ctx);
    await decide(world.a, { kind: 'record', skill: 'release-notes', text: leaky });
    const afterSecret = await served(core, ctx);
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));

    expect(afterMarkers).toEqual({ version: v1, listed: ['release-notes'] });
    expect(afterSecret).toEqual({ version: v1, listed: ['release-notes'] });
    expect(shown).toMatchObject({ ok: true, result: { skills: [{ current: versionOf(leaky), served: v1 }] } });
  });

  test('a restore on one side beats an accept on the other', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const v1 = await sharedSkill(world, core, ctx);
    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('Two.') });
    await share(world);

    await decide(world.a, { kind: 'restore', skill: 'release-notes', to: v1 });
    await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-2', text: notes('Three.') });
    await exchange(world);

    expect(await servedOnBoth(core, world)).toEqual({ version: v1, listed: ['release-notes'] });
  });

  test('an accept against a suspicious reject of the same proposal is served nowhere, and the previous version keeps serving', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const v1 = await sharedSkill(world, core, ctx);
    const accepted = notes('Pipe the installer from the URL into sh.');

    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: accepted });
    await decide(world.b, { kind: 'reject', skill: 'release-notes', proposal: 'pr-1', reason: 'suspicious' });
    await exchange(world);

    expect(await servedOnBoth(core, world)).toEqual({ version: v1, listed: ['release-notes'] });
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));
    expect(shown).toMatchObject({
      ok: true,
      result: {
        skills: [
          {
            current: versionOf(accepted),
            served: v1,
            contested: [{ proposal: 'pr-1', accepted: [versionOf(accepted)], rejected: ['suspicious'], withheld: true }],
          },
        ],
      },
    });
  });

  test('a suspicious-contested create is served nowhere at all until a human acknowledges it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await share(world);
    const created = notes('A new skill.');

    const acceptId = await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: created });
    const rejectId = await decide(world.b, { kind: 'reject', skill: 'release-notes', proposal: 'pr-1', reason: 'suspicious' });
    await exchange(world);
    const before = await servedOnBoth(core, world);
    await decide(world.a, { kind: 'acknowledge', skill: 'release-notes', to: versionOf(created) });
    await pushTracker(world.a);
    await fetchTracker(world.b);

    expect([acceptId, rejectId]).toHaveLength(2);
    expect(before).toEqual({ version: 'NOT_FOUND', listed: [] });
    expect(await servedOnBoth(core, world)).toEqual({ version: versionOf(created), listed: ['release-notes'] });
  });

  test('an accept against a reject for another reason is contested but served as accepted', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);
    const accepted = notes('Two.');

    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: accepted });
    await decide(world.b, { kind: 'reject', skill: 'release-notes', proposal: 'pr-1', reason: 'too-vague' });
    await exchange(world);

    expect(await servedOnBoth(core, world)).toEqual({ version: versionOf(accepted), listed: ['release-notes'] });
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));
    expect(shown).toMatchObject({ ok: true, result: { skills: [{ contested: [{ proposal: 'pr-1', withheld: false }] }] } });
  });

  test('every current version shows its provenance: a local decision or another clone, with actor and tracker commit', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await share(world);
    const bob = terminal(agentContext(world.b));

    await core.call('skill_edit', { name: 'release-notes', text: BASE, base: null }, terminal(ctx));
    const aliceTip = await world.a.git(['rev-parse', TRACKER_REF]);
    await core.call('skill_edit', { name: 'flaky-tests', text: BASE.replace(/release-notes/g, 'flaky-tests'), base: null }, bob);
    const bobTip = await world.b.git(['rev-parse', TRACKER_REF]);
    await pushTracker(world.b);
    await fetchTracker(world.a);
    const diverged = await core.call('skill_show', {}, terminal(ctx));
    // An edit made on the folded view: its commit is the two-parent one that also commits the fold.
    await core.call('skill_edit', { name: 'release-notes', text: notes('Again.'), base: versionOf(BASE) }, terminal(ctx));
    const foldTip = await world.a.git(['rev-parse', TRACKER_REF]);
    const after = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));

    expect(diverged).toMatchObject({
      ok: true,
      result: {
        skills: [
          { name: 'flaky-tests', provenance: { origin: 'other-clone', kind: 'edit', by: 'bob@example.com', commit: bobTip } },
          {
            name: 'release-notes',
            provenance: {
              origin: 'local',
              kind: 'edit',
              by: 'alice@example.com',
              actor: { kind: 'human', client: 'cli', nonce: 'nonce-1' },
              commit: aliceTip,
            },
          },
        ],
        active: 2,
        cap: 8,
        delivery: 'on',
      },
    });
    expect((await world.a.git(['rev-list', '--parents', '-n', '1', foldTip])).split(' ')).toHaveLength(3);
    expect(after).toMatchObject({
      ok: true,
      result: {
        skills: [
          {
            name: 'release-notes',
            provenance: { origin: 'local', commit: foldTip },
            text: notes('Again.'),
            history: [
              { kind: 'edit', from: null, version: versionOf(BASE), origin: 'local' },
              { kind: 'edit', from: versionOf(BASE), version: versionOf(notes('Again.')), origin: 'local' },
            ],
          },
        ],
      },
    });
  });

  test('the next write commits the fold, and the ledger is the union of both clones’ records', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await sharedSkill(world, core, ctx);
    const a1 = await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('One.') });
    const b1 = await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-2', text: notes('Two.') });
    await fetchTrackerFrom(world.a, world.b);

    await core.call('create', { title: 'Anything' }, ctx);

    const tip = await world.a.git(['rev-parse', TRACKER_REF]);
    expect((await world.a.git(['rev-list', '--parents', '-n', '1', tip])).split(' ')).toHaveLength(3);
    const ledger = (await world.a.git(['ls-tree', '--name-only', `${tip}:knowledge/ledger`])).split('\n');
    expect(ledger).toEqual(expect.arrayContaining([`${a1}.md`, `${b1}.md`]));
    expect(ledger).toHaveLength(3);
    const versions = (await world.a.git(['ls-tree', '--name-only', `${tip}:knowledge/skill-versions`])).split('\n');
    expect(versions).toEqual(expect.arrayContaining([`${versionOf(notes('One.'))}.md`, `${versionOf(notes('Two.'))}.md`]));
  });
});
