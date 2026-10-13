// Late session records at fold (spec §14 Pending session records, Late
// records; §4 Fold rules; §6 capture doctor stats): a record cut before the
// attempt's end that arrives through a fold is admitted, replacing the
// placeholder or a shorter record, without editing `end.md`; one cut after the
// end is dropped, and counted in this machine's doctor stats. Seam 1, two clones.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { sessionKey } from '../../src/capture/seen-here';
import { CAPTURE_STATS, LATE_CUT_DROPS } from '../../src/tracker';
import type { GitWorld } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import { openTracker } from '../../src/tracker';
import { agentContext, commitToTracker, fetchTracker, pushTracker, trackerFile, trackerTip } from './support';
import { attemptDir, CLAUDE_SESSION, claimed, created, sessionRecords, test, person } from './capture-support';

const KEY = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: 'main', nonce: 'nonce-claude' });

/** A good record of the claiming context, cut at `cutAt`, reaching `reach`, with excerpt text. */
function cutRecord(cutAt: string, reach: { at: string; ref: string }): string {
  return [
    '---',
    'client: "claude-code"',
    'client_version: "2.1.296"',
    'reader_version: 1',
    `session: "${CLAUDE_SESSION}"`,
    'context: "main"',
    'source: "hint"',
    'window_start: {"at":"2026-10-11T03:27:15.900Z","ref":"a"}',
    `window_end: ${JSON.stringify(reach)}`,
    'steps: 1',
    'steps_kept: 1',
    'characters: 24',
    'excerpt: "cut"',
    'excerpt_notes: []',
    'facts: "scanned"',
    'skills_read: []',
    'commits: []',
    `reach: ${JSON.stringify(reach)}`,
    `cut_at: ${JSON.stringify(cutAt)}`,
    'roots: []',
    '---',
    'user:\n | an earlier excerpt\n',
  ].join('\n');
}

const fold = async (dir: string) => {
  const tracker = await openTracker(dir);
  try {
    return await tracker.fold({ author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'human', client: 'cli', nonce: 'n' } });
  } finally {
    await tracker.close();
  }
};

describe('late session records', () => {
  /**
   * Alice's agent claims on clone a (pushed); clone a attaches a record cut at
   * `cutAt`; on clone b, Alice closes the attempt at 03:27:30 (b has no row for
   * the context: its seal writes a not_found placeholder) and pushes; clone a
   * fetches and commits the fold. Returns what clone a holds.
   */
  async function closedElsewhere(
    { world, grimoire, capture }: { world: GitWorld; grimoire: { ctx: CallContext }; capture: { core: Core; at: (iso: string) => void } },
    cutAt: string,
  ) {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Two clones');
    const attempt = await claimed(core, grimoire.ctx, id);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await commitToTracker(world.a, { [`${attemptDir(id, attempt)}/sessions/${KEY}.md`]: cutRecord(cutAt, { at: '2026-10-11T03:27:22.000Z', ref: 'u' }) });
    capture.at('2026-10-11T03:27:30.000Z');
    // Alice herself, at her terminal on clone b.
    const onB = person(agentContext(world.a, world.b));
    expect(await core.call('close', { id, reason: 'done', attempt }, onB)).toMatchObject({ ok: true });
    const [placeholder] = await sessionRecords(world.b, id, attempt);
    expect(placeholder!.fields).toMatchObject({ excerpt: 'not_found', reach: null });
    const bEnd = await trackerFile(world.b, (await trackerTip(world.b))!, `${attemptDir(id, attempt)}/end.md`);
    await pushTracker(world.b);
    await fetchTracker(world.a);
    expect((await fold(world.a.dir)).commit).not.toBeNull();
    const tip = (await trackerTip(world.a))!;
    return {
      records: await sessionRecords(world.a, id, attempt),
      end: await trackerFile(world.a, tip, `${attemptDir(id, attempt)}/end.md`),
      bEnd,
      stats: await new MachineLocalStore(path.join(world.a.dir, '.git')).records.read<{ count: number }>(CAPTURE_STATS, LATE_CUT_DROPS),
    };
  }

  test('a record cut before the end arrives by fold and replaces the not_found placeholder; end.md is untouched', async ({ world, grimoire, capture }) => {
    const { records, end, bEnd, stats } = await closedElsewhere({ world, grimoire, capture }, '2026-10-11T03:27:25.000Z');

    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe(`${KEY}.md`);
    expect(records[0]!.fields).toMatchObject({ excerpt: 'cut', cut_at: '2026-10-11T03:27:25.000Z', reach: { at: '2026-10-11T03:27:22.000Z', ref: 'u' } });
    expect(records[0]!.body).toBe('user:\n | an earlier excerpt\n');
    expect(end).toBe(bEnd);
    expect(stats).toBeUndefined();
  });

  test('a record cut after the end is dropped: the placeholder stays, and the drop is counted in this machine’s doctor stats', async ({ world, grimoire, capture }) => {
    const { records, end, bEnd, stats } = await closedElsewhere({ world, grimoire, capture }, '2026-10-11T03:27:40.000Z');

    expect(records).toHaveLength(1);
    expect(records[0]!.fields).toMatchObject({ excerpt: 'not_found', reach: null });
    expect(records[0]!.body).toBe('');
    expect(end).toBe(bEnd);
    expect(stats).toMatchObject({ count: 1 });
  });
});
