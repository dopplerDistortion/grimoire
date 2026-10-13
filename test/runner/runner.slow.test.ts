// Seam 1, slow (it kills a real process tree): a client that hangs past the
// kill timeout (spec §16 Spawn: 15 min, here shortened) is killed with every
// process it started, and the run ends failed, consuming nothing.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { trackPidFile } from '#harness';
import { isPidAlive } from '../../src/machine-local/process-info';
import { capState, runChores, storeAt } from '../../src/runner';
import { openTracker } from '../../src/tracker';
import { coreTest as test } from '../core/support';
import { dueCompile, enabled, expectError, noPatternAnswer } from './scenario';
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

  test('stopping the runner (start stopping, Ctrl-C) kills the client, tree and all, at once, abandons the run consuming nothing, frees the lock, and counts no failure', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const store = await storeAt(world.a.dir);
    // One failure already: a stop counted as a second would pause the runner for 6 h.
    await store.coordination.update('runner', 'counters', () => ({ runs: [], consecutive_failures: 1, paused_until: null, last: null }));
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai'), answers: [{ ...claudeAnswer(noPatternAnswer(d.pairs)), sleepMs: 120_000 }] });
    const pidFile = path.join(fake.bin, 'claude.pid');
    trackPidFile(pidFile);
    const stopping = new AbortController();

    const running = expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true, signal: stopping.signal }));
    for (let i = 0; i < 600 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    stopping.abort();
    const error = await running;

    expect(error.code).toBe('BUSY');
    for (let i = 0; i < 50 && isPidAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isPidAlive(pid)).toBe(false);
    const caps = await capState(store, d.clock.now());
    expect([caps.consecutive_failures, caps.paused_until]).toEqual([1, null]);
    const again = await store.locks.acquire('runner', { waitMs: 0 });
    expect(again.status).toBe('acquired');
    if (again.status === 'acquired') await again.lock.release();
    // The run was abandoned: nothing consumed.
    const tracker = await openTracker(world.a.dir);
    try {
      expect(await (await tracker.read()).choreRuns.records()).toEqual([]);
    } finally {
      await tracker.close();
    }
  });
});
