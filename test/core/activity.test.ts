// Seam 1: `activity` (spec §20, dashboard read ops): the tracker's writes,
// newest first, read from their commits' trailers: who (the person, plus
// client and session), which op, which issue and attempt, and for an update
// the fields it changed. The issue timeline reads it for one issue.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { coreTest as test } from './support';

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

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    const refused = await grimoire.core.call('activity', {}, grimoire.ctx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('HUMAN_ONLY');
  });
});
