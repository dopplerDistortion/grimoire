// Settings (spec §3 Layout, §4 Fold rules, §6 Machine settings): store
// settings on the tracker, folding per key with the later change winning, and
// machine settings in the machine-local store.
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import type { GitWorld } from '#harness';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  issuePath,
  pushTracker,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
} from './support';

const T1 = new Date(T0.getTime() + 60_000);
const LINK_BASE = 'https://forge.example/o/r/blob/grimoire/tracker/';

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

async function bobPublishes(world: GitWorld): Promise<void> {
  await pushTracker(world.b);
  await fetchTracker(world.a);
}

describe('store settings', () => {
  test('settings_get shows every known setting, with its default until someone sets it', async ({ grimoire }) => {
    const { core, ctx } = grimoire;

    const shown = await core.call('settings_get', {}, ctx);

    expect(shown).toMatchObject({
      ok: true,
      result: {
        store: {
          excerpts: { value: 'facts', default: true },
          'auto-sync': { value: true, default: true },
          link_base: { value: '', default: true },
          delivery: { value: 'on', default: true },
          'knowledge.loop': { value: 'on', default: true },
          'skills.max_active': { value: 8, default: true },
          'skills.description_max': { value: 300, default: true },
        },
        machine: {
          'knowledge.pickup': { value: 'ask', default: true },
          'dashboard.port': { value: expect.any(Number), default: true },
          'dashboard.stale_after': { value: '24h', default: true },
          'capture.excerpts_max': { value: 'excerpts', default: true },
        },
      },
    });
  });

  test('settings_set commits one line per key holding the value, when and by whom; show’s link follows it', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const id = await (async () => {
      const created = await core.call('create', { title: 'Linked' }, ctx);
      return created.ok ? created.result.id : '';
    })();

    const set = await core.call('settings_set', { key: 'link_base', value: LINK_BASE }, terminal(ctx));
    const sync = await core.call('settings_set', { key: 'auto-sync', value: 'false' }, terminal(ctx));
    const again = await expectRefUnmoved(world.a, () => core.call('settings_set', { key: 'link_base', value: LINK_BASE }, terminal(ctx)));

    expect(set).toEqual({
      ok: true,
      result: { key: 'link_base', scope: 'store', value: LINK_BASE, changed: true, at: T0.toISOString(), by: 'alice@example.com' },
    });
    expect(sync).toMatchObject({ ok: true, result: { value: false, changed: true } });
    expect(again).toMatchObject({ ok: true, result: { changed: false } });
    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, 'settings.yml')).toBe(
      [
        `auto-sync: {"value":false,"at":"${T0.toISOString()}","by":"alice@example.com"}`,
        `link_base: {"value":"${LINK_BASE}","at":"${T0.toISOString()}","by":"alice@example.com"}`,
        '',
      ].join('\n'),
    );
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(/^Grimoire-Op: settings_set$/m);
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({ ok: true, result: { link: `${LINK_BASE}${issuePath(id)}` } });
    expect(await core.call('settings_get', { key: 'link_base' }, ctx)).toEqual({
      ok: true,
      result: {
        store: { link_base: { value: LINK_BASE, default: false, at: T0.toISOString(), by: 'alice@example.com', description: expect.any(String) } },
        machine: {},
      },
    });
  });

  test('an unknown key or an invalid value is refused, the ref unmoved', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;

    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('settings_set', { key: 'no.such', value: 'x' }, terminal(ctx)),
      await core.call('settings_set', { key: 'excerpts', value: 'everything' }, terminal(ctx)),
      await core.call('settings_set', { key: 'link_base', value: 'https://user:token@forge.example/' }, terminal(ctx)),
      await core.call('settings_set', { key: 'skills.max_active', value: 0 }, terminal(ctx)),
      await core.call('settings_get', { key: 'no.such' }, ctx),
    ]);

    expect(refused[0]).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { key: expect.any(String) } } } });
    for (const outcome of refused.slice(1, 4)) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { value: expect.any(String) } } } });
    }
    expect(refused[4]).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  test('concurrent changes on two clones fold per key, the later change winning', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const bob = terminal(agentContext(world.b));
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    // Bob's change to link_base is the later one; each clone also sets a key of its own.
    await bobCore.call('settings_set', { key: 'link_base', value: 'https://bob.example/' }, bob);
    await bobCore.call('settings_set', { key: 'excerpts', value: 'none' }, bob);
    await core.call('settings_set', { key: 'link_base', value: 'https://alice.example/' }, terminal(alice));
    await core.call('settings_set', { key: 'auto-sync', value: false }, terminal(alice));
    await bobPublishes(world);

    const seen = await core.call('settings_get', {}, alice);
    await core.call('create', { title: 'commits the fold' }, alice);

    expect(seen).toMatchObject({
      ok: true,
      result: {
        store: {
          link_base: { value: 'https://bob.example/', at: T1.toISOString(), by: 'bob@example.com' },
          excerpts: { value: 'none', by: 'bob@example.com' },
          'auto-sync': { value: false, by: 'alice@example.com' },
        },
      },
    });
    expect(await trackerFile(world.a, (await trackerTip(world.a))!, 'settings.yml')).toBe(
      [
        `auto-sync: {"value":false,"at":"${T0.toISOString()}","by":"alice@example.com"}`,
        `excerpts: {"value":"none","at":"${T1.toISOString()}","by":"bob@example.com"}`,
        `link_base: {"value":"https://bob.example/","at":"${T1.toISOString()}","by":"bob@example.com"}`,
        '',
      ].join('\n'),
    );
  });

  test('keys a newer release set are shown and kept when this release sets another', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const future = `chores.compile_min_pairs: {"value":6,"at":"2026-10-01T00:00:00.000Z","by":"carol@example.com","why":"later"}`;
    await commitToTracker(world.a, { 'settings.yml': `${future}\n` });

    const shown = await core.call('settings_get', { key: 'chores.compile_min_pairs' }, ctx);
    await core.call('settings_set', { key: 'delivery', value: 'off' }, terminal(ctx));

    expect(shown).toEqual({
      ok: true,
      result: { store: { 'chores.compile_min_pairs': { value: 6, default: false, at: '2026-10-01T00:00:00.000Z', by: 'carol@example.com' } }, machine: {} },
    });
    expect(await trackerFile(world.a, (await trackerTip(world.a))!, 'settings.yml')).toBe(
      `${future}\ndelivery: {"value":"off","at":"${T0.toISOString()}","by":"alice@example.com"}\n`,
    );
  });
});

describe('machine settings', () => {
  test('live in the machine-local store, not on the tracker, and reach their readers', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const created = await core.call('create', { title: 'Here' }, ctx);
    const id = created.ok ? created.result.id : '';

    const [port, stale, pickup, cap] = await expectRefUnmoved(world.a, async () => [
      await core.call('settings_set', { key: 'dashboard.port', value: '47999' }, terminal(ctx)),
      await core.call('settings_set', { key: 'dashboard.stale_after', value: '48h' }, terminal(ctx)),
      await core.call('settings_set', { key: 'knowledge.pickup', value: 'auto' }, terminal(ctx)),
      await core.call('settings_set', { key: 'capture.excerpts_max', value: 'facts' }, terminal(ctx)),
    ]);

    expect(port).toEqual({ ok: true, result: { key: 'dashboard.port', scope: 'machine', value: 47999, changed: true } });
    for (const outcome of [stale, pickup, cap]) expect(outcome).toMatchObject({ ok: true, result: { scope: 'machine', changed: true } });
    const records = new MachineLocalStore(path.join(world.a.dir, '.git')).records;
    expect(await records.read('machine-settings', 'knowledge.pickup')).toBe('auto');
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({ ok: true, result: { local_link: `http://127.0.0.1:47999/issues/${id}` } });
    expect(await core.call('settings_get', {}, ctx)).toMatchObject({
      ok: true,
      result: {
        machine: {
          'dashboard.port': { value: 47999, default: false },
          'dashboard.stale_after': { value: '48h', default: false },
          'knowledge.pickup': { value: 'auto', default: false },
          'capture.excerpts_max': { value: 'facts', default: false },
        },
      },
    });
    const refused = await core.call('settings_set', { key: 'dashboard.stale_after', value: 'soon' }, terminal(ctx));
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(await records.read('machine-settings', 'dashboard.stale_after')).toBe('48h');
  });
});
