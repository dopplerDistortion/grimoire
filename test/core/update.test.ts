import { describe, expect } from 'vitest';
import type { Core, CallContext } from '../../src/core';
import { commitToTracker, coreTest as test, expectRefUnmoved, issuePath, trackerFile, trackerTip } from './support';

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

async function revisionOf(core: Core, ctx: CallContext, id: string): Promise<string> {
  const shown = await core.call('show', { ref: id }, ctx);
  if (!shown.ok) throw new Error(`show failed: ${JSON.stringify(shown.error)}`);
  return shown.result.revision;
}

describe('update', () => {
  test('a title change is one commit that rewrites the record and returns the new revision', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Old title', body: 'Body\n' });
    const before = await trackerTip(world.a);
    const oldRevision = await revisionOf(core, ctx, id);

    const updated = await core.call('update', { id, title: 'New title' }, ctx);

    const newRevision = await revisionOf(core, ctx, id);
    expect(updated).toEqual({ ok: true, result: { revision: newRevision, noops: [] } });
    expect(newRevision).not.toBe(oldRevision);
    const after = await trackerTip(world.a);
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', after!])).toBe(`${after} ${before}`);
    expect(await world.a.git(['log', '-1', '--format=%B', after!])).toMatch(
      new RegExp(`^grimoire: update ${id}\\n\\n[^]*Grimoire-Op: update\\nGrimoire-Issue: ${id}\\n`),
    );
    expect(await trackerFile(world.a, after!, issuePath(id))).toMatch(/^title: "New title"$/m);
  });

  test('unknown frontmatter keys a later release wrote survive an update', async ({ world, grimoire }) => {
    await commitToTracker(world.a, {
      [issuePath('gr-fe7a0')]: [
        '---',
        'id: "gr-fe7a0"',
        'seq: 1',
        'title: "From the future"',
        'status: "open"',
        'labels: []',
        'parent: null',
        'blocked_by: []',
        'links: []',
        'created_at: "2026-01-01T00:00:00.000Z"',
        'created_by: "carol@example.com"',
        'updated_at: "2026-01-01T00:00:00.000Z"',
        'estimate: 3',
        '---',
        'Body\n',
      ].join('\n'),
    });

    const updated = await grimoire.core.call('update', { id: 'gr-fe7a0', labels_add: ['bug'] }, grimoire.ctx);

    expect(updated).toMatchObject({ ok: true });
    const record = await trackerFile(world.a, (await trackerTip(world.a))!, issuePath('gr-fe7a0'));
    expect(record).toMatch(/^estimate: 3$/m);
    expect(record).toMatch(/^labels: \["bug"\]$/m);
    expect(record).toMatch(/^updated_at: "2026-10-11T03:15:08.750Z"$/m);
  });

  test('an update that changes nothing writes no commit and reports every no-op', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Same', labels: ['bug'] });
    const before = await trackerTip(world.a);

    const updated = await core.call(
      'update',
      { id, title: 'Same', labels_add: ['bug'], labels_remove: ['wontfix'] },
      ctx,
    );

    expect(updated).toEqual({
      ok: true,
      result: {
        revision: await revisionOf(core, ctx, id),
        noops: [
          { field: 'title', reason: 'unchanged' },
          { field: 'labels_add[0]', reason: 'already set' },
          { field: 'labels_remove[0]', reason: 'not set' },
        ],
      },
    });
    expect(await trackerTip(world.a)).toBe(before);
  });

  test('a full-body replace needs if_revision: without it INVALID, with a stale one REVISION_CONFLICT', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Spec', body: 'v1\n' });
    const stale = await revisionOf(core, ctx, id);
    await core.call('update', { id, title: 'Spec, renamed' }, ctx);
    const current = await revisionOf(core, ctx, id);

    const missing = await expectRefUnmoved(world.a, () => core.call('update', { id, body: 'v2\n' }, ctx));
    const conflicted = await expectRefUnmoved(world.a, () =>
      core.call('update', { id, body: 'v2\n', if_revision: stale }, ctx),
    );

    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'INVALID', retryable: false, details: { fields: { if_revision: expect.any(String) } } },
    });
    expect(conflicted).toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: expect.any(String), retryable: false, details: { revision: current } },
    });
  });

  test('a full-body replace with the current revision stores the new body byte for byte', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Spec', body: 'v1\n' });
    const body = 'v2\r\n\twith tabs  \n\n';

    const updated = await core.call('update', { id, body, if_revision: await revisionOf(core, ctx, id) }, ctx);

    expect(updated).toMatchObject({ ok: true, result: { noops: [] } });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({ ok: true, result: { body } });
  });

  test('if_revision guards every kind of update, not only body replaces', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Guarded' });

    const outcome = await expectRefUnmoved(world.a, () =>
      core.call('update', { id, title: 'Renamed', if_revision: 'not-the-revision' }, ctx),
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  });

  test('labels are content: a label change moves the revision (spec §3 revision formula)', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Labelled' });
    const before = await revisionOf(core, ctx, id);

    const updated = await core.call('update', { id, labels_add: ['triage'] }, ctx);

    expect(updated).toMatchObject({ ok: true, result: { revision: await revisionOf(core, ctx, id) } });
    expect(updated.ok && updated.result.revision).not.toBe(before);
  });

  test('an unknown issue gives NOT_FOUND and moves nothing', async ({ world, grimoire }) => {
    const before = await trackerTip(world.a);

    const updated = await grimoire.core.call('update', { id: 'gr-zzzzz', title: 'x' }, grimoire.ctx);

    expect(updated).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { ref: 'gr-zzzzz' } } });
    expect(await trackerTip(world.a)).toBe(before);
  });
});

describe('update body_patch', () => {
  const MAP = '# Map\n\n## Decisions\n- one\n\n## Open\n- q1\n- q2\n';

  test('replace, insert_before and append apply in order to the verbatim body, without if_revision', async ({
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Map', body: MAP });

    const updated = await core.call(
      'update',
      {
        id,
        body_patch: [
          { op: 'replace', anchor: '- one\n', text: '- one, revised\n' },
          { op: 'insert_before', anchor: '\n## Open', text: '- two\n' },
          { op: 'replace', anchor: '- q1\n', text: '' },
          { op: 'append', text: '- q3\n' },
        ],
      },
      ctx,
    );

    expect(updated).toMatchObject({ ok: true, result: { noops: [] } });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { body: '# Map\n\n## Decisions\n- one, revised\n- two\n\n## Open\n- q2\n- q3\n' },
    });
  });

  test('an anchor that matches nowhere gives ANCHOR_NOT_FOUND with the op index, and nothing is saved', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Map', body: MAP });

    const outcome = await expectRefUnmoved(world.a, () =>
      core.call(
        'update',
        {
          id,
          title: 'Renamed too',
          body_patch: [
            { op: 'append', text: '- q3\n' },
            { op: 'insert_before', anchor: '## Closed', text: '- x\n' },
          ],
        },
        ctx,
      ),
    );

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'ANCHOR_NOT_FOUND', message: expect.any(String), retryable: false, details: { op: 1 } },
    });
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({ ok: true, result: { title: 'Map', body: MAP } });
  });

  test('an anchor that matches more than once gives ANCHOR_AMBIGUOUS, and nothing is saved', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Map', body: MAP });

    const outcome = await expectRefUnmoved(world.a, () =>
      core.call('update', { id, body_patch: [{ op: 'replace', anchor: '- q', text: '- Q' }] }, ctx),
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: 'ANCHOR_AMBIGUOUS', details: { op: 0 } } });
  });

  test('an insert whose text is already present is a reported no-op, so a retry writes nothing', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Map', body: MAP });
    const patch = {
      id,
      body_patch: [
        { op: 'insert_before', anchor: '\n## Open', text: '- two\n' },
        { op: 'append', text: '- q3\n' },
      ],
    };
    await core.call('update', patch, ctx);
    const before = await trackerTip(world.a);

    const retried = await core.call('update', patch, ctx);

    expect(retried).toMatchObject({
      ok: true,
      result: {
        noops: [
          { field: 'body_patch[0]', reason: 'text already present' },
          { field: 'body_patch[1]', reason: 'text already present' },
        ],
      },
    });
    expect(await trackerTip(world.a)).toBe(before);
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { body: '# Map\n\n## Decisions\n- one\n- two\n\n## Open\n- q1\n- q2\n- q3\n' },
    });
  });

  test.for([
    ['body and body_patch together', { body: 'x', if_revision: 'r', body_patch: [{ op: 'append', text: 'y' }] }, 'body_patch'],
    ['an empty anchor', { body_patch: [{ op: 'replace', anchor: '', text: 'y' }] }, 'body_patch[0].anchor'],
    ['an insert of nothing', { body_patch: [{ op: 'append', text: '' }] }, 'body_patch[0].text'],
    ['an unknown op', { body_patch: [{ op: 'prepend', text: 'y' }] }, 'body_patch[0].op'],
  ] as const)('%s gives INVALID', async ([, patch, field], { world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Map', body: MAP });

    const outcome = await expectRefUnmoved(world.a, () => core.call('update', { id, ...patch }, ctx));

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { [field]: expect.any(String) } } } });
  });
});

describe('update relations', () => {
  test('parent and blocked_by deltas are stored; a blocker whose record is gone can still be removed', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const map = await createIssue(core, ctx, { title: 'Map' });
    const a = await createIssue(core, ctx, { title: 'A' });
    const b = await createIssue(core, ctx, { title: 'B' });
    const gone = await createIssue(core, ctx, { title: 'Gone' });
    await core.call('update', { id: a, blocked_by_add: [gone] }, ctx);
    await commitToTracker(world.a, { [issuePath(gone)]: null });

    const updated = await core.call(
      'update',
      { id: a, parent: map, blocked_by_add: [b], blocked_by_remove: [gone, 'gr-zzzzz'] },
      ctx,
    );

    expect(updated).toMatchObject({
      ok: true,
      result: { noops: [{ field: 'blocked_by_remove[1]', reason: 'not set' }] },
    });
    expect(await core.call('show', { ref: a }, ctx)).toMatchObject({
      ok: true,
      result: { parent: map, blocked_by: [b] },
    });
    const cleared = await core.call('update', { id: a, parent: null }, ctx);
    const again = await core.call('update', { id: a, parent: null }, ctx);
    expect(cleared).toMatchObject({ ok: true, result: { noops: [] } });
    expect(again).toMatchObject({ ok: true, result: { noops: [{ field: 'parent', reason: 'unchanged' }] } });
    expect(await core.call('show', { ref: a }, ctx)).toMatchObject({ ok: true, result: { parent: null } });
  });

  test('an unknown parent or blocker gives NOT_FOUND naming the field, and moves nothing', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const a = await createIssue(core, ctx, { title: 'A' });

    const parent = await expectRefUnmoved(world.a, () => core.call('update', { id: a, parent: 'gr-zzzzz' }, ctx));
    const blocker = await expectRefUnmoved(world.a, () =>
      core.call('update', { id: a, blocked_by_add: ['gr-zzzzz'] }, ctx),
    );

    expect(parent).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { field: 'parent', ref: 'gr-zzzzz' } } });
    expect(blocker).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND', details: { field: 'blocked_by_add[0]', ref: 'gr-zzzzz' } },
    });
  });

  test('a parent cycle gives CYCLE with the path, and moves nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const top = await createIssue(core, ctx, { title: 'Top' });
    const mid = await createIssue(core, ctx, { title: 'Mid', parent: top });
    const leaf = await createIssue(core, ctx, { title: 'Leaf', parent: mid });

    const outcome = await expectRefUnmoved(world.a, () => core.call('update', { id: top, parent: leaf }, ctx));
    const self = await core.call('update', { id: top, parent: top }, ctx);

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'CYCLE', message: expect.any(String), retryable: false, details: { path: [top, mid, leaf, top] } },
    });
    expect(self).toMatchObject({ ok: false, error: { code: 'CYCLE', details: { path: [top, top] } } });
  });

  test('a blocker cycle gives CYCLE with the path, and moves nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const a = await createIssue(core, ctx, { title: 'A' });
    const b = await createIssue(core, ctx, { title: 'B', blocked_by: [a] });
    const c = await createIssue(core, ctx, { title: 'C', blocked_by: [b] });

    const outcome = await expectRefUnmoved(world.a, () => core.call('update', { id: a, blocked_by_add: [c] }, ctx));
    const self = await core.call('update', { id: a, blocked_by_add: [a] }, ctx);

    expect(outcome).toMatchObject({ ok: false, error: { code: 'CYCLE', details: { path: [a, c, b, a] } } });
    expect(self).toMatchObject({ ok: false, error: { code: 'CYCLE', details: { path: [a, a] } } });
  });

  test('a child blocked by its own ancestor is a CYCLE (neither could ever be ready); a parent blocked by its child is fine', async ({
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const map = await createIssue(core, ctx, { title: 'Map' });
    const spike = await createIssue(core, ctx, { title: 'Spike', parent: map });

    const deadlock = await core.call('update', { id: spike, blocked_by_add: [map] }, ctx);
    const fine = await core.call('update', { id: map, blocked_by_add: [spike] }, ctx);

    expect(deadlock).toMatchObject({ ok: false, error: { code: 'CYCLE', details: { path: [spike, map, spike] } } });
    expect(fine).toMatchObject({ ok: true });
  });

  test('adding and removing the same label or blocker in one update gives INVALID', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const a = await createIssue(core, ctx, { title: 'A' });
    const b = await createIssue(core, ctx, { title: 'B' });

    const outcome = await core.call(
      'update',
      { id: a, labels_add: ['x'], labels_remove: ['x'], blocked_by_add: [b], blocked_by_remove: [b] },
      ctx,
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID',
        details: { fields: { 'labels_remove[0]': expect.any(String), 'blocked_by_remove[0]': expect.any(String) } },
      },
    });
  });
});

describe('update links_add', () => {
  test('a link target may be a URL, a repo path or a git ref; links are stored as a sorted set', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });

    const first = await core.call(
      'update',
      {
        id,
        links_add: [
          { target: 'https://forge.example/o/r/pull/7', title: 'PR' },
          { target: 'docs\\adr\\0007-issue-state.md', title: 'ADR 0007' },
          { target: 'refs/heads/feature/login' },
          { target: '3f9c2ab' },
        ],
      },
      ctx,
    );
    const second = await core.call(
      'update',
      { id, links_add: [{ target: 'https://forge.example/o/r/pull/7', title: 'PR' }, { target: 'main' }] },
      ctx,
    );

    expect(first).toMatchObject({ ok: true, result: { noops: [] } });
    expect(second).toMatchObject({ ok: true, result: { noops: [{ field: 'links_add[0]', reason: 'already set' }] } });
    const record = await trackerFile(world.a, (await trackerTip(world.a))!, issuePath(id));
    expect(record).toContain(
      'links: [{"target":"3f9c2ab","title":""},{"target":"docs/adr/0007-issue-state.md","title":"ADR 0007"},' +
        '{"target":"https://forge.example/o/r/pull/7","title":"PR"},{"target":"main","title":""},' +
        '{"target":"refs/heads/feature/login","title":""}]\n',
    );
  });

  test('credentials in a link URL are stripped before anything is stored', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });

    await core.call('update', { id, links_add: [{ target: 'https://bob:hunter2@forge.example/o/r' }] }, ctx);

    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({
      ok: true,
      result: { links: [{ target: 'https://forge.example/o/r', title: '' }] },
    });
  });

  test.for([
    ['a Windows absolute path', 'C:\\Users\\alice\\notes.md'],
    ['a POSIX absolute path', '/home/alice/notes.md'],
    ['a home-relative path', '~/notes.md'],
    ['a path that leaves the repo', 'docs/../../secrets'],
    ['a blank target', '   '],
    ['a two-line target', 'docs/a.md\ndocs/b.md'],
  ] as const)('%s is not a link target: INVALID', async ([, target], { world, grimoire }) => {
    const { core, ctx } = grimoire;
    const id = await createIssue(core, ctx, { title: 'Linked' });

    const outcome = await expectRefUnmoved(world.a, () => core.call('update', { id, links_add: [{ target }] }, ctx));

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { 'links_add[0].target': expect.any(String) } } },
    });
  });
});
