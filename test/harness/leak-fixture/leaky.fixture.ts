// Run only by test/harness/children.slow.test.ts, through vitest.config.ts beside it: each test leaves a
// process running in its own way, and the leak guard must fail it, kill the process, and leave the rest alone.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { test } from 'vitest';
import { trackPidFile } from '#harness';

const report = process.env.LEAK_FIXTURE_REPORT!;
const keepAlive = ['-e', 'setInterval(() => {}, 1 << 30)'];

test('a child left running', () => {
  const child = spawn(process.execPath, keepAlive, { stdio: 'ignore', windowsHide: true });
  appendFileSync(report, `child ${child.pid} ${Date.now()}\n`);
});

test('a process that is no one’s child, named in a pid file', async () => {
  const pidFile = `${report}.pids`;
  trackPidFile(pidFile);
  // A parent that starts a detached keeper, writes its pid, and exits at once.
  const script = `const k = require('node:child_process').spawn(process.execPath, ${JSON.stringify(keepAlive)}, { stdio: 'ignore', detached: true, windowsHide: true }); require('node:fs').appendFileSync(process.argv[1], k.pid + ' ' + Date.now() + String.fromCharCode(10)); k.unref();`;
  const parent = spawn(process.execPath, ['-e', script, pidFile], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => parent.once('exit', resolve));
  appendFileSync(report, `orphan-file ${pidFile}\n`);
});

test('a child that exits once told to', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  appendFileSync(report, `polite ${child.pid}\n`);
  child.stdin.end();
});
