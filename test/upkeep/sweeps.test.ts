// One sweep at a time per live store (spec §14 Sweeps, §13 How it runs): two
// processes starting together sweep once between them, under the part's
// lease and its clone-wide stamp, and the open attempt gets one capture
// commit. Seam 1, with real separate processes.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { runCommand } from '#harness';
import type { UpkeepReport } from '../../src/upkeep';
import { trackerTip, TRACKER_REF } from '../core/support';
import { claimed, created, sessionRecords, test } from '../core/capture-support';
import { bundleScript } from './support';

let child: Awaited<ReturnType<typeof bundleScript>> | undefined;
beforeAll(async () => {
  child = await bundleScript('sweep-child.ts');
});
afterAll(() => child?.cleanup());

describe('concurrent sweeps', () => {
  test('two processes starting together produce one sweep and one capture commit', async ({ world, grimoire, capture }) => {
    const id = await created(capture.core, grimoire.ctx, 'Swept once');
    const attempt = await claimed(capture.core, grimoire.ctx, id);
    const before = (await trackerTip(world.a))!;
    const goAt = Date.now() + 1_500;
    const args = JSON.stringify({ root: world.a.dir, goAt, capture: capture.options, clock: '2026-10-11T04:00:00.000Z' });

    const results = await Promise.all([0, 1].map(() => runCommand(process.execPath, [child!.script, args], { timeoutMs: 60_000 })));

    const statuses = results.map((result) => {
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as UpkeepReport;
      return report.runs.find((run) => run.part === 'excerpt-sweep')!.status;
    });
    expect(statuses.filter((status) => status === 'ran')).toHaveLength(1);
    expect(statuses.every((status) => ['ran', 'held', 'throttled'].includes(status))).toBe(true);
    expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    expect(await sessionRecords(world.a, id, attempt)).toHaveLength(1);
  });
});
