import { describe, expect } from 'vitest';
import type { Checkout } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { commitToTracker, coreTest as test, issuePath, suffixQueue, trackerFile, trackerTip } from './support';

async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

/** Sets an issue's status the way another writer would (close and reopen arrive with later slices). */
async function setStatus(checkout: Checkout, id: string, status: 'done' | 'canceled' | 'open'): Promise<void> {
  const record = await trackerFile(checkout, (await trackerTip(checkout))!, issuePath(id));
  await commitToTracker(checkout, { [issuePath(id)]: record.replace(/^status: .*$/m, `status: ${JSON.stringify(status)}`) });
}

async function listIds(core: Core, ctx: CallContext, input: Record<string, unknown> = {}): Promise<string[]> {
  const listed = await core.call('list', input, ctx);
  if (!listed.ok) throw new Error(`list failed: ${JSON.stringify(listed.error)}`);
  return listed.result.rows.map((row) => row.id);
}

describe('list', () => {
  test('rows come in (seq, id) order with their derived fields', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('m0000', 'a0000', 'b0000') });
    const { ctx } = grimoire;
    const map = await createIssue(core, ctx, { title: 'Map', labels: ['map'] });
    const leaf = await createIssue(core, ctx, { title: 'Leaf', parent: map });
    const blocked = await createIssue(core, ctx, { title: 'Blocked', parent: map, blocked_by: [leaf] });
    await core.call('comment', { id: leaf, body: 'first' }, ctx);
    await core.call('comment', { id: leaf, body: 'second' }, ctx);

    const listed = await core.call('list', {}, ctx);

    expect(listed).toEqual({
      ok: true,
      result: {
        rows: [
          {
            id: map,
            seq: 1,
            title: 'Map',
            status: 'open',
            labels: ['map'],
            assignee: null,
            parent: null,
            blocked_by: [],
            open_blocker_count: 0,
            open_child_count: 2,
            ready: false,
            open_attempts: [],
            conflict: null,
            comment_count: 0,
            last_comment_at: null,
            created_at: '2026-10-11T03:15:08.750Z',
            updated_at: '2026-10-11T03:15:08.750Z',
            link: map,
          },
          expect.objectContaining({
            id: leaf,
            seq: 2,
            parent: map,
            ready: true,
            comment_count: 2,
            last_comment_at: '2026-10-11T03:15:08.751Z',
          }),
          expect.objectContaining({ id: blocked, seq: 3, blocked_by: [leaf], open_blocker_count: 1, ready: false }),
        ],
        total: 3,
        cursor: null,
      },
    });
  });

  test('ready = claimable: not closed, no open or unknown blocker, no open sub-issue', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const done = await createIssue(core, ctx, { title: 'Done' });
    const canceled = await createIssue(core, ctx, { title: 'Canceled' });
    const open = await createIssue(core, ctx, { title: 'Open blocker' });
    const gone = await createIssue(core, ctx, { title: 'Gone' });
    const freed = await createIssue(core, ctx, { title: 'Blockers all closed', blocked_by: [done, canceled] });
    const blockedOpen = await createIssue(core, ctx, { title: 'Blocked by open', blocked_by: [open] });
    const blockedUnknown = await createIssue(core, ctx, { title: 'Blocked by unknown', blocked_by: [gone] });
    const parent = await createIssue(core, ctx, { title: 'Parent with open child' });
    const child = await createIssue(core, ctx, { title: 'Open child', parent });
    const finished = await createIssue(core, ctx, { title: 'Parent with closed children' });
    const closedChild = await createIssue(core, ctx, { title: 'Closed child', parent: finished });
    await setStatus(world.a, done, 'done');
    await setStatus(world.a, canceled, 'canceled');
    await setStatus(world.a, closedChild, 'done');
    await commitToTracker(world.a, { [issuePath(gone)]: null });

    const ready = await listIds(core, ctx, { ready: true });
    const notReady = await listIds(core, ctx, { ready: false });

    expect(ready).toEqual([open, freed, child, finished]);
    expect(notReady).toEqual([done, canceled, blockedOpen, blockedUnknown, parent, closedChild]);
  });

  test('filters: status, labels (AND), without_label, unlabeled, parent, assignee, view', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const bugAuth = await createIssue(core, ctx, { title: 'a', labels: ['bug', 'area:auth'] });
    const bug = await createIssue(core, ctx, { title: 'b', labels: ['bug'] });
    const plain = await createIssue(core, ctx, { title: 'c' });
    const kid = await createIssue(core, ctx, { title: 'd', parent: plain, blocked_by: [bug] });
    const closed = await createIssue(core, ctx, { title: 'e', labels: ['bug'] });
    await setStatus(world.a, closed, 'done');

    expect(await listIds(core, ctx, { status: 'open' })).toEqual([bugAuth, bug, plain, kid]);
    expect(await listIds(core, ctx, { status: 'done' })).toEqual([closed]);
    expect(await listIds(core, ctx, { label: ['bug', 'area:auth'] })).toEqual([bugAuth]);
    expect(await listIds(core, ctx, { label: ['bug'], without_label: ['area:auth'] })).toEqual([bug, closed]);
    expect(await listIds(core, ctx, { unlabeled: true })).toEqual([plain, kid]);
    expect(await listIds(core, ctx, { unlabeled: false })).toEqual([bugAuth, bug, closed]);
    expect(await listIds(core, ctx, { parent: plain })).toEqual([kid]);
    expect(await listIds(core, ctx, { parent: plain.slice(0, 7) })).toEqual([kid]);
    expect(await listIds(core, ctx, { assignee: 'none' })).toEqual([bugAuth, bug, plain, kid, closed]);
    expect(await listIds(core, ctx, { assignee: 'me' })).toEqual([]);
    expect(await listIds(core, ctx, { assignee: 'carol@example.com' })).toEqual([]);
    expect(await listIds(core, ctx, { view: 'open' })).toEqual([bugAuth, bug, plain, kid]);
    expect(await listIds(core, ctx, { view: 'ready' })).toEqual([bugAuth, bug]);
    expect(await listIds(core, ctx, { view: 'blocked' })).toEqual([kid]);
    expect(await listIds(core, ctx, { view: 'closed' })).toEqual([closed]);
    expect(await listIds(core, ctx, { view: 'all' })).toEqual([bugAuth, bug, plain, kid, closed]);
    expect(await listIds(core, ctx, { view: 'claimed' })).toEqual([]);
    expect(await listIds(core, ctx, { view: 'stale' })).toEqual([]);
    expect(await listIds(core, ctx, { view: 'conflicts' })).toEqual([]);
    expect(await listIds(core, ctx, { parent: plain, ready: true })).toEqual([]);
  });

  test('limit and cursor page through the rows in order; total counts every match', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await createIssue(core, ctx, { title: `issue ${i}` }));

    const first = await core.call('list', { limit: 2 }, ctx);
    const cursor1 = first.ok ? first.result.cursor : null;
    const second = await core.call('list', { limit: 2, cursor: cursor1 }, ctx);
    const cursor2 = second.ok ? second.result.cursor : null;
    const third = await core.call('list', { limit: 2, cursor: cursor2 }, ctx);

    expect(first).toMatchObject({ ok: true, result: { total: 5, cursor: expect.any(String) } });
    expect([first, second, third].map((page) => (page.ok ? page.result.rows.map((r) => r.id) : []))).toEqual([
      ids.slice(0, 2),
      ids.slice(2, 4),
      ids.slice(4),
    ]);
    expect(third).toMatchObject({ ok: true, result: { total: 5, cursor: null } });
  });

  test.for([
    ['a limit over 200', { limit: 201 }, 'limit'],
    ['a limit of 0', { limit: 0 }, 'limit'],
    ['a cursor that is not one', { cursor: 'nonsense' }, 'cursor'],
    ['an unknown view', { view: 'mine' }, 'view'],
    ['an unknown status', { status: 'closed' }, 'status'],
  ] as const)('%s gives INVALID', async ([, input, field], { grimoire }) => {
    const outcome = await grimoire.core.call('list', input, grimoire.ctx);

    expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { [field]: expect.any(String) } } } });
  });

  test('a page over ~24 KB is cut well-formed after a whole row, with truncated and a cursor to the rest', async ({
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(await createIssue(core, ctx, { title: `${String(i).padStart(2, '0')} ${'long title '.repeat(60)}` }));
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await core.call('list', { limit: 200, ...(cursor ? { cursor } : {}) }, ctx);
      if (!page.ok) throw new Error(JSON.stringify(page.error));
      const bytes = Buffer.byteLength(JSON.stringify(page.result), 'utf8');
      expect(bytes).toBeLessThanOrEqual(24 * 1024);
      if (page.result.cursor) expect(page.result.truncated).toBe(true);
      seen.push(...page.result.rows.map((row) => row.id));
      cursor = page.result.cursor;
      pages++;
    } while (cursor);

    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(ids);
  });
});
