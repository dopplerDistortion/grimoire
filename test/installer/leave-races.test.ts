// Leave and the processes it can't stop (spec §21 Leave: it refuses while live
// grimoire processes run in the clone; §9: an error means nothing changed).
// Seam 1, as leave.test.ts: leave run against real clones with the person's
// answers scripted. A process "elsewhere" is a record registered from another
// host, which this machine can't check and so counts as live.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { GENERATED_GITIGNORE } from '../../src/generated';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { coreTest as test, fetchTracker, pushTracker, trackerTip } from '../core/support';
import { existsIn, generatedFolders, NOTES, pinAndCommit } from '../generated/support';
import { joined, leave, serveSkill } from './leave-support';

/** Registers a live `mcp` server for the clone at `commonDir`, from a host this machine can't check. */
async function serverElsewhere(commonDir: string): Promise<void> {
  const elsewhere = new MachineLocalStore(commonDir, null, { host: 'elsewhere' });
  await elsewhere.processes.register({ role: 'mcp', client: 'claude', worktree: null, pin: VERSION, pathSource: null, pid: 4242, startTime: 1 });
}

describe('the processes leave refuses for', () => {
  test('a process record it can’t read refuses leave as a live process would: nothing changes', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    await pushTracker(world.a);
    // A folder where a record should be: reading it fails with something other than "not there".
    await mkdir(path.join(store.dir, 'processes', '4242-0123456789abcdef.json'), { recursive: true });

    await expect(leave(world.a.dir, grimoire.ctx, ['leave'])).rejects.toMatchObject({
      code: 'BUSY',
      message: expect.stringMatching(/can’t tell whether grimoire processes run in this clone/),
    });

    expect(existsSync(store.dir)).toBe(true);
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(true);
  });

  test('a process that starts after the preflight stops leave before the removal: a report of what was committed and pushed, not an error; nothing is removed', async ({
    world,
    grimoire,
  }) => {
    await pinAndCommit(world.a);
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    const asked: string[] = [];
    const prompter = {
      ask: async (question: string) => {
        asked.push(question);
        if (!/Type leave to confirm/.test(question)) return null;
        await serverElsewhere(path.join(world.a.dir, '.git'));
        return 'leave';
      },
    };

    const { report } = await leave(world.a.dir, grimoire.ctx, [], { prompter });

    // Under auto-sync the final sync pushed the skill's commits before the late check.
    expect(report).toMatchObject({ left: false, stopped: 'busy', sync: { pushed: true }, processes: [{ pid: 4242, role: 'mcp', client: 'claude' }] });
    expect(report.problems).toEqual([expect.stringMatching(/grimoire processes still run in this clone: claude mcp \(pid 4242\).*nothing was removed/)]);
    const tip = await trackerTip(world.a);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe(`${tip}\trefs/heads/grimoire/tracker`);
    expect(existsSync(store.dir)).toBe(true);
    for (const folder of generatedFolders('release-notes')) expect(await existsIn(world.a, folder), folder).toBe(true);
    expect(report.removed.tracker_ref).toBeNull();
  });

  test('what a process recreates while the removal runs is reported as a problem, with what to do', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const store = await joined(world.a);
    await serveSkill(grimoire.makeCore(), grimoire.ctx);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const copy = path.join(world.a.dir, '.grimoire', 'skills', 'release-notes');

    const { report } = await leave(world.a.dir, grimoire.ctx, ['leave'], {
      afterRemoval: async () => {
        // A session started mid-removal: its server registers itself, and its hook writes the copy again.
        await serverElsewhere(path.join(world.a.dir, '.git'));
        await mkdir(copy, { recursive: true });
        await writeFile(path.join(copy, '.gitignore'), GENERATED_GITIGNORE);
        await writeFile(path.join(copy, 'SKILL.md'), NOTES);
      },
    });

    expect(report.left).toBe(true);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${store.dir.replace(/[\\.]/g, '\\$&')} came back while leave ran.*claude mcp \\(pid 4242\\).*run leave again`)),
        expect.stringMatching(/generated output came back in .*: \.grimoire\/skills\/release-notes.*run leave again/),
      ]),
    );
  });
});
