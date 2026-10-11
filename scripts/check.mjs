// The local check, the CI equivalent: typecheck, Vitest, both builds, and the
// zero-runtime-dependencies check. Runs every step (each one is the npm script
// of the same name), prints a summary, and exits 1 if any step failed.
//
//   npm run check
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const STEPS = ['typecheck', 'test', 'build', 'check:deps'];

/** @param {string} script */
function runScript(script) {
  // Under `npm run`, npm_execpath is npm's JS entry: run it with this node, no shell.
  const npmCli = process.env.npm_execpath;
  const result =
    npmCli && /\.[cm]?js$/.test(npmCli)
      ? spawnSync(process.execPath, [npmCli, 'run', script], { cwd: repoRoot, stdio: 'inherit' })
      : spawnSync('npm', ['run', script], { cwd: repoRoot, stdio: 'inherit', shell: true });
  return result.status === 0;
}

const results = STEPS.map((step) => {
  process.stdout.write(`\n=== check: ${step} ===\n`);
  const started = Date.now();
  const ok = runScript(step);
  return { step, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) };
});

process.stdout.write('\n=== check: summary ===\n');
for (const { step, ok, seconds } of results) {
  process.stdout.write(`${ok ? 'ok    ' : 'FAILED'}  ${step} (${seconds}s)\n`);
}
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
