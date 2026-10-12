// Folds across two clones (spec §4, Fold rules), continued from folds.test.ts:
// issue states, attempts, and their ends and outcomes.
import { describe, expect } from 'vitest';
import {
  commitToTracker,
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
} from './support';
import { createIssue, shared, bobPublishes, T1, sharedIssue, DEBRIEF, titleConflict, bobTracksRemote } from './folds-support';

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
    // A human on b releases what looks like a stale claim as abandoned.
    const humanBob = { ...bob, surface: 'cli' as const, tty: true };
    expect(await bobCore.call('release', { id, attempt, abandoned: true }, humanBob)).toMatchObject({ ok: true });
    await bobPublishes(world);
    await fetchTrackerFrom(world.b, world.a);

    const seenByAlice = await core.call('show', { ref: id }, alice);
    const seenByBob = await core.call('show', { ref: id }, bob);

    const past = {
      attempt,
      ended: 'done',
      ended_by: 'alice@example.com',
      // Both outcomes are grimoire's, each derived from its own end: the one of the end that stood stands with it.
      outcome: { verdict: 'pass', reason: 'done', set_by: 'grimoire', at: T0.toISOString() },
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

  test('a session record cut on both clones: the further reach stands on both, by time, then by a Codex ordinal', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const { alice, bob } = await shared(world, grimoire);
    const id = await createIssue(core, alice, { title: 'Traced' });
    const claimed = await core.call('claim', { id }, alice);
    const sessions = `attempts/${id[3]}/${id[4]}/${id}/${claimed.ok ? claimed.result.attempt : ''}/sessions`;
    // Reach as capture records it (spec §14): the last step's time and its ref, a Claude line uuid or a Codex ordinal.
    const cut = (at: string, ref: string, text: string) =>
      `---\nreach: ${JSON.stringify({ at: `2026-10-11T${at}.000Z`, ref })}\n---\n${text}\n`;
    await commitToTracker(world.a, {
      [`${sessions}/claude1.md`]: cut('03:30:00', '6f1c2d4e-0000-4000-8000-000000000001', 'base'),
      [`${sessions}/codex1.md`]: cut('03:30:00', '7', 'base'),
    });
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await bobTracksRemote(world);
    await commitToTracker(world.a, {
      [`${sessions}/claude1.md`]: cut('03:40:00', '6f1c2d4e-0000-4000-8000-00000000000a', 'alice reaches later'),
      [`${sessions}/codex1.md`]: cut('03:45:00', '11', 'alice: ordinal 11'),
    });
    await commitToTracker(world.b, {
      [`${sessions}/claude1.md`]: cut('03:35:00', '6f1c2d4e-0000-4000-8000-00000000000b', 'bob reaches earlier'),
      [`${sessions}/codex1.md`]: cut('03:45:00', '12', 'bob: ordinal 12'),
    });
    await bobPublishes(world);
    await fetchTrackerFrom(world.b, world.a);

    await core.call('comment', { id, body: 'a folds' }, alice);
    await core.call('comment', { id, body: 'b folds' }, bob);

    for (const clone of [world.a, world.b]) {
      const tip = (await trackerTip(clone))!;
      expect(await trackerFile(clone, tip, `${sessions}/claude1.md`)).toBe(
        cut('03:40:00', '6f1c2d4e-0000-4000-8000-00000000000a', 'alice reaches later'),
      );
      expect(await trackerFile(clone, tip, `${sessions}/codex1.md`)).toBe(cut('03:45:00', '12', 'bob: ordinal 12'));
    }
  });
});
