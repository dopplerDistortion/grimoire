// Folds across two clones (spec §4, Read path and Fold rules): the merged view
// a read shows when the local and the remote-tracking tracker diverged, and the
// two-parent commit the next write makes of it.
import { rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect } from 'vitest';
import { openTracker } from '../../src/tracker';
import {
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  fetchTrackerFrom,
  issuePath,
  pushTracker,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
  type Grimoire,
} from './support';
import { createIssue, shared, bobPublishes, T1, sharedIssue, MAP, looseObjects } from './folds-support';

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

  test('store.fold() commits the fold on its own, with both tips as parents, and only when the tips diverged', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const store = await openTracker(world.a.dir);
    const fold = () => store.fold({ author: { ...world.a.identity }, actor: { kind: 'human', client: 'cli' } });
    const remoteTip = () => world.a.git(['rev-parse', 'refs/remotes/origin/grimoire/tracker']);
    try {
      const equal = await expectRefUnmoved(world.a, fold);
      await createIssue(core, alice, { title: 'Local work' });
      const localAhead = await expectRefUnmoved(world.a, fold);
      await pushTracker(world.a);
      await fetchTracker(world.b);
      await createIssue(core, bob, { title: 'Bob’s work' });
      await bobPublishes(world);
      // a's tracker is now behind the remote-tracking one: nothing to fold, and fold() leaves it behind.
      const remoteAhead = await expectRefUnmoved(world.a, fold);
      const behind = (await trackerTip(world.a))!;
      await world.a.git(['update-ref', TRACKER_REF, await remoteTip()]);
      await createIssue(core, alice, { title: 'More local work' });
      await createIssue(core, bob, { title: 'More of Bob’s work' });
      await bobPublishes(world);
      const [localTip, remote] = [(await trackerTip(world.a))!, await remoteTip()];
      const diverged = await fold();

      for (const nothing of [equal, localAhead, remoteAhead]) expect(nothing).toEqual({ commit: null });
      expect(behind).not.toBe(await remoteTip());
      expect(diverged.commit).toBe(await trackerTip(world.a));
      expect(await world.a.git(['rev-list', '--parents', '-n', '1', diverged.commit!])).toBe(`${diverged.commit} ${localTip} ${remote}`);
      const message = await world.a.git(['log', '-1', '--format=%B', diverged.commit!]);
      expect(message).toMatch(/^grimoire: fold\n/);
      expect(message).toMatch(/^Grimoire-Op: fold$/m);
      expect(await fold()).toEqual({ commit: null });
    } finally {
      await store.close();
    }
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

  test('a shallow tracker history hides the merge base: reads and writes give NOT_SYNCED instead of folding over nothing', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Shared', body: 'line\n' });
    await core.call('update', { id, title: 'Alice’s title' }, alice);
    await core.call('update', { id, labels_add: ['bob'] }, bob);
    await pushTracker(world.b);
    // a fetches Bob's tip alone: its parent, the merge base, stays out of the history a sees.
    await world.a.git([
      'fetch',
      '--quiet',
      '--depth',
      '1',
      pathToFileURL(world.remote).href,
      '+refs/heads/grimoire/tracker:refs/remotes/origin/grimoire/tracker',
    ]);
    expect(await world.a.git(['rev-parse', '--is-shallow-repository'])).toBe('true');

    const read = await core.call('show', { ref: id }, alice);
    const write = await expectRefUnmoved(world.a, () => core.call('comment', { id, body: 'fold' }, alice));

    for (const outcome of [read, write]) {
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'NOT_SYNCED', message: expect.stringContaining('shallow'), details: { remedy: expect.stringContaining('grimoire sync') } },
      });
    }
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

  test('one overlapping hunk sets only that hunk aside: the clean hunks of both sides, anchored inserts included, still merge', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    const id = await sharedIssue(world, core, alice, { title: 'Map', body: MAP });
    const alices = [
      { op: 'insert_before', anchor: '\n## Done\n', text: '- [ ] from alice\n' },
      { op: 'replace', anchor: '- [ ] first', text: '- [ ] first (alice)' },
    ];
    await core.call('update', { id, body_patch: alices }, alice);
    await bobCore.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [x] zero', text: '- [x] zero (bob)' }] }, bob);
    await bobCore.call('update', { id, body_patch: [{ op: 'replace', anchor: '- [ ] first', text: '- [x] first' }] }, bob);
    await bobPublishes(world);
    await fetchTrackerFrom(world.b, world.a);

    const seenByAlice = await core.call('show', { ref: id }, alice);
    const seenByBob = await bobCore.call('show', { ref: id }, bob);

    // Bob's change is the later one, so his side of the overlapping hunk stands.
    const merged = '# Map\n\n## Next\n- [x] first\n- [ ] second\n- [ ] from alice\n\n## Done\n- [x] zero (bob)\n';
    const conflict = {
      fields: ['body'],
      theirs: { body: '# Map\n\n## Next\n- [ ] first (alice)\n- [ ] second\n- [ ] from alice\n\n## Done\n- [x] zero\n' },
      base: { body: MAP },
    };
    expect(seenByAlice).toMatchObject({ ok: true, result: { body: merged, conflict } });
    expect(seenByBob).toMatchObject({ ok: true, result: { body: merged, conflict } });
  });
});
