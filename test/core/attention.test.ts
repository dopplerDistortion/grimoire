// Seam 1: `attention` (spec §20 Attention, dashboard read ops): only what a
// human must unblock, each item carrying what its inline action needs: stale
// claims, field conflicts, two open attempts, id collisions, sync failures a
// person must fix, and stray edits; plus the quick views' counts.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { setAsideStrayEdit } from '../../src/generated/stray';
import { MachineLocalStore } from '../../src/machine-local';
import { agentContext, coreTest as test, fetchTracker, pushTracker, suffixQueue, T0 } from './support';
import { ok, REJECTING_HOOK } from './sync-support';
import { terminal } from './chore-support';
import { skillText } from './proposer-support';

const dashboard = (ctx: CallContext): CallContext => ({ ...ctx, surface: 'dashboard', client: null, evidence: {} });
const HOUR = 3_600_000;

async function create(core: Core, ctx: CallContext, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ok(core.call('create', { title, ...extra }, ctx))).id;
}

describe('attention', () => {
  test('nothing needs the human on a quiet tracker: no items, and the counts say what there is', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    await create(core, ctx, 'Ready one');
    const blocker = await create(core, ctx, 'Blocker');
    await create(core, ctx, 'Blocked', { blocked_by: [blocker] });
    const held = await create(core, ctx, 'Held');
    await ok(core.call('claim', { id: held }, ctx));

    const seen = await ok(core.call('attention', {}, dashboard(ctx)));

    expect(seen.items).toEqual([]);
    expect(seen.counts).toEqual({ ready: 2, claimed: 1, stale: 0, blocked: 1, conflicts: 0 });
  });

  test('a claim whose last activity is older than the threshold is a stale-claim item; releasing it as abandoned removes it, and its outcome reads fail', async ({ grimoire, world }) => {
    const { ctx } = grimoire;
    const id = await create(grimoire.core, ctx, 'Forgotten');
    const { attempt } = await ok(grimoire.core.call('claim', { id }, ctx));
    const later = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 25 * HOUR) });

    const stale = await ok(later.call('attention', {}, dashboard(ctx)));
    await ok(later.call('release', { id, attempt, abandoned: true }, dashboard(ctx)));
    const after = await ok(later.call('attention', {}, dashboard(ctx)));
    const shown = await ok(later.call('show', { ref: id }, dashboard(ctx)));

    expect(stale.items).toEqual([
      {
        kind: 'stale_claim',
        issue: id,
        title: 'Forgotten',
        attempt: {
          attempt,
          assignee: world.a.identity.email,
          since: T0.toISOString(),
          last_activity_at: T0.toISOString(),
          clients_seen: ['claude-code'],
          held_by_you: true,
          stale: true,
        },
      },
    ]);
    expect(stale.counts).toMatchObject({ claimed: 1, stale: 1 });
    expect(after.items).toEqual([]);
    expect(shown.past_attempts).toMatchObject([{ attempt, ended: 'release-abandoned', outcome: { verdict: 'fail' } }]);
  });

  test('a field conflict and two open attempts from a fold are items naming the issue, its fields and both attempts', async ({ grimoire, world }) => {
    const { core, ctx } = grimoire;
    const bob = agentContext(world.b);
    const titled = await create(core, ctx, 'Shared title');
    const claimed = await create(core, ctx, 'Claimed twice');
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bobCore = grimoire.makeCore();
    await ok(core.call('update', { id: titled, title: 'Alice’s title' }, ctx));
    await ok(bobCore.call('update', { id: titled, title: 'Bob’s title' }, bob));
    const mine = await ok(core.call('claim', { id: claimed }, ctx));
    const theirs = await ok(bobCore.call('claim', { id: claimed }, bob));
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const seen = await ok(core.call('attention', {}, dashboard(ctx)));

    expect(seen.items.map((item) => item.kind)).toEqual(['field_conflict', 'open_attempts']);
    expect(seen.items[0]).toEqual({ kind: 'field_conflict', issue: titled, title: expect.any(String), fields: ['title'] });
    expect(seen.items[1]).toMatchObject({ kind: 'open_attempts', issue: claimed, title: 'Claimed twice' });
    const pair = seen.items[1]!.kind === 'open_attempts' ? seen.items[1]!.attempts.map((a) => a.attempt).sort() : [];
    expect(pair).toEqual([mine.attempt, theirs.attempt].sort());
    expect(seen.counts).toMatchObject({ conflicts: 2, claimed: 1 });
  });

  test('an id collision is an item listing both records and the `grimoire resolve` command; resolving it removes the item', async ({ grimoire, world }) => {
    const aliceCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const bobCore = grimoire.makeCore({ randomIdSuffix: suffixQueue('k1m0x') });
    const alice = grimoire.ctx;
    const bob = agentContext(world.b);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await create(aliceCore, alice, 'Alice’s k1m0x');
    await create(bobCore, bob, 'Bob’s k1m0x');
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const seen = await ok(grimoire.core.call('attention', {}, dashboard(alice)));
    const item = seen.items[0];
    const sides = item?.kind === 'id_collision' ? item.sides : [];
    await ok(grimoire.core.call('resolve', { id: 'gr-k1m0x', keep: sides[0]!.id }, dashboard(alice)));
    const after = await ok(grimoire.core.call('attention', {}, dashboard(alice)));

    expect(seen.items).toHaveLength(1);
    expect(item).toMatchObject({ kind: 'id_collision', id: 'gr-k1m0x' });
    expect(sides.map((side) => side.title).sort()).toEqual(['Alice’s k1m0x', 'Bob’s k1m0x']);
    expect(sides.every((side) => /^gr-k1m0x~[0-9a-f]{4}$/.test(side.id))).toBe(true);
    expect(item?.kind === 'id_collision' ? item.command : '').toBe('grimoire resolve gr-k1m0x --keep <gr-k1m0x~hash4>');
    expect(after.items).toEqual([]);
  });

  test('a rejected push is an item with the remote’s message and the fix, until a sync settles', async ({ grimoire, world }) => {
    const { core, ctx } = grimoire;
    await create(core, ctx, 'Something to push');
    const hook = path.join(world.remote, 'hooks', 'pre-receive');
    await writeFile(hook, REJECTING_HOOK, { mode: 0o755 });
    await ok(core.call('sync', {}, ctx));

    const seen = await ok(core.call('attention', {}, dashboard(ctx)));
    await writeFile(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await ok(core.call('sync', {}, ctx));
    const after = await ok(core.call('attention', {}, dashboard(ctx)));

    expect(seen.items).toMatchObject([{ kind: 'sync_failure', class: 'rejected', remote: 'origin', client: 'claude-code', surface: 'mcp' }]);
    const item = seen.items[0]!;
    expect(item.kind === 'sync_failure' && item.message).toContain('GH013: Repository rule violations found for refs/heads/grimoire/tracker.');
    expect(item.kind === 'sync_failure' && item.fix).toContain('grimoire/tracker');
    expect(after.items).toEqual([]);
  });

  test('a stray edit waiting on this machine is an item with what Record and Discard need; discarding it removes the item', async ({ grimoire, world }) => {
    const { core, ctx } = grimoire;
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const saved = await setAsideStrayEdit(store, {
      skill: 'webhook-retries',
      worktree: world.a.dir,
      path: '.claude/skills/grimoire-webhook-retries/SKILL.md',
      text: 'Retry with backoff.\n',
      base: null,
      served: null,
    });

    const seen = await ok(core.call('attention', {}, dashboard(ctx)));
    await ok(core.call('skill_discard', { stray: saved.id }, dashboard(ctx)));
    const after = await ok(core.call('attention', {}, dashboard(ctx)));

    expect(seen.items).toMatchObject([
      { kind: 'stray_edit', stray: { id: saved.id, skill: 'webhook-retries', text: 'Retry with backoff.\n', path: '.claude/skills/grimoire-webhook-retries/SKILL.md' } },
    ]);
    expect(after.items).toEqual([]);
  });

  test('a section that can’t be read is named as unreadable, never hidden behind an empty queue; the rest of the queue still shows', async ({ grimoire, world }) => {
    const { core, ctx } = grimoire;
    await ok(core.call('skill_edit', { name: 'webhook-retries', text: skillText('webhook-retries', 'Retrying webhooks.', 'Retry with backoff.\n'), base: null }, terminal(ctx)));
    await setAsideStrayEdit(new MachineLocalStore(path.join(world.a.dir, '.git')), {
      skill: 'webhook-retries',
      worktree: world.a.dir,
      path: '.claude/skills/grimoire-webhook-retries/SKILL.md',
      text: 'Retry twice.\n',
      base: null,
      served: null,
    });
    const id = await create(core, ctx, 'Forgotten');
    await ok(core.call('claim', { id }, ctx));
    // The skill book can't be read: both the stray edits and the knowledge items depend on it.
    const broken = grimoire.makeCore({
      clock: () => new Date(T0.getTime() + 25 * HOUR),
      scanner: {
        scan: () => {
          throw new Error('the scanner broke');
        },
        redact: () => {
          throw new Error('the scanner broke');
        },
      },
    });

    const seen = await ok(broken.call('attention', {}, dashboard(ctx)));

    expect(seen.items.map((item) => item.kind)).toEqual(['stale_claim']);
    expect(seen.unreadable).toEqual([
      { section: 'knowledge', code: 'INTERNAL', message: expect.stringContaining('the scanner broke') },
      { section: 'stray_edits', code: 'INTERNAL', message: expect.stringContaining('the scanner broke') },
    ]);
    // A quiet, readable queue says so.
    expect((await ok(core.call('attention', {}, dashboard(ctx)))).unreadable).toEqual([]);
  });

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    const refused = await grimoire.core.call('attention', {}, grimoire.ctx);
    expect(refused).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
  });
});
