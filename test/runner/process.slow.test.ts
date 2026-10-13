// Seam 1, slow (it leaves and kills real processes): the runner's spawn
// (spec §16 Spawn: a kill timeout that takes the whole process tree) always
// settles. A client that exits while a process it started still holds its
// pipes settles after a short drain, and on POSIX that process is killed with
// the client's process group; a timeout or an abort kills the whole tree.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeTempDir, trackPidFile } from '#harness';
import { isPidAlive } from '../../src/machine-local/process-info';
import { runProcess } from '../../src/runner/process';

const posix = process.platform !== 'win32';

/**
 * A client that starts a process inheriting its stdout and stderr (it writes
 * its pid to `pidFile` and idles), waits until it runs, writes `answer`, then
 * idles itself (`hang`) or exits 0. On Windows the process is started
 * detached: a Node client's own children otherwise die with it (libuv's job
 * object), and a real client's need not.
 */
function client(pidFile: string, hang: boolean): string[] {
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30);`;
  const script = `
    const { spawn } = require('node:child_process');
    const { existsSync } = require('node:fs');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: process.platform === 'win32' }).unref();
    const wait = setInterval(() => {
      if (!existsSync(${JSON.stringify(pidFile)})) return;
      clearInterval(wait);
      process.stdout.write('answer');
      ${hang ? 'setInterval(() => {}, 1 << 30);' : 'process.exitCode = 0;'}
    }, 20);
  `;
  return ['-e', script];
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && isPidAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  return !isPidAlive(pid);
}

/** The grandchild's pid, once it wrote it. */
async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 300 && !existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return Number(readFileSync(file, 'utf8'));
}

/** Kills what a Windows client left behind after exiting (no longer in its tree), so the leak guard sees it gone. */
function cleanUp(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Gone already.
  }
}

describe('runProcess always settles', () => {
  test('a client that exits while a process it started holds the pipes settles after the drain, with its output; on POSIX that process is killed', async () => {
    const dir = await makeTempDir('grimoire-process-');
    const pidFile = path.join(dir, 'grandchild.pid');
    trackPidFile(pidFile);
    const started = Date.now();
    const run = await runProcess(process.execPath, client(pidFile, false), { cwd: dir, env: process.env, timeoutMs: 40_000, drainMs: 500 });
    const pid = await pidIn(pidFile);
    try {
      expect(run).toMatchObject({ code: 0, stdout: 'answer', timedOut: false });
      expect(Date.now() - started).toBeLessThan(20_000);
      if (posix) expect(await gone(pid)).toBe(true);
    } finally {
      if (!posix) cleanUp(pid);
    }
  });

  test('a timeout kills the client and every process it started, and settles', async () => {
    const dir = await makeTempDir('grimoire-process-');
    const pidFile = path.join(dir, 'grandchild.pid');
    trackPidFile(pidFile);
    const run = await runProcess(process.execPath, client(pidFile, true), { cwd: dir, env: process.env, timeoutMs: 3_000, drainMs: 500 });
    expect(run).toMatchObject({ code: null, timedOut: true });
    expect(await gone(await pidIn(pidFile))).toBe(true);
  });

  test('an abort kills the client and every process it started, and settles at once', async () => {
    const dir = await makeTempDir('grimoire-process-');
    const pidFile = path.join(dir, 'grandchild.pid');
    trackPidFile(pidFile);
    const controller = new AbortController();
    const running = runProcess(process.execPath, client(pidFile, true), { cwd: dir, env: process.env, timeoutMs: 40_000, drainMs: 500, signal: controller.signal });
    const pid = await pidIn(pidFile);
    const at = Date.now();
    controller.abort();
    const run = await running;
    expect(run).toMatchObject({ code: null, timedOut: false, aborted: true });
    expect(Date.now() - at).toBeLessThan(10_000);
    expect(await gone(pid)).toBe(true);
  });
});
