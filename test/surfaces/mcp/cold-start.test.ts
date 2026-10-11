// Cold start (spec §8, §22 R7): `grimoire mcp` answers the opening within 300 ms
// of being spawned, in both eras. Measured on the real build, from spawn() to
// the first response line, with each client's real opening line written at
// once. It runs in the acceptance group, with the machine to itself.
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, readFixture, removeDir } from '#harness';
import { buildGrimoire } from './support';

const BUDGET_MS = 300;
const RUNS = 9;

let bin: string;
let cleanup: () => Promise<void>;
let cwd: string;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
  // Not a repository: answering the opening must not depend on one.
  cwd = await makeTempDir('grimoire-cold-start-');
});
afterAll(async () => {
  await cleanup();
  await removeDir(cwd);
});

/**
 * Milliseconds from spawn to the first line on stdout, after writing `opening`.
 * Resolves only once that server has exited (outside the timed window), so no
 * sample overlaps the previous one's shutdown.
 */
function timeToFirstLine(opening: string): Promise<{ ms: number; line: string }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [bin, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let first: { ms: number; line: string } | null = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(first ? 'the server did not exit' : 'no response to the opening'));
    }, 30_000);
    child.once('close', () => {
      clearTimeout(timer);
      if (first) resolve(first);
      else reject(new Error('the server exited without answering the opening'));
    });
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (first) return;
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      first = { ms: performance.now() - started, line: buffered.slice(0, newline) };
      child.stdin.end();
    });
    child.on('error', reject);
    child.stdin.write(`${opening}\n`);
  });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe('cold start', () => {
  const openings = {
    "Codex's 2025-06-18 initialize": readFixture('codex/mcp/handshake/c2s.jsonl').split('\n')[0]!,
    "Claude Code's 2026-07-28 server/discover": readFixture('claude-code/mcp/session-hint-hook/c2s.jsonl').split('\n')[0]!,
  };

  for (const [name, opening] of Object.entries(openings)) {
    it(`answers ${name} within ${BUDGET_MS} ms (median of ${RUNS} spawns)`, async () => {
      await timeToFirstLine(opening); // warms the file cache, as a client's second session would find it
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const { ms, line } = await timeToFirstLine(opening);
        expect(JSON.parse(line)).toMatchObject({ id: JSON.parse(opening).id, result: expect.any(Object) });
        samples.push(ms);
      }

      process.stdout.write(`cold start, ${name}: median ${median(samples).toFixed(0)} ms, max ${Math.max(...samples).toFixed(0)} ms\n`);
      expect(median(samples)).toBeLessThanOrEqual(BUDGET_MS);
    });
  }
});
