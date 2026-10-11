// Spike E (GOK-130), R4: run by Codex's exec_command, this spawns a detached
// child the way `sync --background` would (detached, stdio ignored, unref) and
// exits at once. The child logs to <marker> when it starts and again after
// <delay-ms>, so the log shows whether it outlived the command and Codex.
//
//   node r4-spawn.cjs <marker> [delay-ms]          (parent)
//   node r4-spawn.cjs --child <marker> <delay-ms>  (child, spawned by the parent)
const fs = require('fs');
const spawn = require('child_process').spawn;

const log = (/** @type {string} */ marker, /** @type {string} */ what) =>
  fs.appendFileSync(marker, `${JSON.stringify({ what, pid: process.pid, at: new Date().toISOString() })}\n`);

if (process.argv[2] === '--child') {
  const marker = process.argv[3] ?? 'r4-marker.jsonl';
  log(marker, 'child started');
  setTimeout(() => log(marker, 'child finished'), Number(process.argv[4] ?? 8000));
} else {
  const marker = process.argv[2] ?? 'r4-marker.jsonl';
  const child = spawn(process.execPath, [__filename, '--child', marker, process.argv[3] ?? '8000'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(marker, `parent spawned ${child.pid} and exits`);
}
