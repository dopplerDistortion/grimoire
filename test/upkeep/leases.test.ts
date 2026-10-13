// Upkeep's leases and throttles (spec §13 How it runs): every part takes a
// non-blocking, expiring machine-local lease and skips while it is held; a
// clone-wide part runs at most once per its interval across the clone, and
// the per-worktree part at most once per 5 min per worktree unless forced.
// Two processes starting together run each part exactly once. Seam 1, with
// real separate processes.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, runCommand } from '#harness';
import { MachineLocalStore } from '../../src/machine-local';
import { partLeaseName, runUpkeep, worktreeLeaseName, type PartRun, type UpkeepReport } from '../../src/upkeep';
import { instructionRulesText } from '../../src/installer/texts';
import { bundleScript, installed, read } from './support';

let child: Awaited<ReturnType<typeof bundleScript>> | undefined;
beforeAll(async () => {
  child = await bundleScript('upkeep-child.ts');
});
afterAll(() => child?.cleanup());

/** Runs one upkeep pass in each of `count` separate processes, all starting at once. */
async function passesTogether(root: string, count: number): Promise<UpkeepReport[]> {
  const goAt = Date.now() + 1_500;
  const results = await Promise.all(
    Array.from({ length: count }, () => runCommand(process.execPath, [child!.script, JSON.stringify({ root, goAt })], { timeoutMs: 60_000 })),
  );
  return results.map((result) => {
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as UpkeepReport;
  });
}

/** Each part's status in one pass, by name: parts later releases add don't change what a test asserts. */
function byPart(report: UpkeepReport): Record<string, PartRun['status']> {
  return Object.fromEntries(report.runs.map((run) => [run.part, run.status]));
}

function statusesOf(reports: readonly UpkeepReport[], part: string): PartRun['status'][] {
  return reports.flatMap((report) => report.runs.filter((run) => run.part === part).map((run) => run.status)).sort();
}

describe('leases and throttles', () => {
  gitTest('two processes starting together run each part exactly once', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');

    const reports = await passesTogether(root, 2);

    for (const part of ['pending-sync', 'prune-copies', 'pointer-refresh']) {
      const statuses = statusesOf(reports, part);
      expect(statuses.filter((status) => status === 'ran'), part).toHaveLength(1);
      expect(statuses, part).toHaveLength(2);
      expect(statuses.every((status) => ['ran', 'held', 'throttled'].includes(status)), part).toBe(true);
    }
    expect(reports.flatMap((report) => report.notices).filter((line) => line.includes('refreshed'))).toEqual(['grimoire refreshed 1 pointer file: commit it']);
    expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
  });

  gitTest('a pass soon after another is throttled, unless forced', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await runUpkeep({ root });
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');

    const soon = await runUpkeep({ root });

    expect(byPart(soon)).toMatchObject({ 'pending-sync': 'throttled', 'prune-copies': 'throttled', 'pointer-refresh': 'throttled' });
    expect(await read(root, '.claude/rules/grimoire.md')).toBe('drifted\n');

    const forced = await runUpkeep({ root, force: true });

    expect(byPart(forced)).toMatchObject({ 'pending-sync': 'ran', 'prune-copies': 'ran', 'pointer-refresh': 'ran' });
    expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
  });
});
