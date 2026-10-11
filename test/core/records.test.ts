import { describe, expect } from 'vitest';
import { openTracker } from '../../src/tracker';
import { commitToTracker, coreTest as test, issuePath, T0, trackerFile, trackerTip } from './support';

/** An issue record as a later release might write it: an unknown key, and a body with odd bytes. */
function futureRecord(overrides: Record<string, string> = {}, body = 'Body\r\nwith CRLF\n'): string {
  const keys: Record<string, string> = {
    id: '"gr-fe7a0"',
    seq: '7',
    title: '"From the future"',
    status: '"open"',
    labels: '["x"]',
    parent: 'null',
    blocked_by: '[]',
    links: '[]',
    created_at: '"2026-01-01T00:00:00.000Z"',
    created_by: '"carol@example.com"',
    updated_at: '"2026-01-02T00:00:00.000Z"',
    zz_later: '{"b":1,"a":[true,null]}',
    estimate: '3',
    ...overrides,
  };
  return `---\n${Object.entries(keys)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${body}`;
}

describe('issue records', () => {
  test('unknown frontmatter keys survive a rewrite, sorted after the known keys', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    await commitToTracker(world.a, { [issuePath('gr-fe7a0')]: futureRecord() });
    const store = await openTracker(world.a.dir, { clock: () => T0 });
    try {
      await store.transact(
        { op: 'update', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'human', nonce: 'n' } },
        (draft) => {
          const record = draft.issue('gr-fe7a0')!;
          draft.putIssue({ ...record, title: 'Renamed', updated_at: draft.now.toISOString() });
          return { result: null, issue: record.id };
        },
      );
    } finally {
      await store.close();
    }

    const tip = await trackerTip(world.a);
    expect(await trackerFile(world.a, tip!, issuePath('gr-fe7a0'))).toBe(
      [
        '---',
        'id: "gr-fe7a0"',
        'seq: 7',
        'title: "Renamed"',
        'status: "open"',
        'labels: ["x"]',
        'parent: null',
        'blocked_by: []',
        'links: []',
        'created_at: "2026-01-01T00:00:00.000Z"',
        'created_by: "carol@example.com"',
        'updated_at: "2026-10-11T03:15:08.750Z"',
        'estimate: 3',
        'zz_later: {"b":1,"a":[true,null]}',
        '---',
        'Body\r\nwith CRLF\n',
      ].join('\n'),
    );
  });

  test('show reads a record a later release wrote, body byte for byte', async ({ world, grimoire }) => {
    await commitToTracker(world.a, { [issuePath('gr-fe7a0')]: futureRecord() });

    const shown = await grimoire.core.call('show', { ref: 'gr-fe7a0' }, grimoire.ctx);

    expect(shown).toMatchObject({
      ok: true,
      result: { id: 'gr-fe7a0', seq: 7, title: 'From the future', labels: ['x'], body: 'Body\r\nwith CRLF\n' },
    });
  });

  test('the revision ignores id, seq and the timestamps, and covers content and unknown keys', async ({
    world,
    grimoire,
  }) => {
    const revisionOf = async (record: string) => {
      await commitToTracker(world.a, { [issuePath('gr-fe7a0')]: record });
      const shown = await grimoire.core.call('show', { ref: 'gr-fe7a0' }, grimoire.ctx);
      return shown.ok ? shown.result.revision : '';
    };

    const base = await revisionOf(futureRecord());
    const bookkeeping = await revisionOf(
      futureRecord({
        seq: '9',
        created_at: '"2025-05-05T00:00:00.000Z"',
        created_by: '"dave@example.com"',
        updated_at: '"2027-01-01T00:00:00.000Z"',
      }),
    );
    const reordered = await revisionOf(futureRecord({ zz_later: '{"a":[true,null],"b":1}' }));
    const title = await revisionOf(futureRecord({ title: '"Other"' }));
    const unknown = await revisionOf(futureRecord({ estimate: '5' }));
    const body = await revisionOf(futureRecord({}, 'Body\nwith LF\n'));

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(bookkeeping).toBe(base);
    expect(reordered).toBe(base);
    expect(new Set([base, title, unknown, body]).size).toBe(4);
  });
});
