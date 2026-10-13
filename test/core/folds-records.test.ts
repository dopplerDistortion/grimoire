// Folds across two clones (spec §4, Fold rules), continued from folds.test.ts:
// what a newer release wrote, store settings, deletes and purges, and id collisions.
import { describe, expect } from 'vitest';
import {
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  fetchTrackerFrom,
  issuePath,
  pushTracker,
  suffixQueue,
  trackerFile,
  trackerTip,
} from './support';
import { createIssue, shared, bobPublishes, T1, sharedIssue, DEBRIEF, bobTracksRemote, setting, renamedIds } from './folds-support';

describe('what this release doesn’t understand', () => {
  // Writes, folds and syncs across two clones: room beyond the default 60 s when the parallel suite loads the machine.
  test('unknown frontmatter keys and unknown files written by a newer release survive folds and rewrites', { timeout: 180_000 }, async ({
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
      [`${dir}/${attempt}/sessions/sk9.md`]: '---\nreach: {"at":"2026-10-11T03:30:00.000Z","ref":"7"}\n---\n',
      [outcome]: '---\nverdict: "pass"\nreason: "override"\nset_by: "human:alice@example.com"\nat: "2026-10-11T05:00:00.000Z"\n---\n',
      [`${dir}/${open}/sessions/sk1.md`]: '---\nreach: {"at":"2026-10-11T03:40:00.000Z","ref":"9"}\n---\n',
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
    const link = `https://forge.example/o/r/blob/grimoire/tracker/issues/k/1/${theirs}/issue.md`;
    expect(await core.call('show', { ref: link }, alice)).toMatchObject({ ok: true, result: { id: theirs } });
    expect(await core.call('update', { id: mine, title: 'Alice’s, renamed' }, alice)).toMatchObject({ ok: true });
    const tip = (await trackerTip(world.a))!;
    const tree = (await world.a.git(['ls-tree', '-r', '--name-only', tip])).split('\n');
    expect(tree).toEqual(expect.arrayContaining([`issues/k/1/${mine}/issue.md`, `issues/k/1/${theirs}/issue.md`]));
    expect(tree).not.toContain('issues/k/1/gr-k1m0x/issue.md');
    // The record keeps its minted id inside; only its directory carries the suffix.
    expect(await trackerFile(world.a, tip, `issues/k/1/${mine}/issue.md`)).toMatch(/^id: "gr-k1m0x"$/m);
  });

  test('once only one side of a collision is left, writes by the bare id land on it, as reads do', async ({ world, grimoire }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'c4ndy') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x'), clock: () => T1 });
    const { alice, bob } = await shared(world, grimoire);
    await createIssue(aliceCore, alice, { title: 'Alice’s k1m0x' });
    await createIssue(bobCore, bob, { title: 'Bob’s k1m0x' });
    await bobPublishes(world);
    const { alice: mine, bob: theirs } = await renamedIds(aliceCore, alice);
    // The fold commits, then Bob's side goes (a delete's commit: the directory goes, a tombstone stays).
    await aliceCore.call('comment', { id: mine, body: 'fold' }, alice);
    const tip = (await trackerTip(world.a))!;
    const files = (await world.a.git(['ls-tree', '-r', '--name-only', tip, `issues/k/1/${theirs}`])).split('\n');
    await commitToTracker(world.a, {
      ...Object.fromEntries(files.map((file) => [file, null])),
      [`deleted/${theirs}.md`]: '---\nby: "alice@example.com"\n---\n',
    });

    const shown = await aliceCore.call('show', { ref: 'gr-k1m0x' }, alice);
    const updated = await aliceCore.call('update', { id: 'gr-k1m0x', title: 'Alice’s, renamed' }, alice);
    const claimed = await aliceCore.call('claim', { id: 'gr-k1m0x' }, alice);
    const attempt = claimed.ok ? claimed.result.attempt : '';
    const commented = await aliceCore.call('comment', { id: 'gr-k1m0x', body: 'Working on it' }, alice);
    const closed = await aliceCore.call('close', { id: 'gr-k1m0x', reason: 'done', attempt, debrief: DEBRIEF }, alice);
    const child = await createIssue(aliceCore, alice, { title: 'Child', parent: 'gr-k1m0x', blocked_by: ['gr-k1m0x'] });

    expect(shown).toMatchObject({ ok: true, result: { id: mine } });
    expect(updated).toMatchObject({ ok: true });
    expect(claimed).toMatchObject({ ok: true, result: { id: mine } });
    expect(commented).toMatchObject({ ok: true, result: { issue: mine } });
    expect(closed).toEqual({ ok: true, result: { id: mine, attempt, ended: 'done', outcome: 'pass' } });
    expect(await aliceCore.call('show', { ref: mine }, alice)).toMatchObject({
      ok: true,
      result: { title: 'Alice’s, renamed', status: 'done', comment_count: 3 },
    });
    const shownChild = await aliceCore.call('show', { ref: child }, alice);
    expect(shownChild).toMatchObject({ ok: true, result: { parent: mine, blocked_by: [mine] } });
  });

  test('a clone that kept working on its side of a collision lands on the right record when it folds the renamed one, and its own handle still ends by the bare id', async ({
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
    const handle = bobsClaim.ok ? bobsClaim.result.attempt : '';
    // Bob claimed by the bare id before the collision was found: that is the id he knows.
    const released = await bobCore.call('release', { id: 'gr-k1m0x', attempt: handle, debrief: DEBRIEF }, bob);

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
    expect(released).toEqual({ ok: true, result: { id: ids.bob, attempt: handle, ended: 'release', outcome: 'fail' } });
    expect(await bobCore.call('show', { ref: ids.bob }, bob)).toMatchObject({ ok: true, result: { open_attempts: [], status: 'open' } });
  });
});
