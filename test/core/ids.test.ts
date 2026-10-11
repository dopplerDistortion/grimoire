import { describe, expect } from 'vitest';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  pushTracker,
  suffixQueue,
} from './support';

const errorOf = (outcome: { ok: boolean; error?: { code: string } }) => (outcome.ok ? null : outcome.error?.code);

describe('issue ids', () => {
  test('a new id is gr- plus 5 lowercase Crockford characters, and seq counts up', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await core.call('create', { title: `issue ${i}` }, ctx);
      ids.push(created.ok ? created.result.id : '');
    }

    for (const id of ids) expect(id).toMatch(/^gr-[0-9a-hjkmnp-tv-z]{5}$/);
    const seqs = [];
    for (const id of ids) {
      const shown = await core.call('show', { ref: id }, ctx);
      seqs.push(shown.ok ? shown.result.seq : 0);
    }
    expect(seqs).toEqual([1, 2, 3]);
  });

  test('reads are case-insensitive, take the i/l/o aliases, and the gr- prefix is optional', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    await core.call('create', { title: 'Aliased' }, grimoire.ctx);

    for (const ref of ['gr-k1m0x', 'GR-K1M0X', 'k1m0x', 'KLMOX', 'gr-kim0x', '  gr-k1m0x  ']) {
      const shown = await core.call('show', { ref }, grimoire.ctx);
      expect(shown.ok && shown.result.id, ref).toBe('gr-k1m0x');
    }
  });

  test('reads resolve a link, or any text holding one full id', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    await core.call('create', { title: 'Linked' }, grimoire.ctx);

    for (const ref of [
      'https://forge.example/o/r/blob/grimoire/tracker/issues/k/1/gr-k1m0x/issue.md',
      'see gr-k1m0x for details',
    ]) {
      const shown = await core.call('show', { ref }, grimoire.ctx);
      expect(shown.ok && shown.result.id, ref).toBe('gr-k1m0x');
    }
  });

  test('reads accept a unique prefix of 3 or more characters, and refuse a shorter one', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'z9z9z') });
    await core.call('create', { title: 'One' }, grimoire.ctx);
    await core.call('create', { title: 'Two' }, grimoire.ctx);

    for (const ref of ['k1m', 'gr-k1m', 'K1M0']) {
      const shown = await core.call('show', { ref }, grimoire.ctx);
      expect(shown.ok && shown.result.id, ref).toBe('gr-k1m0x');
    }
    expect(errorOf(await core.call('show', { ref: 'k1' }, grimoire.ctx))).toBe('INVALID');
  });

  test('a prefix several issues share gives AMBIGUOUS_REF with the candidates', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'k1m2a') });
    await core.call('create', { title: 'One' }, grimoire.ctx);
    await core.call('create', { title: 'Two' }, grimoire.ctx);

    const shown = await core.call('show', { ref: 'k1m' }, grimoire.ctx);

    expect(shown).toEqual({
      ok: false,
      error: {
        code: 'AMBIGUOUS_REF',
        message: expect.any(String),
        retryable: false,
        details: { candidates: ['gr-k1m0x', 'gr-k1m2a'] },
      },
    });
  });

  test('an id nobody has gives NOT_FOUND, and #n is not a reference', async ({ grimoire }) => {
    const { core, ctx } = grimoire;

    expect(errorOf(await core.call('show', { ref: 'gr-zzzzz' }, ctx))).toBe('NOT_FOUND');
    expect(errorOf(await core.call('show', { ref: 'zzz' }, ctx))).toBe('NOT_FOUND');
    expect(errorOf(await core.call('show', { ref: '#5' }, ctx))).toBe('INVALID');
    expect(errorOf(await core.call('show', { ref: 'gr-uuuuu' }, ctx))).toBe('INVALID');
  });

  test('writes need the full id: a prefix gives INVALID and changes nothing', async ({ world, grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'p4r3n') });
    await core.call('create', { title: 'Parent' }, grimoire.ctx);

    const refused = await expectRefUnmoved(world.a, () =>
      core.call('create', { title: 'Child', parent: 'k1m' }, grimoire.ctx),
    );
    const refusedBlocker = await expectRefUnmoved(world.a, () =>
      core.call('create', { title: 'Child', blocked_by: ['gr-k1m0'] }, grimoire.ctx),
    );

    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { parent: expect.any(String) } } } });
    expect(refusedBlocker).toMatchObject({
      ok: false,
      error: { code: 'INVALID', details: { fields: { 'blocked_by[0]': expect.any(String) } } },
    });
  });

  test('writes take the full id in any case, with the aliases, and store it canonically', async ({ grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x', 'b10ck', 'ch11d') });
    await core.call('create', { title: 'Parent' }, grimoire.ctx);
    await core.call('create', { title: 'Blocker' }, grimoire.ctx);

    const child = await core.call('create', { title: 'Child', parent: 'KLMOX', blocked_by: ['B1OCK', 'gr-b10ck'] }, grimoire.ctx);
    const shown = await core.call('show', { ref: child.ok ? child.result.id : '' }, grimoire.ctx);

    expect(shown).toMatchObject({ ok: true, result: { parent: 'gr-k1m0x', blocked_by: ['gr-b10ck'] } });
  });

  test('an unknown parent or blocker gives NOT_FOUND and changes nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;

    const noParent = await expectRefUnmoved(world.a, () => core.call('create', { title: 'x', parent: 'gr-zzzzz' }, ctx));
    const noBlocker = await expectRefUnmoved(world.a, () =>
      core.call('create', { title: 'x', blocked_by: ['gr-zzzzz'] }, ctx),
    );

    expect(noParent).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { ref: 'gr-zzzzz' } } });
    expect(noBlocker).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { ref: 'gr-zzzzz' } } });
  });

  test('minting skips an id taken on the remote-tracking tip, even when it is not in the local view', async ({
    world,
    grimoire,
  }) => {
    // Alice publishes the tracker; Bob takes gr-aaaaa and publishes; Alice writes locally, then fetches.
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bob = grimoire.makeCore({ randomIdSuffix: suffixQueue('aaaaa') });
    await bob.call('create', { title: 'Bob’s' }, agentContext(world.b));
    await pushTracker(world.b);
    const alice = grimoire.makeCore({ randomIdSuffix: suffixQueue('ccccc', 'aaaaa', 'bbbbb') });
    await alice.call('create', { title: 'Alice’s first' }, grimoire.ctx);
    await fetchTracker(world.a);

    const created = await alice.call('create', { title: 'Alice’s second' }, grimoire.ctx);

    expect(created).toEqual({ ok: true, result: { id: 'gr-bbbbb', created: true } });
  });

  test('minting never reuses a deleted or forwarded id', async ({ world, grimoire }) => {
    await commitToTracker(world.a, { 'deleted/gr-ddddd.md': 'by: x\n', 'forwards/gr-fffff.md': 'to: y\n' });
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('ddddd', 'fffff', 'eeeee') });

    const created = await core.call('create', { title: 'Fresh' }, grimoire.ctx);

    expect(created).toEqual({ ok: true, result: { id: 'gr-eeeee', created: true } });
  });

  test('three clashes in a row add a character', async ({ grimoire }) => {
    const first = grimoire.makeCore({ randomIdSuffix: suffixQueue('ccccc') });
    await first.call('create', { title: 'Taken' }, grimoire.ctx);
    const lengths: number[] = [];
    const core = grimoire.makeCore({
      randomIdSuffix: (length) => {
        lengths.push(length);
        return length === 5 ? 'ccccc' : 'dddddd'.slice(0, length);
      },
    });

    const created = await core.call('create', { title: 'Longer' }, grimoire.ctx);

    expect(created).toEqual({ ok: true, result: { id: 'gr-dddddd', created: true } });
    expect(lengths).toEqual([5, 5, 5, 6]);
  });
});
