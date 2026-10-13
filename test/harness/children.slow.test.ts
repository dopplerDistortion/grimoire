// The process-leak guard (children.ts), end to end: Vitest runs a fixture file
// whose tests each leave a process running, in its own child process with the
// harness's setup file. Every leaking test must fail naming what it left, and
// what it left must be gone; a test whose child exits once told to passes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';
import { isPidAlive, processStartTimes } from '../../src/machine-local/process-info';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const config = fileURLToPath(new URL('./leak-fixture/vitest.config.ts', import.meta.url));

interface JsonReport {
  testResults: { assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
}

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('grimoire-leak-');
});
afterEach(() => removeDir(dir));

describe('the process-leak guard', () => {
  test('fails each test that leaves a process running, kills it, and passes a test whose child exits', { timeout: 120_000 }, async () => {
    const report = path.join(dir, 'report');
    const json = path.join(dir, 'results.json');
    const run = await runCommand(
      process.execPath,
      [path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config, '--reporter=json', `--outputFile=${json}`],
      { cwd: repoRoot, env: { ...process.env, LEAK_FIXTURE_REPORT: report }, timeoutMs: 100_000 },
    );

    expect(run.code, run.stdout + run.stderr).toBe(1);
    const results = (JSON.parse(await readFile(json, 'utf8')) as JsonReport).testResults.flatMap((file) => file.assertionResults);
    const byTitle = new Map(results.map((result) => [result.title, result]));
    expect(byTitle.get('a child left running')).toMatchObject({
      status: 'failed',
      failureMessages: [expect.stringMatching(/left 1 process\(es\) running[\s\S]*setInterval/)],
    });
    expect(byTitle.get('a process that is no one’s child, named in a pid file')).toMatchObject({
      status: 'failed',
      failureMessages: [expect.stringMatching(/left 1 process\(es\) running[\s\S]*\.pids\)/)],
    });
    expect(byTitle.get('a child that exits once told to')).toMatchObject({ status: 'passed' });

    // Both were killed: a live pid counts only while its process started no later than the fixture saw it run.
    const lines = (await readFile(report, 'utf8')).split('\n').filter(Boolean);
    const [, childPid, childAt] = lines.find((line) => line.startsWith('child '))!.split(' ').map(Number);
    const [orphanPid, orphanAt] = (await readFile(`${report}.pids`, 'utf8')).trim().split(' ').map(Number);
    const left = [
      { pid: childPid!, at: childAt! },
      { pid: orphanPid!, at: orphanAt! },
    ].filter(({ pid }) => isPidAlive(pid));
    const started = await processStartTimes(left.map(({ pid }) => pid));
    expect(left.filter(({ pid, at }) => !(started.get(pid)! > at))).toEqual([]);
  });
});
