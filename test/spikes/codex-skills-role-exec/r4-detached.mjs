// Spike F (GOK-131) R4 (Codex half): does a detached child, spawned the way
// `grimoire sync --background` spawns it, survive after Codex's shell command
// returns and after `codex exec` itself exits?
//
//   node r4-detached.mjs <scratch-dir> <full|workspace|mxc|unelevated> [<ms the parent lingers>]
//     full       -s danger-full-access (no sandbox)
//     workspace  -s workspace-write (the trusted-project default)
//     mxc        -s workspace-write with -c features.prefer_mxc=true
//     unelevated -s workspace-write with -c windows.sandbox="unelevated"
//
// The shell command starts `node bg-parent.cjs`, which spawns `bg-child.cjs`
// detached (detached: true, stdio: 'ignore', windowsHide: true, unref) and
// exits at once. The child tries a write under .git/grimoire/, writes
// started.json (with that outcome), sleeps 8 s, then writes
// finished.json. The script waits 15 s after Codex exits and looks.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, mkRepo, plan, readRequests, runCodex, sleep, startMock, writeFile, writeHome } from './kit.mjs';

const [scratchArg = '.', variant = 'full', lingerMs = '0'] = process.argv.slice(2);
const R = path.join(path.resolve(scratchArg), 'runs', `r4-${variant}${lingerMs === '0' ? '' : `-linger${lingerMs}`}`);
rmSync(R, { recursive: true, force: true });
const W = mkRepo(path.join(R, 'work'));
const home = path.join(R, 'home');
// Marks go to the workspace root; the child also tries a write under
// <git-common-dir>/grimoire/, where grimoire writes, and records the outcome.
const marks = path.join(W, 'r4-marks');

writeFile(
  path.join(W, 'bg-child.cjs'),
  `const fs = require('fs'), p = require('path');
const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });
let gitWrite = 'ok';
try { fs.mkdirSync(p.join(__dirname, '.git', 'grimoire'), { recursive: true }); fs.writeFileSync(p.join(__dirname, '.git', 'grimoire', 'r4-probe.txt'), 'x'); } catch (e) { gitWrite = e.code || String(e); }
fs.writeFileSync(p.join(dir, 'started.json'), JSON.stringify({ pid: process.pid, ppid: process.ppid, at: new Date().toISOString(), gitWrite }));
setTimeout(() => {
  fs.writeFileSync(p.join(dir, 'finished.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}, 8000);
`,
);
writeFile(
  path.join(W, 'bg-parent.cjs'),
  `const { spawn } = require('child_process'), p = require('path');
const fs = require('fs');
fs.mkdirSync(process.argv[2], { recursive: true });
fs.writeFileSync(p.join(process.argv[2], 'parent.json'), JSON.stringify({ pid: process.pid }));
const child = spawn(process.execPath, [p.join(__dirname, 'bg-child.cjs'), process.argv[2]], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
console.log('spawned detached child ' + child.pid);
// Optionally linger, to tell "never started" from "killed when the command ended".
setTimeout(() => {}, Number(process.argv[3] || 0));
`,
);
git(W, 'add', '.');
git(W, '-c', 'user.email=a@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'setup');

const mock = await startMock(path.join(R, 'mock'));
writeHome(home, mock.port, { trust: [W] });
const steps = [{ call: 'exec_command', args: { cmd: `node bg-parent.cjs "${marks}" ${lingerMs}` } }, { say: 'spawned' }];
const sandbox = variant === 'full' ? ['-s', 'danger-full-access'] : ['-s', 'workspace-write'];
const extra = variant === 'mxc' ? ['-c', 'features.prefer_mxc=true'] : variant === 'unelevated' ? ['-c', 'windows.sandbox="unelevated"'] : [];
const result = await runCodex(['exec', '--json', ...sandbox, ...extra, '--skip-git-repo-check', plan(steps)], { cwd: W, home });
const exitedAt = new Date().toISOString();
mock.stop();
writeFileSync(path.join(R, 'stdout.jsonl'), result.stdout);
writeFileSync(path.join(R, 'stderr.txt'), result.stderr);
const output = readRequests(path.join(R, 'mock'))
  .flatMap((r) => r.body?.input ?? [])
  .filter((i) => i.type === 'function_call_output')
  .map((i) => String(i.output))
  .at(-1);
const startedEarly = existsSync(path.join(marks, 'started.json'));
await sleep(15_000);
/** @param {string} f */
const read = (f) => (existsSync(path.join(marks, f)) ? JSON.parse(readFileSync(path.join(marks, f), 'utf8')) : null);
console.log(
  JSON.stringify(
    { variant, code: result.code, codexMs: result.ms, exitedAt, startedWhenCodexExited: startedEarly, started: read('started.json'), finished: read('finished.json'), parent: read('parent.json'), toolOutput: output },
    null,
    1,
  ),
);
