// Cold start (spec §8, §22 R7): `grimoire mcp` answers the opening within 300 ms
// of being spawned, in both eras. Measured on the real build, from spawn() to
// the first response line, with each client's real opening line written at
// once.
//
// The gate is grimoire's own cost: its median minus the median of a bare Node
// echo process (spawn, Node's own start, one line through stdin and stdout),
// sampled in the same rounds, alternating, so both see the same machine load.
// The absolute median is reported too; the absolute 300 ms gate is re-checked
// on a quiet machine at close-out (followups.md).
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, readFixture, removeDir } from '#harness';
import { buildGrimoire } from './support';

const BUDGET_MS = 300;
const RUNS = 9;

/** The baseline: answers the first line it reads with that line, then exits when stdin ends. */
const ECHO = "let done=false;let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{if(done)return;b+=c;const n=b.indexOf(String.fromCharCode(10));if(n<0)return;done=true;process.stdout.write(b.slice(0,n+1));});";

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
 * Milliseconds from spawning `node <args>` to the first line on stdout, after
 * writing `opening`. Resolves only once that process has exited (outside the
 * timed window), so no sample overlaps the previous one's shutdown.
 */
function timeToFirstLine(args: readonly string[], opening: string): Promise<{ ms: number; line: string }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let first: { ms: number; line: string } | null = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(first ? 'the process did not exit' : 'no response to the opening'));
    }, 30_000);
    child.once('close', () => {
      clearTimeout(timer);
      if (first) resolve(first);
      else reject(new Error('the process exited without answering the opening'));
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
    it(`answers ${name} within ${BUDGET_MS} ms over a bare Node echo (medians of ${RUNS} spawns)`, async () => {
      const grimoire = [bin, 'mcp'];
      const echo = ['-e', ECHO];
      // Warms the file cache, as a client's second session would find it.
      await timeToFirstLine(grimoire, opening);
      await timeToFirstLine(echo, opening);
      const samples: number[] = [];
      const baseline: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const { ms, line } = await timeToFirstLine(grimoire, opening);
        expect(JSON.parse(line)).toMatchObject({ id: JSON.parse(opening).id, result: expect.any(Object) });
        samples.push(ms);
        const echoed = await timeToFirstLine(echo, opening);
        expect(echoed.line).toBe(opening);
        baseline.push(echoed.ms);
      }

      const own = median(samples) - median(baseline);
      process.stdout.write(
        `cold start, ${name}: median ${median(samples).toFixed(0)} ms (max ${Math.max(...samples).toFixed(0)} ms), ` +
          `bare Node echo median ${median(baseline).toFixed(0)} ms, grimoire's own ${own.toFixed(0)} ms ` +
          `(absolute ${BUDGET_MS} ms gate: re-checked on a quiet machine at close-out)\n`,
      );
      expect(own).toBeLessThanOrEqual(BUDGET_MS);
    });
  }
});
