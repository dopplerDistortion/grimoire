import { describe, expect } from 'vitest';
import { coreTest as test, issuePath, trackerFile, trackerTip } from './support';

describe('create and show', () => {
  test('create makes exactly one commit on the tracker ref, holding the canonical record at its sharded path', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const before = await trackerTip(world.a);

    const created = await core.call(
      'create',
      { title: 'Fix the login bug', body: 'Steps:\r\n1. open\n\n  trailing  \n', labels: ['bug', 'area:auth'] },
      ctx,
    );

    expect(created).toEqual({
      ok: true,
      result: { id: expect.stringMatching(/^gr-[0-9a-hjkmnp-tv-z]{5}$/), created: true },
    });
    const id = created.ok ? created.result.id : '';
    const after = await trackerTip(world.a);
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', after!])).toBe(`${after} ${before}`);
    expect(await world.a.git(['diff-tree', '-r', '--name-status', before!, after!])).toBe(
      `A\t${issuePath(id)}`,
    );
    expect(await trackerFile(world.a, after!, issuePath(id))).toBe(
      [
        '---',
        `id: "${id}"`,
        'seq: 1',
        'title: "Fix the login bug"',
        'status: "open"',
        'labels: ["area:auth","bug"]',
        'parent: null',
        'blocked_by: []',
        'links: []',
        'created_at: "2026-10-11T03:15:08.750Z"',
        'created_by: "alice@example.com"',
        'updated_at: "2026-10-11T03:15:08.750Z"',
        '---',
        'Steps:\r\n1. open\n\n  trailing  \n',
      ].join('\n'),
    );
  });

  test('show returns the created fields, and the body as verbatim bytes', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const body = 'Résumé ✓\r\n\ttabbed\n\n\n  ';
    const created = await core.call('create', { title: 'Show me', body, labels: ['b', 'a', 'b'] }, ctx);
    const id = created.ok ? created.result.id : '';

    const shown = await core.call('show', { ref: id }, ctx);

    expect(shown).toEqual({
      ok: true,
      result: {
        id,
        seq: 1,
        title: 'Show me',
        status: 'open',
        labels: ['a', 'b'],
        parent: null,
        blocked_by: [],
        links: [],
        created_at: '2026-10-11T03:15:08.750Z',
        created_by: 'alice@example.com',
        updated_at: '2026-10-11T03:15:08.750Z',
        body,
        revision: expect.stringMatching(/^[0-9a-f]{64}$/),
        link: id,
      },
    });
  });
});
