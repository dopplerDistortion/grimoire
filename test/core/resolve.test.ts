// `resolve` (spec §3 Ids, §4 STATE_CONFLICT, §7): a human settles what a fold
// set aside, across two clones of one tracker.
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import type { GitWorld } from '#harness';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  fetchTrackerFrom,
  issuePath,
  pushTracker,
  suffixQueue,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
  type Grimoire,
} from './support';

const T1 = new Date(T0.getTime() + 60_000);

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

/** Both clones on one tracker: a pushes it, b fetches it. */
async function shared(world: GitWorld, grimoire: Grimoire): Promise<{ alice: CallContext; bob: CallContext }> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  return { alice: grimoire.ctx, bob: agentContext(world.b) };
}

/** b publishes its tracker and a fetches it: a's local and remote-tracking tips diverge. */
async function bobPublishes(world: GitWorld): Promise<void> {
  await pushTracker(world.b);
  await fetchTracker(world.a);
}

/** A human at an interactive terminal. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

function dashboard(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'dashboard', client: null, evidence: {} };
}

/** The two records of the gr-k1m0x collision, by whose each is. */
async function collisionSides(core: Core, ctx: CallContext): Promise<{ mine: string; theirs: string }> {
  const listed = await core.call('list', {}, ctx);
  const rows = listed.ok ? listed.result.rows : [];
  const find = (title: string) => rows.find((row) => row.title === title)?.id ?? `missing ${title}`;
  return { mine: find('Alice’s k1m0x'), theirs: find('Bob’s k1m0x') };
}

describe('resolving an id collision', () => {
  test('writes the forwarding record; the bare id then works for reads and writes, and the other record stays reachable', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'wa1t5') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    // Made before anyone knew of the collision: it names the bare id.
    const waiting = await createIssue(aliceCore, alice, { title: 'Waits', blocked_by: ['gr-k1m0x'] });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { core } = grimoire;
    const { mine, theirs } = await collisionSides(core, alice);
    expect(await core.call('show', { ref: waiting }, alice)).toMatchObject({
      ok: true,
      result: { blockers: [{ id: 'gr-k1m0x', title: null, status: 'unknown' }] },
    });

    const unnamed = await expectRefUnmoved(world.a, () => core.call('resolve', { id: 'gr-k1m0x' }, terminal(alice)));
    const resolved = await core.call('resolve', { id: 'gr-k1m0x', keep: mine }, terminal(alice));
    const shown = await core.call('show', { ref: 'gr-k1m0x' }, alice);
    const updated = await core.call('update', { id: 'gr-k1m0x', title: 'Alice’s, kept' }, alice);
    const claimed = await core.call('claim', { id: 'GR-K1M0X' }, alice);
    const commented = await core.call('comment', { id: 'gr-k1m0x', body: 'mine now' }, alice);
    const other = await core.call('show', { ref: theirs }, alice);

    expect(unnamed).toMatchObject({ ok: false, error: { code: 'INVALID', details: { candidates: [mine, theirs].sort() } } });
    expect(resolved).toEqual({ ok: true, result: { id: 'gr-k1m0x', forwarded_to: mine, others: [theirs] } });
    expect(shown).toMatchObject({ ok: true, result: { id: mine, title: 'Alice’s k1m0x' } });
    expect(updated).toMatchObject({ ok: true });
    expect(claimed).toMatchObject({ ok: true, result: { id: mine } });
    expect(commented).toMatchObject({ ok: true, result: { issue: mine } });
    expect(other).toMatchObject({ ok: true, result: { id: theirs, title: 'Bob’s k1m0x', open_attempts: [] } });
    expect(await core.call('show', { ref: 'gr-k1m' }, alice)).toMatchObject({ ok: true, result: { id: mine, title: 'Alice’s, kept' } });
    expect(await core.call('show', { ref: waiting }, alice)).toMatchObject({
      ok: true,
      result: { blockers: [{ id: 'gr-k1m0x', title: 'Alice’s, kept', status: 'open' }] },
    });
    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, 'forwards/gr-k1m0x.md')).toBe(
      `---\nto: "${mine}"\nby: "alice@example.com"\nat: "${T0.toISOString()}"\n---\n`,
    );

    // The other clone folds it in and agrees.
    await fetchTrackerFrom(world.b, world.a);
    expect(await bobCore.call('show', { ref: 'gr-k1m0x' }, bob)).toMatchObject({ ok: true, result: { id: mine, title: 'Alice’s, kept' } });
  });

  test('relations written under the bare id before the collision name the kept record: its children, claim, list and delete', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'k1d00', 'wa1t5') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    const kid = await createIssue(aliceCore, alice, { title: 'Kid', parent: 'gr-k1m0x' });
    const waiting = await createIssue(aliceCore, alice, { title: 'Waits', blocked_by: ['gr-k1m0x'] });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { core } = grimoire;
    const { mine } = await collisionSides(core, alice);
    expect(await core.call('resolve', { id: 'gr-k1m0x', keep: mine }, terminal(alice))).toMatchObject({ ok: true });

    const shown = await core.call('show', { ref: mine }, alice);
    const listed = await core.call('list', { parent: mine }, alice);
    const listedBare = await core.call('list', { parent: 'gr-k1m0x' }, alice);
    const [claimed, withKid] = await expectRefUnmoved(world.a, async () => [
      await core.call('claim', { id: mine }, alice),
      await core.call('delete', { id: mine }, terminal(alice)),
    ]);

    expect(shown).toMatchObject({ ok: true, result: { children: [{ id: kid, title: 'Kid', status: 'open' }], ready: false } });
    for (const outcome of [listed, listedBare]) expect(outcome).toMatchObject({ ok: true, result: { rows: [{ id: kid }], total: 1 } });
    expect(claimed).toMatchObject({ ok: false, error: { code: 'HAS_OPEN_CHILDREN' } });
    expect(withKid).toMatchObject({ ok: false, error: { code: 'INVALID', details: { sub_issues: [kid] } } });

    // With the kid moved away, the delete strips the bare id from Waits too.
    expect(await core.call('update', { id: kid, parent: null }, alice)).toMatchObject({ ok: true });
    const deleted = await core.call('delete', { id: 'gr-k1m0x' }, terminal(alice));

    expect(deleted).toEqual({ ok: true, result: { id: mine, deleted: true, blocked_by_stripped: [{ id: waiting, blocked_by: [] }] } });
    expect(await core.call('show', { ref: waiting }, alice)).toMatchObject({ ok: true, result: { blocked_by: [], ready: true } });
  });

  test('reopening the kept record lists what waits for it by the bare id; a blocker cycle through the bare id is refused', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('ep1c0', 'k1m0x', 'wa1t5') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Epic' });
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x', parent: 'gr-ep1c0' });
    const waiting = await createIssue(aliceCore, alice, { title: 'Waits', blocked_by: ['gr-k1m0x'] });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { core } = grimoire;
    const { mine } = await collisionSides(core, alice);
    await core.call('resolve', { id: 'gr-k1m0x', keep: mine }, terminal(alice));

    const cycle = await expectRefUnmoved(world.a, () => core.call('update', { id: mine, blocked_by_add: [waiting] }, alice));
    await core.call('close', { id: mine, reason: 'done' }, terminal(alice));
    const reopened = await core.call('reopen', { id: mine, comment: 'Not done.' }, terminal(alice));

    expect(cycle).toMatchObject({ ok: false, error: { code: 'CYCLE' } });
    expect(reopened).toMatchObject({
      ok: true,
      result: {
        reblocked: [
          { id: waiting, title: 'Waits', via: 'blocked_by' },
          { id: 'gr-ep1c0', title: 'Epic', via: 'parent' },
        ],
      },
    });
  });

  test('blocker deltas match a blocker by the record it names: the bare id and the kept record’s id are one blocker', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'wa1t5', 'n3xt5') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    // Stores the bare id: made before anyone knew of the collision.
    const waiting = await createIssue(aliceCore, alice, { title: 'Waits', blocked_by: ['gr-k1m0x'] });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { core } = grimoire;
    const { mine } = await collisionSides(core, alice);
    await core.call('resolve', { id: 'gr-k1m0x', keep: mine }, terminal(alice));
    // Stores the kept record's id.
    const later = await createIssue(aliceCore, alice, { title: 'Later', blocked_by: [mine] });
    const blockersOf = async (id: string) => {
      const shown = await core.call('show', { ref: id }, alice);
      return shown.ok ? shown.result.blocked_by : shown.error;
    };

    const both = await expectRefUnmoved(world.a, () =>
      core.call('update', { id: waiting, blocked_by_add: [mine], blocked_by_remove: ['gr-k1m0x'] }, alice),
    );
    const addKept = await expectRefUnmoved(world.a, () => core.call('update', { id: waiting, blocked_by_add: [mine] }, alice));
    const addBare = await expectRefUnmoved(world.a, () => core.call('update', { id: later, blocked_by_add: ['gr-k1m0x'] }, alice));
    expect(both).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { 'blocked_by_remove[0]': expect.any(String) } } } });
    expect(addKept).toMatchObject({ ok: true, result: { noops: [{ field: 'blocked_by_add[0]', reason: 'already set' }] } });
    expect(addBare).toMatchObject({ ok: true, result: { noops: [{ field: 'blocked_by_add[0]', reason: 'already set' }] } });
    expect(await blockersOf(waiting)).toEqual(['gr-k1m0x']);
    expect(await blockersOf(later)).toEqual([mine]);

    const removeKept = await core.call('update', { id: waiting, blocked_by_remove: [mine] }, alice);
    const removeBare = await core.call('update', { id: later, blocked_by_remove: ['gr-k1m0x'] }, alice);
    expect(removeKept).toMatchObject({ ok: true, result: { noops: [] } });
    expect(removeBare).toMatchObject({ ok: true, result: { noops: [] } });
    expect(await blockersOf(waiting)).toEqual([]);
    expect(await blockersOf(later)).toEqual([]);
  });

  test('once the kept record is deleted, the bare id answers “deleted” and never falls to the other record', async ({ world, grimoire }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { core } = grimoire;
    const { mine, theirs } = await collisionSides(core, alice);
    await core.call('resolve', { id: 'gr-k1m0x', keep: mine }, terminal(alice));
    expect(await core.call('delete', { id: mine }, terminal(alice))).toMatchObject({ ok: true });

    const shown = await core.call('show', { ref: 'gr-k1m0x' }, alice);
    const linked = await core.call('show', { ref: 'see gr-k1m0x' }, alice);
    const write = await expectRefUnmoved(world.a, () => core.call('comment', { id: 'gr-k1m0x', body: 'whose?' }, alice));

    for (const outcome of [shown, linked, write]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND', message: expect.stringContaining('was deleted'), details: { deleted: { by: 'alice@example.com' } } },
      });
    }
    // The other record is still there under its own id, and a prefix still finds it.
    expect(await core.call('show', { ref: theirs }, alice)).toMatchObject({ ok: true, result: { title: 'Bob’s k1m0x' } });
    expect(await core.call('show', { ref: 'gr-k1m' }, alice)).toMatchObject({ ok: true, result: { id: theirs } });
  });

  test('keep may name the record by its hash4 alone; a bare id with no collision is refused', async ({ world, grimoire }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'solo1') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const solo = await createIssue(aliceCore, alice, { title: 'Alone' });
    const { core } = grimoire;
    const { theirs } = await collisionSides(core, alice);

    const notCollided = await expectRefUnmoved(world.a, () => core.call('resolve', { id: solo, keep: 'abcd' }, dashboard(alice)));
    const strange = await expectRefUnmoved(world.a, () => core.call('resolve', { id: 'gr-k1m0x', keep: 'ffff' }, dashboard(alice)));
    const resolved = await core.call('resolve', { id: 'gr-k1m0x', keep: theirs.slice(-4) }, dashboard(alice));

    expect(notCollided).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(strange).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { keep: expect.any(String) } } } });
    expect(resolved).toMatchObject({ ok: true, result: { forwarded_to: theirs } });
    expect(await core.call('show', { ref: 'gr-k1m0x' }, alice)).toMatchObject({ ok: true, result: { title: 'Bob’s k1m0x' } });
  });
});

describe('resolving a field conflict', () => {
  test('the human picks the value that stands; the conflict clears and the issue is claimable again', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Shared' });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await core.call('update', { id, title: 'Alice’s title' }, alice);
    await bobCore.call('update', { id, title: 'Bob’s title' }, bob);
    await bobPublishes(world);
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({
      ok: true,
      result: { title: 'Bob’s title', ready: false, conflict: { fields: ['title'], theirs: { title: 'Alice’s title' } } },
    });

    const unpicked = await expectRefUnmoved(world.a, () => core.call('resolve', { id }, dashboard(alice)));
    const stray = await expectRefUnmoved(world.a, () => core.call('resolve', { id, fields: { body: 'theirs' }, take: 'kept' }, dashboard(alice)));
    const resolved = await core.call('resolve', { id, fields: { title: 'theirs' } }, dashboard(alice));
    const shown = await core.call('show', { ref: id }, alice);
    const claimed = await core.call('claim', { id }, alice);

    expect(unpicked).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { take: expect.any(String) } } } });
    expect(stray).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { 'fields.body': 'is not in conflict' } } } });
    expect(resolved).toEqual({ ok: true, result: { id, resolved: [{ field: 'title', took: 'theirs' }] } });
    expect(shown).toMatchObject({ ok: true, result: { title: 'Alice’s title', conflict: null, ready: true } });
    expect(claimed).toMatchObject({ ok: true });
    const tip = (await trackerTip(world.a))!;
    const tree = await world.a.git(['ls-tree', '-r', '--name-only', tip]);
    expect(tree).not.toContain(`${id}/conflicts/`);
  });

  test('keeping the value that stands just clears the conflict; an issue with none is refused', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Shared', body: 'one\n' });
    const calm = await createIssue(core, alice, { title: 'Calm' });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await core.call('update', { id, title: 'Alice’s title', body_patch: [{ op: 'replace', anchor: 'one', text: 'uno' }] }, alice);
    await bobCore.call('update', { id, title: 'Bob’s title', body_patch: [{ op: 'replace', anchor: 'one', text: 'eins' }] }, bob);
    await bobPublishes(world);

    const none = await expectRefUnmoved(world.a, () => core.call('resolve', { id: calm, take: 'kept' }, terminal(alice)));
    const resolved = await core.call('resolve', { id, take: 'kept' }, terminal(alice));

    expect(none).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(resolved).toMatchObject({
      ok: true,
      result: { resolved: [{ field: 'body', took: 'kept' }, { field: 'title', took: 'kept' }] },
    });
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({
      ok: true,
      result: { title: 'Bob’s title', body: 'eins\n', conflict: null, ready: true },
    });
  });

  test('a delete against an edit: keeping the issue clears it; taking the delete deletes it, with a delete’s rules', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const kept = await createIssue(core, alice, { title: 'Kept' });
    const gone = await createIssue(core, alice, { title: 'Gone' });
    const dependent = await createIssue(core, alice, { title: 'Dependent', blocked_by: [gone] });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const tombstone = '---\nby: "bob@example.com"\nat: "2026-10-11T04:00:00.000Z"\n---\n';
    await commitToTracker(world.b, {
      [issuePath(kept)]: null,
      [`deleted/${kept}.md`]: tombstone,
      [issuePath(gone)]: null,
      [`deleted/${gone}.md`]: tombstone,
    });
    await core.call('update', { id: kept, title: 'Kept, edited' }, alice);
    await core.call('update', { id: gone, title: 'Gone, edited' }, alice);
    await bobPublishes(world);
    for (const id of [kept, gone]) {
      expect(await core.call('show', { ref: id }, alice)).toMatchObject({ ok: true, result: { conflict: { fields: ['deleted'] } } });
    }

    const keep = await core.call('resolve', { id: kept, fields: { deleted: 'kept' } }, terminal(alice));
    const take = await core.call('resolve', { id: gone, take: 'theirs' }, terminal(alice));

    expect(keep).toMatchObject({ ok: true, result: { resolved: [{ field: 'deleted', took: 'kept' }] } });
    expect(await core.call('show', { ref: kept }, alice)).toMatchObject({ ok: true, result: { title: 'Kept, edited', conflict: null, ready: true } });
    expect(take).toMatchObject({
      ok: true,
      result: { id: gone, deleted: true, blocked_by_stripped: [{ id: dependent, blocked_by: [] }] },
    });
    expect(await core.call('show', { ref: gone }, alice)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { deleted: {} } } });
  });
});
