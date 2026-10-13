// Seam 1, slow (it kills a real process tree): a client that hangs past the
// kill timeout (spec §16 Spawn: 15 min, here shortened) is killed with every
// process it started, and the run ends failed, consuming nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { trackPidFile } from '#harness';
import { isPidAlive } from '../../src/machine-local/process-info';
import { runChores } from '../../src/runner';
import { openTracker } from '../../src/tracker';
import { coreTest as test } from '../core/support';
import { dueCompile, enabled, noPatternAnswer } from './scenario';
import { authStatus, claudeAnswer } from './support';

describe('the runner: the kill timeout', () => {
  test('a client that hangs is killed, tree and all, and the run fails consuming nothing', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [{ ...claudeAnswer(noPatternAnswer(d.pairs)), sleepMs: 120_000 }] });
    const pidFile = path.join(fake.bin, 'claude.pid');
    trackPidFile(pidFile);

    const report = await runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true, timeoutMs: 3_000 });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'failed', spawns: 1, reasons: ['child_timed_out'] })]);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // The script the stand-in started is gone too (taskkill /T on Windows).
    for (let i = 0; i < 50 && isPidAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isPidAlive(pid)).toBe(false);
    const tracker = await openTracker(world.a.dir);
    try {
      expect(await (await tracker.read()).choreRuns.records()).toEqual([]);
    } finally {
      await tracker.close();
    }
  });
});
