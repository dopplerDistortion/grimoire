// Folds across two clones (spec §4, Read path and Fold rules): the merged view
// a read shows when the local and the remote-tracking tracker diverged, and the
// two-parent commit the next write makes of it.
import { readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
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
import type { GitWorld } from '#harness';

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

describe('the merged view', () => {
  test('a read shows both diverged tips merged, and the next write commits that merge with both tips as parents', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const fromAlice = await createIssue(core, alice, { title: 'From Alice' });
    const fromBob = await createIssue(core, bob, { title: 'From Bob' });
    await bobPublishes(world);
    const aliceTip = (await trackerTip(world.a))!;
    const bobTip = await world.a.git(['rev-parse', 'refs/remotes/origin/grimoire/tracker']);

    const listed = await core.call('list', {}, alice);
    const written = await createIssue(core, alice, { title: 'After the fold' });

    expect(listed.ok && listed.result.rows.map((row) => row.id).sort()).toEqual([fromAlice, fromBob].sort());
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${aliceTip} ${bobTip}`);
    const after = await core.call('list', {}, alice);
    expect(after.ok && after.result.rows.map((row) => row.id).sort()).toEqual([fromAlice, fromBob, written].sort());
    expect(await world.a.git(['ls-tree', '-r', '--name-only', tip])).toContain(`${fromBob}/issue.md`);
  });

  test('folds of folds (criss-cross merge bases) fold over a recursive virtual base', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    await core.call('update', { id, labels_add: ['from-alice'] }, alice);
    await bobCore.call('update', { id, labels_add: ['from-bob'] }, bob);
    // Each clone folds the other's tip on its own: two fold commits with the same two parents.
    await fetchTrackerFrom(world.a, world.b);
    await fetchTrackerFrom(world.b, world.a);
    await core.call('comment', { id, body: 'a folds' }, alice);
    await bobCore.call('comment', { id, body: 'b folds' }, bob);
    // Then each drops the other's label (only the virtual base holds both), and b retitles.
    await core.call('update', { id, labels_remove: ['from-bob'] }, alice);
    await bobCore.call('update', { id, title: 'Bob’s title', labels_remove: ['from-alice'] }, bob);
    await fetchTrackerFrom(world.a, world.b);
    const bases = await world.a.git(['merge-base', '--all', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);

    const shown = await core.call('show', { ref: id }, alice);

    expect(bases.split('\n')).toHaveLength(2);
    expect(shown).toMatchObject({
      ok: true,
      result: { title: 'Bob’s title', labels: [], comment_count: 2, conflict: null },
    });
  });

  test('reads of a fold create no git objects and never touch the network', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Shared', labels: ['base'] });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await core.call('update', { id, labels_add: ['alice'], title: 'Alice’s title' }, alice);
    await core.call('update', { id, labels_add: ['bob'], body_patch: [{ op: 'append', text: 'From Bob\n' }] }, bob);
    await bobPublishes(world);
    // The remote is gone: any read that needed the network would fail.
    await rename(world.remote, `${world.remote}.gone`);
    const objectsBefore = await looseObjects(world.a.dir);

    const shown = await core.call('show', { ref: id }, alice);
    const listed = await core.call('list', {}, alice);
    const labels = await core.call('labels', {}, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: { title: 'Alice’s title', labels: ['alice', 'base', 'bob'], body: 'From Bob\n' },
    });
    expect(listed).toMatchObject({ ok: true, result: { total: 1 } });
    expect(labels).toMatchObject({ ok: true });
    expect(await looseObjects(world.a.dir)).toEqual(objectsBefore);
  });
});

/** A minute after T0: Bob's clock in tests where his change is the later one. */
const T1 = new Date(T0.getTime() + 60_000);

/** An issue both clones hold: created and published by a, fetched by b. */
async function sharedIssue(world: GitWorld, core: Core, alice: CallContext, input: Record<string, unknown>): Promise<string> {
  const id = await createIssue(core, alice, input);
  await pushTracker(world.a);
  await fetchTracker(world.b);
  return id;
}

describe('field conflicts', () => {
  test('both clones changed the title: the later change stands, the other is set aside, and show and list carry the conflict', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    await core.call('update', { id, title: 'Alice’s title', labels_add: ['alice'] }, alice);
    await bobCore.call('update', { id, title: 'Bob’s title' }, bob);
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    const conflicts = await core.call('list', { view: 'conflicts' }, alice);
    const ready = await core.call('list', { ready: true }, alice);

    const conflict = { fields: ['title'], theirs: { title: 'Alice’s title' }, base: { title: 'Shared' } };
    expect(shown).toMatchObject({
      ok: true,
      result: { title: 'Bob’s title', labels: ['alice'], updated_at: T1.toISOString(), ready: false, conflict },
    });
    expect(conflicts).toMatchObject({ ok: true, result: { rows: [{ id, conflict }] } });
    expect(ready).toMatchObject({ ok: true, result: { rows: [] } });
  });

  test('a conflict record is written once, under the issue, by the write that commits the fold', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    await core.call('update', { id, title: 'Alice’s title' }, alice);
    await bobCore.call('update', { id, title: 'Bob’s title' }, bob);
    await bobPublishes(world);

    await core.call('comment', { id, body: 'Seen it' }, alice);

    const tip = (await trackerTip(world.a))!;
    const names = (await world.a.git(['ls-tree', '--name-only', `${tip}:${issuePath(id).replace(/issue\.md$/, 'conflicts')}`])).split('\n');
    expect(names).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.md$/)]);
    const record = await trackerFile(world.a, tip, `${issuePath(id).replace(/issue\.md$/, 'conflicts')}/${names[0]}`);
    expect(record).toBe(
      [
        '---',
        'fields: ["title"]',
        'kept: {"title":"Bob’s title"}',
        'theirs: {"title":"Alice’s title"}',
        'base: {"title":"Shared"}',
        `at: "${T0.toISOString()}"`,
        '---',
        '',
      ].join('\n'),
    );
  });
});

const MAP = '# Map\n\n## Next\n- [ ] first\n- [ ] second\n\n## Done\n- [x] zero\n';

describe('body folds', () => {
  test('concurrent anchored inserts at the same map anchor both survive, in the same order on both clones', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Map', body: MAP });
    const insert = (text: string) => [{ op: 'insert_before', anchor: '\n## Done\n', text }];
    await core.call('update', { id, body_patch: insert('- [ ] from bob\n') }, bob);
    await core.call('update', { id, body_patch: insert('- [ ] from alice\n') }, alice);
    await bobPublishes(world);
    await fetchTrackerFrom(world.b, world.a);

    const seenByAlice = await core.call('show', { ref: id }, alice);
    const seenByBob = await core.call('show', { ref: id }, bob);

    const merged = '# Map\n\n## Next\n- [ ] first\n- [ ] second\n- [ ] from alice\n- [ ] from bob\n\n## Done\n- [x] zero\n';
    expect(seenByAlice).toMatchObject({ ok: true, result: { body: merged, conflict: null } });
    expect(seenByBob).toMatchObject({ ok: true, result: { body: merged, conflict: null } });
  });

  test('edits to different lines merge, and lines both deleted are deleted once', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Map', body: MAP });
    await core.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [ ] second\n', text: '' }, { op: 'replace', anchor: '# Map', text: '# The map' }] }, alice);
    await core.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [ ] second\n', text: '' }, { op: 'replace', anchor: '- [x] zero', text: '- [x] zero (done)' }] }, bob);
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: { body: '# The map\n\n## Next\n- [ ] first\n\n## Done\n- [x] zero (done)\n', conflict: null },
    });
  });

  test('overlapping edits of the same text: the later body stands and the other is set aside as a body conflict', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Map', body: MAP });
    await core.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [ ] first', text: '- [ ] first (alice)' }] }, alice);
    await bobCore.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [ ] first', text: '- [x] first' }] }, bob);
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: {
        body: MAP.replace('- [ ] first', '- [x] first'),
        conflict: {
          fields: ['body'],
          theirs: { body: MAP.replace('- [ ] first', '- [ ] first (alice)') },
          base: { body: MAP },
        },
      },
    });
  });
});

const DEBRIEF = { asked: 'a', tried: 'b', failed: 'none', worked: 'c', next: 'none' };

/** Both clones retitle the shared issue; Bob's change is later, so Alice's is set aside. */
async function titleConflict(world: GitWorld, grimoire: Grimoire, alice: CallContext, bob: CallContext, id: string) {
  const bobCore = grimoire.makeCore({ clock: () => T1 });
  await grimoire.core.call('update', { id, title: 'Alice’s title' }, alice);
  await bobCore.call('update', { id, title: 'Bob’s title' }, bob);
  await bobPublishes(world);
}

describe('STATE_CONFLICT', () => {
  test('a field conflict fails a claim, a write to that field and a full-body replace; comments, anchored patches and other fields work', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared', body: 'Body\n' });
    await titleConflict(world, grimoire, alice, bob, id);
    const shown = await core.call('show', { ref: id }, alice);
    const revision = shown.ok ? shown.result.revision : '';

    const claim = await expectRefUnmoved(world.a, () => core.call('claim', { id }, alice));
    const retitle = await expectRefUnmoved(world.a, () => core.call('update', { id, title: 'Mine' }, alice));
    const replace = await expectRefUnmoved(world.a, () =>
      core.call('update', { id, body: 'All new\n', if_revision: revision }, alice),
    );
    const comment = await core.call('comment', { id, body: 'Still works' }, alice);
    const patch = await core.call('update', { id, body_patch: [{ op: 'append', text: 'More\n' }], labels_add: ['x'] }, alice);

    const conflict = { fields: ['title'], theirs: { title: 'Alice’s title' }, base: { title: 'Shared' } };
    for (const refused of [claim, retitle, replace]) {
      expect(refused).toEqual({
        ok: false,
        error: { code: 'STATE_CONFLICT', message: expect.stringContaining('title'), retryable: false, details: { conflict } },
      });
    }
    expect(comment).toMatchObject({ ok: true });
    expect(patch).toMatchObject({ ok: true });
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({
      ok: true,
      result: { title: 'Bob’s title', body: 'Body\nMore\n', labels: ['x'], comment_count: 1, conflict },
    });
  });

  test('closing your own handle on a still-open, conflicted issue closes it with outcome pass, and its parent_patch lands on a conflicted parent', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const parent = await createIssue(core, alice, { title: 'Map', body: '## Done\n' });
    const id = await createIssue(core, alice, { title: 'Shared', parent });
    const claimed = await core.call('claim', { id }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await titleConflict(world, grimoire, alice, bob, id);
    await titleConflict(world, grimoire, alice, bob, parent);

    const closed = await core.call(
      'close',
      { id, reason: 'done', attempt, debrief: DEBRIEF, parent_patch: [{ op: 'append', text: `- ${id}\n` }] },
      alice,
    );

    expect(closed).toEqual({ ok: true, result: { id, attempt, ended: 'done', outcome: 'pass' } });
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({
      ok: true,
      result: { status: 'done', conflict: { fields: ['title'] } },
    });
    expect(await core.call('show', { ref: parent }, alice)).toMatchObject({
      ok: true,
      result: { body: `## Done\n- ${id}\n`, conflict: { fields: ['title'] } },
    });
  });

  test('two clones closing one issue differently leave a status conflict; an unclaimed close of a title-conflicted issue works', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    const other = await sharedIssue(world, core, alice, { title: 'Other' });
    await core.call('close', { id, reason: 'canceled' }, { ...alice, surface: 'cli' });
    await bobCore.call('close', { id, reason: 'done', debrief: DEBRIEF }, bob);
    await core.call('update', { id: other, title: 'Alice’s' }, alice);
    await bobCore.call('update', { id: other, title: 'Bob’s' }, bob);
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    const closeOther = await core.call('close', { id: other, reason: 'canceled' }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: { status: 'done', conflict: { fields: ['status'], theirs: { status: 'canceled' }, base: { status: 'open' } } },
    });
    expect(closeOther).toMatchObject({ ok: true, result: { ended: 'canceled', outcome: 'none' } });
  });
});

describe('attempts across clones', () => {
  test('claims on both clones leave two open attempts: show lists both, a claim gives ALREADY_CLAIMED with both, and ready excludes the issue', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Contested' });
    const mine = await core.call('claim', { id }, alice);
    const theirs = await bobCore.call('claim', { id }, bob);
    await bobPublishes(world);
    const [aliceHandle, bobHandle] = [mine.ok ? mine.result.attempt : '', theirs.ok ? theirs.result.attempt : ''];

    const shown = await core.call('show', { ref: id }, alice);
    const claim = await expectRefUnmoved(world.a, () => core.call('claim', { id }, { ...alice, nonce: 'nonce-2' }));
    const ready = await core.call('list', { ready: true }, alice);

    const open = [
      { attempt: aliceHandle, assignee: 'alice@example.com', since: T0.toISOString(), held_by_you: true },
      { attempt: bobHandle, assignee: 'bob@example.com', since: T1.toISOString(), held_by_you: false },
    ];
    expect(shown).toMatchObject({
      ok: true,
      result: {
        open_attempts: open,
        ready: false,
        conflict: { fields: ['open_attempts'], theirs: { open_attempts: [aliceHandle, bobHandle] }, base: { open_attempts: [] } },
      },
    });
    expect(claim).toMatchObject({ ok: false, error: { code: 'ALREADY_CLAIMED', details: { open_attempts: open } } });
    expect(ready).toMatchObject({ ok: true, result: { rows: [] } });
  });

  test('closing your own handle after the other clone closed the issue seals it superseded, with outcome none', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Raced' });
    const claimed = await core.call('claim', { id }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    await core.call('close', { id, reason: 'canceled' }, { ...bob, surface: 'cli' });
    await bobPublishes(world);

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);

    expect(closed).toEqual({ ok: true, result: { id, attempt, ended: 'superseded', outcome: 'none' } });
    expect(await core.call('show', { ref: id }, alice)).toMatchObject({
      ok: true,
      result: {
        status: 'canceled',
        open_attempts: [],
        past_attempts: expect.arrayContaining([
          expect.objectContaining({ ended: 'canceled', opened: 'unclaimed-close' }),
          expect.objectContaining({ attempt, ended: 'superseded', outcome: expect.objectContaining({ verdict: 'none' }) }),
        ]),
      },
    });
  });

  test('closing your own handle after the other clone deleted the issue seals it superseded, debrief kept with the attempt', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Doomed' });
    const claimed = await core.call('claim', { id }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    // A human on b deletes it (the delete op's commit: the issue directory goes, a tombstone stays).
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    await commitToTracker(world.b, {
      [issuePath(id)]: null,
      [`deleted/${id}.md`]: '---\nby: "bob@example.com"\nat: "2026-10-11T03:20:00.000Z"\n---\n',
    });
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);
    const replayed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);

    expect(shown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(closed).toEqual({ ok: true, result: { id, attempt, ended: 'superseded', outcome: 'none' } });
    expect(replayed).toEqual({ ok: true, result: { id, attempt, ended: 'superseded', outcome: 'none', replayed: true } });
    const tip = (await trackerTip(world.a))!;
    const tree = await world.a.git(['ls-tree', '-r', '--name-only', tip]);
    expect(tree).not.toContain(`issues/${id[3]}/${id[4]}/${id}/`);
    const dir = `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;
    expect(await trackerFile(world.a, tip, `${dir}/end.md`)).toMatch(/^ended: "superseded"$/m);
    const activity = tree.split('\n').filter((file) => file.startsWith(`${dir}/activity/`));
    expect(activity).toHaveLength(1);
    expect(await trackerFile(world.a, tip, activity[0]!)).toMatch(/^kind: "debrief"$/m);
  });
});

describe('ends and outcomes', () => {
  test('one attempt ended on both clones: done beats a release, the other end is kept and the attempt shows the conflict', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Ended twice' });
    const claimed = await core.call('claim', { id }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);
    // A human on b recovers what looks like a dead claim.
    const humanBob = { ...bob, surface: 'cli' as const };
    expect(await bobCore.call('release', { id, attempt, abandoned: true }, humanBob)).toMatchObject({ ok: true });
    await bobPublishes(world);
    await fetchTrackerFrom(world.b, world.a);

    const seenByAlice = await core.call('show', { ref: id }, alice);
    const seenByBob = await core.call('show', { ref: id }, bob);

    const past = {
      attempt,
      ended: 'done',
      ended_by: 'alice@example.com',
      // Both outcomes are grimoire's: the later one stands.
      outcome: { verdict: 'fail', reason: 'release-abandoned', set_by: 'grimoire', at: T1.toISOString() },
      conflict: {
        fields: ['end'],
        theirs: { end: [{ ended: 'release-abandoned', ended_at: T1.toISOString(), ended_by: 'bob@example.com' }] },
        base: { end: null },
      },
    };
    expect(seenByAlice).toMatchObject({ ok: true, result: { status: 'done', past_attempts: [past] } });
    expect(seenByBob).toMatchObject({ ok: true, result: { status: 'done', past_attempts: [past] } });
  });

  test('a human’s outcome beats grimoire’s in a fold, however late grimoire’s is', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Judged' });
    const claimed = await core.call('claim', { id }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, alice);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const outcome = `outcomes/${id[3]}/${id[4]}/${id}/${attempt}.md`;
    await commitToTracker(world.b, {
      [outcome]: '---\nverdict: "fail"\nreason: "tests were skipped"\nset_by: "human:bob@example.com"\nat: "2026-01-01T00:00:00.000Z"\n---\n',
    });
    await commitToTracker(world.a, {
      [outcome]: '---\nverdict: "pass"\nreason: "done"\nset_by: "grimoire"\nat: "2027-01-01T00:00:00.000Z"\n---\n',
    });
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: { past_attempts: [{ attempt, outcome: { verdict: 'fail', set_by: 'human:bob@example.com' }, conflict: null }] },
    });
  });
});

/** Lets b write raw commits: its local tracker starts where the fetched one is. */
async function bobTracksRemote(world: GitWorld): Promise<void> {
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

describe('what this release doesn’t understand', () => {
  test('unknown frontmatter keys and unknown files written by a newer release survive folds and rewrites', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    await commitToTracker(world.a, { 'future/shared.json': '{"v":0}\n', 'future/both.json': '{"v":0}\n' });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await bobTracksRemote(world);
    const shown = await core.call('show', { ref: id }, alice);
    const record = await trackerFile(world.b, (await trackerTip(world.b))!, issuePath(id));
    // b runs a newer release: it adds a frontmatter key and files of its own.
    await commitToTracker(world.b, {
      [issuePath(id)]: record.replace('---\n\n', '').replace(/\n---\n$/, '\npriority: "high"\n---\n'),
      [issuePath(id).replace('issue.md', 'estimate.json')]: '{"points":3}\n',
      'future/shared.json': '{"v":1}\n',
      'future/both.json': '{"v":"bob"}\n',
      'future/index.json': '{"kind":"new"}\n',
    });
    await core.call('update', { id, title: 'Alice’s title' }, alice);
    await commitToTracker(world.a, { 'future/shared.json': null, 'future/both.json': '{"v":"alice"}\n' });
    await bobPublishes(world);

    await core.call('comment', { id, body: 'Fold it' }, alice);
    await core.call('update', { id, labels_add: ['rewritten'] }, alice);

    expect(shown.ok).toBe(true);
    const tip = (await trackerTip(world.a))!;
    const issue = await trackerFile(world.a, tip, issuePath(id));
    expect(issue).toMatch(/^title: "Alice’s title"$/m);
    expect(issue).toMatch(/^labels: \["rewritten"\]$/m);
    expect(issue).toMatch(/\npriority: "high"\n---\n$/);
    expect(await trackerFile(world.a, tip, issuePath(id).replace('issue.md', 'estimate.json'))).toBe('{"points":3}\n');
    expect(await trackerFile(world.a, tip, 'future/index.json')).toBe('{"kind":"new"}\n');
    // A modification beats a delete; when both changed a file, the lower blob hash wins.
    expect(await trackerFile(world.a, tip, 'future/shared.json')).toBe('{"v":1}\n');
    const [aliceBlob, bobBlob] = await Promise.all(
      ['{"v":"alice"}\n', '{"v":"bob"}\n'].map((text) => world.a.git(['hash-object', '--stdin'], { input: text })),
    );
    expect(await trackerFile(world.a, tip, 'future/both.json')).toBe(aliceBlob! < bobBlob! ? '{"v":"alice"}\n' : '{"v":"bob"}\n');
  });

  test('the format marker folds to the field-by-field maximum', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    await bobTracksRemote(world);
    await commitToTracker(world.b, { format: 'format: 3\ncompat: 1\nrequires: "1.0.0"\nwiki: 2\n' });
    await commitToTracker(world.a, { format: 'format: 2\ncompat: 1\nrequires: "1.2.0"\nskills: 4\n' });
    await bobPublishes(world);

    await createIssue(core, alice, { title: 'After the fold' });

    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, 'format')).toBe('format: 3\ncompat: 1\nrequires: "1.2.0"\nskills: 4\nwiki: 2\n');
  });

  test('a remote whose compat is newer than this release gives UPGRADE_REQUIRED for reads and writes, and nothing is folded', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    await bobTracksRemote(world);
    await commitToTracker(world.b, { format: 'format: 2\ncompat: 2\nrequires: "2.0.0"\n' });
    await createIssue(core, alice, { title: 'Local work' });
    await bobPublishes(world);

    const read = await core.call('list', {}, alice);
    const write = await expectRefUnmoved(world.a, () => core.call('create', { title: 'More' }, alice));

    for (const outcome of [read, write]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'UPGRADE_REQUIRED', details: { marker: 'store', why: 'newer', requires: '2.0.0' } },
      });
    }
  });
});

const setting = (value: unknown, at: string, by: string) => JSON.stringify({ value, at, by });

describe('settings, deletes and purges', () => {
  test('store settings fold per key, the later change winning', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Linked' });
    await commitToTracker(world.a, {
      'settings.yml': `link_base: ${setting('https://old.example/', '2026-10-01T00:00:00.000Z', 'carol@example.com')}\n`,
    });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await bobTracksRemote(world);
    await commitToTracker(world.a, {
      'settings.yml': [
        `auto-sync: ${setting(false, '2026-10-11T01:00:00.000Z', 'alice@example.com')}`,
        `link_base: ${setting('https://alice.example/', '2026-10-11T05:00:00.000Z', 'alice@example.com')}`,
        '',
      ].join('\n'),
    });
    await commitToTracker(world.b, {
      'settings.yml': [
        `link_base: ${setting('https://bob.example/', '2026-10-11T04:00:00.000Z', 'bob@example.com')}`,
        `excerpts: ${setting('facts', '2026-10-11T02:00:00.000Z', 'bob@example.com')}`,
        '',
      ].join('\n'),
    });
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    await core.call('comment', { id, body: 'fold' }, alice);

    expect(shown).toMatchObject({ ok: true, result: { link: `https://alice.example/${issuePath(id)}` } });
    expect(await trackerFile(world.a, (await trackerTip(world.a))!, 'settings.yml')).toBe(
      [
        `auto-sync: ${setting(false, '2026-10-11T01:00:00.000Z', 'alice@example.com')}`,
        `excerpts: ${setting('facts', '2026-10-11T02:00:00.000Z', 'bob@example.com')}`,
        `link_base: ${setting('https://alice.example/', '2026-10-11T05:00:00.000Z', 'alice@example.com')}`,
        '',
      ].join('\n'),
    );
  });

  test('a delete against an edit made after the base keeps the issue with a conflict record, and drops the tombstone', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared' });
    await bobTracksRemote(world);
    const tombstone = '---\nby: "bob@example.com"\nat: "2026-10-11T04:00:00.000Z"\n---\n';
    await commitToTracker(world.b, { [issuePath(id)]: null, [`deleted/${id}.md`]: tombstone });
    await core.call('update', { id, title: 'Still wanted' }, alice);
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    const claim = await core.call('claim', { id }, alice);
    await core.call('comment', { id, body: 'fold' }, alice);

    expect(shown).toMatchObject({
      ok: true,
      result: {
        title: 'Still wanted',
        conflict: {
          fields: ['deleted'],
          theirs: { deleted: { by: 'bob@example.com', at: '2026-10-11T04:00:00.000Z' } },
          base: { deleted: false },
        },
      },
    });
    expect(claim).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } });
    const tree = await world.a.git(['ls-tree', '-r', '--name-only', (await trackerTip(world.a))!]);
    expect(tree).not.toContain(`deleted/${id}.md`);
  });

  test('a delete stands against a side that changed only files this release doesn’t know in the issue', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Doomed' });
    await bobTracksRemote(world);
    await commitToTracker(world.b, { [issuePath(id)]: null, [`deleted/${id}.md`]: '---\nby: "bob@example.com"\n---\n' });
    await commitToTracker(world.a, { [issuePath(id).replace('issue.md', 'estimate.json')]: '{"points":5}\n' });
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    await createIssue(core, alice, { title: 'fold' });

    expect(shown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const tree = await world.a.git(['ls-tree', '-r', '--name-only', (await trackerTip(world.a))!]);
    expect(tree).not.toContain(`/${id}/`);
    expect(tree).toContain(`deleted/${id}.md`);
  });

  test('a purge tombstone dominates the fold: late records and outcome changes from the other clone can’t recreate the attempt', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Traced' });
    const purged = await core.call('claim', { id }, alice);
    const attempt = purged.ok ? purged.result.attempt : '';
    await core.call('release', { id, attempt, debrief: DEBRIEF }, alice);
    const kept = await core.call('claim', { id }, alice);
    const open = kept.ok ? kept.result.attempt : '';
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await bobTracksRemote(world);
    const dir = `attempts/${id[3]}/${id[4]}/${id}`;
    const outcome = `outcomes/${id[3]}/${id[4]}/${id}/${attempt}.md`;
    const files = (await world.b.git(['ls-tree', '-r', '--name-only', 'refs/remotes/origin/grimoire/tracker', `${dir}/${attempt}`])).split('\n');
    // b purges the ended attempt (the purge op's commit), and one session record of the open one.
    await commitToTracker(world.b, {
      ...Object.fromEntries(files.map((file) => [file, null])),
      [outcome]: null,
      [`purges/${attempt}.md`]: '---\nby: "bob@example.com"\nat: "2026-10-11T04:00:00.000Z"\nreason: "secret"\n---\n',
      [`purges/${open}/sk1.md`]: '---\nby: "bob@example.com"\n---\n',
    });
    // a still holds them: a late session record, a human outcome override, and a newer cut of the purged session record.
    await commitToTracker(world.a, {
      [`${dir}/${attempt}/sessions/sk9.md`]: '---\nreach: {"at":"2026-10-11T03:30:00.000Z","n":7}\n---\n',
      [outcome]: '---\nverdict: "pass"\nreason: "override"\nset_by: "human:alice@example.com"\nat: "2026-10-11T05:00:00.000Z"\n---\n',
      [`${dir}/${open}/sessions/sk1.md`]: '---\nreach: {"at":"2026-10-11T03:40:00.000Z","n":9}\n---\n',
    });
    await bobPublishes(world);

    const shown = await core.call('show', { ref: id }, alice);
    await core.call('comment', { id, body: 'fold' }, alice);

    expect(shown).toMatchObject({ ok: true, result: { past_attempts: [], open_attempts: [{ attempt: open }] } });
    const tree = await world.a.git(['ls-tree', '-r', '--name-only', (await trackerTip(world.a))!]);
    expect(tree).not.toContain(`/${attempt}/`);
    expect(tree.split('\n')).not.toContain(outcome);
    expect(tree.split('\n')).not.toContain(`${dir}/${open}/sessions/sk1.md`);
    expect(tree.split('\n')).toContain(`purges/${attempt}.md`);
  });
});

describe('id collisions', () => {
  test('one id minted on both clones: both records are kept as <id>~<hash4>, and the bare id gives AMBIGUOUS_REF for reads and writes', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    expect(await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' })).toBe('gr-k1m0x');
    expect(await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' })).toBe('gr-k1m0x');
    await bobPublishes(world);
    const core = grimoire.core;

    const listed = await core.call('list', {}, alice);
    const show = await core.call('show', { ref: 'gr-k1m0x' }, alice);
    const update = await expectRefUnmoved(world.a, () => core.call('update', { id: 'gr-k1m0x', title: 'Which?' }, alice));
    const claim = await expectRefUnmoved(world.a, () => core.call('claim', { id: 'gr-k1m0x' }, alice));

    const rows = listed.ok ? listed.result.rows : [];
    expect(rows.map((row) => row.id)).toEqual([expect.stringMatching(/^gr-k1m0x~[0-9a-f]{4}$/), expect.stringMatching(/^gr-k1m0x~[0-9a-f]{4}$/)]);
    const byTitle = new Map(rows.map((row) => [row.title, row.id]));
    const [mine, theirs] = [byTitle.get('Alice’s k1m0x')!, byTitle.get('Bob’s k1m0x')!];
    expect(mine).not.toBe(theirs);
    const candidates = [mine, theirs].sort();
    for (const refused of [show, update, claim]) {
      expect(refused).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_REF', details: { candidates } } });
    }
    expect(await core.call('show', { ref: theirs }, alice)).toMatchObject({ ok: true, result: { id: theirs, title: 'Bob’s k1m0x' } });
    expect(await core.call('update', { id: mine, title: 'Alice’s, renamed' }, alice)).toMatchObject({ ok: true });
    const tip = (await trackerTip(world.a))!;
    const tree = (await world.a.git(['ls-tree', '-r', '--name-only', tip])).split('\n');
    expect(tree).toEqual(expect.arrayContaining([`issues/k/1/${mine}/issue.md`, `issues/k/1/${theirs}/issue.md`]));
    expect(tree).not.toContain('issues/k/1/gr-k1m0x/issue.md');
    // The record keeps its minted id inside; only its directory carries the suffix.
    expect(await trackerFile(world.a, tip, `issues/k/1/${mine}/issue.md`)).toMatch(/^id: "gr-k1m0x"$/m);
  });

  test('a clone that kept working on its side of a collision lands on the right record when it folds the renamed one', async ({
    world,
    grimoire,
  }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    const bobsClaim = await bobCore.call('claim', { id: 'gr-k1m0x' }, bob);
    await bobPublishes(world);
    // a folds the collision and publishes the fold; b, meanwhile, keeps editing its bare record.
    await aliceCore.call('comment', { id: (await renamedIds(aliceCore, alice)).alice, body: 'fold' }, alice);
    await bobCore.call('update', { id: 'gr-k1m0x', labels_add: ['bob-later'] }, bob);
    await fetchTrackerFrom(world.b, world.a);

    const ids = await renamedIds(bobCore, bob);
    const shown = await bobCore.call('show', { ref: ids.bob }, bob);
    const other = await bobCore.call('show', { ref: ids.alice }, bob);

    expect(shown).toMatchObject({
      ok: true,
      result: {
        title: 'Bob’s k1m0x',
        labels: ['bob-later'],
        open_attempts: [{ attempt: bobsClaim.ok ? bobsClaim.result.attempt : '' }],
        conflict: null,
      },
    });
    expect(other).toMatchObject({ ok: true, result: { title: 'Alice’s k1m0x', labels: [], open_attempts: [] } });
  });
});

/** The two sides of the gr-k1m0x collision, by whose record each is. */
async function renamedIds(core: Core, ctx: CallContext): Promise<{ alice: string; bob: string }> {
  const listed = await core.call('list', {}, ctx);
  const rows = listed.ok ? listed.result.rows : [];
  const find = (title: string) => rows.find((row) => row.title === title)?.id ?? `missing ${title}`;
  return { alice: find('Alice’s k1m0x'), bob: find('Bob’s k1m0x') };
}

/** Every object file in the clone's object database (loose objects and packs). */
async function looseObjects(dir: string): Promise<string[]> {
  const root = path.join(dir, '.git', 'objects');
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  return files
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}
