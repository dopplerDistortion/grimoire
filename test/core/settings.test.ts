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
          'auto-sync': { value: true, default: true },
          link_base: { value: '', default: true },
        },
        machine: {
          'knowledge.pickup': { value: 'ask', default: true },
          'dashboard.port': { value: expect.any(Number), default: true },
          'dashboard.stale_after': { value: '24h', default: true },
          'capture.excerpts_max': { value: 'excerpts', default: true },
        },
      },
    });
    // The store settings other parts of grimoire own (the excerpt mode, the loop pause, thresholds) come with them.
    expect(Object.keys(shown.ok ? shown.result.store : {}).sort()).toEqual([
      'auto-sync',
      'link_base',
      'skills.delivery',
      'skills.description_max',
      'skills.max_active',
    ]);
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
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(/^Grimoire-Op: settings-set$/m);
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

    const unknownKeys = ['no.such', 'constructor', '__proto__', 'toString', 'excerpts'];
    const [unknownSets, badValues, unknownGets] = await expectRefUnmoved(world.a, async () => [
      await Promise.all(unknownKeys.map((key) => core.call('settings_set', { key, value: 'x' }, terminal(ctx)))),
      [
        await core.call('settings_set', { key: 'auto-sync', value: 'maybe' }, terminal(ctx)),
        await core.call('settings_set', { key: 'link_base', value: 'https://user:token@forge.example/' }, terminal(ctx)),
        await core.call('settings_set', { key: 'dashboard.port', value: 0 }, terminal(ctx)),
      ],
      await Promise.all(unknownKeys.map((key) => core.call('settings_get', { key }, ctx))),
    ]);

    for (const outcome of [...unknownSets, ...unknownGets]) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { key: expect.any(String) } } } });
    }
    for (const outcome of badValues) {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { value: expect.any(String) } } } });
    }
  });

  test('concurrent changes on two clones fold per key, the later change winning', async ({ world, grimoire }) => {
    const { core, ctx: alice } = grimoire;
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const bob = terminal(agentContext(world.b));
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    // Bob's change to link_base is the later one; only Alice changes auto-sync.
    await bobCore.call('settings_set', { key: 'link_base', value: 'https://bob.example/' }, bob);
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
          'auto-sync': { value: false, by: 'alice@example.com' },
        },
      },
    });
    expect(await trackerFile(world.a, (await trackerTip(world.a))!, 'settings.yml')).toBe(
      [
        `auto-sync: {"value":false,"at":"${T0.toISOString()}","by":"alice@example.com"}`,
        `link_base: {"value":"https://bob.example/","at":"${T1.toISOString()}","by":"bob@example.com"}`,
        '',
      ].join('\n'),
    );
  });

  test('keys a newer release set are shown and kept when this release sets another', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const future = `chores.compile_min_pairs: {"value":6,"at":"2026-10-01T00:00:00.000Z","by":"carol@example.com","why":"later"}`;
    const odd = `__proto__: {"value":"odd","at":"2026-10-01T00:00:00.000Z","by":"carol@example.com"}`;
    await commitToTracker(world.a, { 'settings.yml': `${odd}\n${future}\n` });

    const shown = await core.call('settings_get', { key: 'chores.compile_min_pairs' }, ctx);
    const all = await core.call('settings_get', {}, ctx);
    await core.call('settings_set', { key: 'auto-sync', value: false }, terminal(ctx));

    expect(shown).toEqual({
      ok: true,
      result: { store: { 'chores.compile_min_pairs': { value: 6, default: false, at: '2026-10-01T00:00:00.000Z', by: 'carol@example.com' } }, machine: {} },
    });
    // Even a key named like a prototype property is shown as the tracker holds it.
    const store = all.ok ? all.result.store : {};
    expect(Object.keys(store)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(JSON.parse(JSON.stringify(store)), '__proto__')?.value).toEqual({ value: 'odd', default: false, at: '2026-10-01T00:00:00.000Z', by: 'carol@example.com' });
    expect(await trackerFile(world.a, (await trackerTip(world.a))!, 'settings.yml')).toBe(
      `${odd}\nauto-sync: {"value":false,"at":"${T0.toISOString()}","by":"alice@example.com"}\n${future}\n`,
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
