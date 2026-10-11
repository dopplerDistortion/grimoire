import { describe, expect } from 'vitest';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  fetchTracker,
  issuePath,
  pushTracker,
  suffixQueue,
  trackerTip,
} from './support';

describe('labels, links and the read view', () => {
  test('labels lists every label in use with its count, by name', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    await core.call('create', { title: 'a', labels: ['bug', 'area:auth'] }, ctx);
    await core.call('create', { title: 'b', labels: ['bug'] }, ctx);
    await core.call('create', { title: 'c' }, ctx);

    expect(await core.call('labels', {}, ctx)).toEqual({
      ok: true,
      result: {
        labels: [
          { name: 'area:auth', count: 1 },
          { name: 'bug', count: 2 },
        ],
      },
    });
  });

  test('link is link_base plus the record path when a link_base is set', async ({ world, grimoire }) => {
    const core = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    await core.call('create', { title: 'Linked' }, grimoire.ctx);
    await commitToTracker(world.a, {
      'settings.yml':
        'link_base: {"value":"https://forge.example/o/r/blob/grimoire/tracker/","at":"2026-10-11T00:00:00.000Z","by":"alice@example.com"}\n',
    });

    const shown = await core.call('show', { ref: 'gr-k1m0x' }, grimoire.ctx);

    expect(shown).toMatchObject({
      ok: true,
      result: { link: `https://forge.example/o/r/blob/grimoire/tracker/${issuePath('gr-k1m0x')}` },
    });
  });

  test('a fresh clone reads the fetched tracker, and its first write creates the local ref on top of it', async ({
    world,
    grimoire,
  }) => {
    const created = await grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bob = agentContext(world.b);

    const shown = await grimoire.core.call('show', { ref: created.ok ? created.result.id : '' }, bob);
    const written = await grimoire.core.call('create', { title: 'From Bob' }, bob);

    expect(shown).toMatchObject({ ok: true, result: { title: 'From Alice' } });
    expect(written).toMatchObject({ ok: true, result: { created: true } });
    const bobTip = (await trackerTip(world.b))!;
    expect(await world.b.git(['rev-parse', `${bobTip}^`])).toBe(await world.b.git(['rev-parse', 'origin/grimoire/tracker']));
    expect(await world.b.git(['log', '-1', '--format=%ae', bobTip])).toBe('bob@example.com');
  });

  test('when the remote-tracking tip is ahead, reads show it and writes build on it', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bob = agentContext(world.b);
    const fromBob = await grimoire.core.call('create', { title: 'From Bob' }, bob);
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const shown = await grimoire.core.call('show', { ref: fromBob.ok ? fromBob.result.id : '' }, grimoire.ctx);
    const fromAlice = await grimoire.core.call('create', { title: 'From Alice' }, grimoire.ctx);

    expect(shown).toMatchObject({ ok: true, result: { title: 'From Bob', seq: 1 } });
    const after = await grimoire.core.call('show', { ref: fromAlice.ok ? fromAlice.result.id : '' }, grimoire.ctx);
    expect(after).toMatchObject({ ok: true, result: { seq: 2 } });
    const aliceTip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-parse', `${aliceTip}^`])).toBe(await world.a.git(['rev-parse', 'origin/grimoire/tracker']));
  });

  test('grimoire.remote picks which remote-tracking tracker counts', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bob = agentContext(world.b);
    const fromBob = await grimoire.core.call('create', { title: 'From Bob' }, bob);
    await pushTracker(world.b);
    await world.a.git(['remote', 'add', 'mirror', world.remoteUrl]);
    await world.a.git(['fetch', '--quiet', 'mirror', '+refs/heads/grimoire/tracker:refs/remotes/mirror/grimoire/tracker']);
    const id = fromBob.ok ? fromBob.result.id : '';

    // origin is preferred while nothing is configured; its tracker is stale, so Bob's issue is unknown.
    expect(await grimoire.core.call('show', { ref: id }, grimoire.ctx)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    await world.a.git(['config', 'grimoire.remote', 'mirror']);
    expect(await grimoire.core.call('show', { ref: id }, grimoire.ctx)).toMatchObject({
      ok: true,
      result: { title: 'From Bob' },
    });
  });
});
