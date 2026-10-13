// Seam 1: `activity` (spec §20, dashboard read ops): the tracker's writes,
// newest first, read from their commits' trailers: who (the person, plus
// client and session), which op, which issue and attempt, and for an update
// the fields it changed. The issue timeline reads it for one issue.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { bobPublishes, shared, sharedIssue } from './folds-support';
import { coreTest as test } from './support';
import { ok } from './sync-support';

const human = (ctx: CallContext): CallContext => ({ ...ctx, surface: 'dashboard', client: null, evidence: {} });

describe('activity', () => {
  test('lists one issue’s writes newest first, naming the person, client and session, and the fields an update changed', async ({ grimoire, world }) => {
    const { core, ctx } = grimoire;
    const created = await core.call('create', { title: 'One', labels: ['a'] }, ctx);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.result.id;
    const other = await core.call('create', { title: 'Other' }, ctx);
    if (!other.ok) throw new Error(JSON.stringify(other.error));
    expect((await core.call('update', { id, title: 'One, renamed', labels_add: ['b'] }, ctx)).ok).toBe(true);
    expect((await core.call('update', { id, body_patch: [{ op: 'append', text: 'More.' }] }, human(ctx))).ok).toBe(true);
    expect((await core.call('comment', { id, body: 'Looks good.' }, human(ctx))).ok).toBe(true);

    const read = await core.call('activity', { issue: id }, human(ctx));
    if (!read.ok) throw new Error(JSON.stringify(read.error));

    const email = world.a.identity.email;
    expect(read.result.cursor).toBeNull();
    expect(read.result.entries.map((entry) => [entry.op, entry.issue, entry.person, entry.fields ?? null])).toEqual([
      ['comment', id, email, null],
      ['update', id, email, ['body']],
      ['update', id, email, ['labels', 'title']],
      ['create', id, email, null],
    ]);
    expect(read.result.entries[0]!.actor).toMatchObject({ kind: 'human', client: 'dashboard' });
    expect(read.result.entries[2]!.actor).toMatchObject({ kind: 'agent', client: 'claude-code', session: 'sess-1' });
    expect(read.result.entries[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(read.result.entries[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('without an issue it lists every write, paged by limit and cursor', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    for (const title of ['A', 'B', 'C']) expect((await core.call('create', { title }, ctx)).ok).toBe(true);

    const first = await core.call('activity', { limit: 2 }, human(ctx));
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const rest = await core.call('activity', { limit: 2, cursor: first.result.cursor! }, human(ctx));
    if (!rest.ok) throw new Error(JSON.stringify(rest.error));

    expect(first.result.entries.map((entry) => entry.op)).toEqual(['create', 'create']);
    expect(first.result.cursor).not.toBeNull();
    // The third create, then the tracker's own init commit.
    expect(rest.result.entries.map((entry) => entry.op)).toEqual(['create', 'init']);
    expect(rest.result.cursor).toBeNull();
  });

  test('reads the fold of both tips, and credits a write made on a fold only with the fields it changed', async ({ grimoire, world }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared', labels: ['a'] });
    // Bob retitles on clone b and publishes it; a fetches: a's local and fetched tips diverge.
    await ok(core.call('update', { id, title: 'Bob’s title' }, bob));
    await bobPublishes(world);

    const before = await ok(core.call('activity', { issue: id }, human(alice)));
    // The view is the fold of both tips: Bob's write is in the feed before any write of a's folds it in.
    expect(before.entries.map((entry) => [entry.op, entry.person, entry.fields ?? null])).toEqual([
      ['update', world.b.identity.email, ['title']],
      ['create', world.a.identity.email, null],
    ]);

    // Alice's label update folds Bob's retitle in: she changed the labels, not the title.
    await ok(core.call('update', { id, labels_add: ['b'] }, alice));
    const after = await ok(core.call('activity', { issue: id }, human(alice)));
    expect(after.entries.map((entry) => [entry.op, entry.person, entry.fields ?? null])).toEqual([
      ['update', world.a.identity.email, ['labels']],
      ['update', world.b.identity.email, ['title']],
      ['create', world.a.identity.email, null],
    ]);
  });

  test('a write on a fold is compared with the folded parent state: both sides’ set adds are not its change', async ({ grimoire, world }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared', labels: ['a'] });
    // Alice adds y and doesn't publish; Bob adds x and publishes; a fetches.
    await ok(core.call('update', { id, labels_add: ['y'] }, alice));
    await ok(core.call('update', { id, labels_add: ['x'] }, bob));
    await bobPublishes(world);

    // The fold holds {a, x, y}: unlike either tip's labels, yet not the retitle's change.
    await ok(core.call('update', { id, title: 'Shared, retitled' }, alice));
    const read = await ok(core.call('activity', { issue: id }, human(alice)));
    expect(read.entries[0]).toMatchObject({ op: 'update', person: world.a.identity.email, fields: ['title'] });
  });

  test('a write on a fold to an issue only the other clone held names the fields it changed', async ({ grimoire, world }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    // a diverges with a write of its own; Bob creates an issue and publishes it.
    await ok(core.call('create', { title: 'Alice’s' }, alice));
    const created = await ok(core.call('create', { title: 'Bob’s', labels: ['a'] }, bob));
    await bobPublishes(world);

    await ok(core.call('update', { id: created.id, title: 'Bob’s, retitled' }, alice));
    const read = await ok(core.call('activity', { issue: created.id }, human(alice)));
    expect(read.entries[0]).toMatchObject({ op: 'update', person: world.a.identity.email, fields: ['title'] });
  });

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    const refused = await grimoire.core.call('activity', {}, grimoire.ctx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('HUMAN_ONLY');
  });
});
