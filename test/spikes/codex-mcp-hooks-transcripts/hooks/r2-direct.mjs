// node r2-direct.mjs <repo> <pwsh.exe>
// Runs the Codex hook string under each shell with the argv shape Codex 0.162.1
// builds (hooks/src/engine/command_runner.rs build_command + core/src/shell.rs):
//   PowerShell: [shell, "-NoProfile", "-Command", cmd]   (standard quoting)
//   cmd:        cmd.exe /c "<cmd>"                        (raw_arg, verbatim)
//   sh:         [sh, "-c", cmd]                           (Unix Codex)
// then reads the launcher's log to check what node received.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const [repo, pwsh] = process.argv.slice(2);
if (repo === undefined || pwsh === undefined) {
  console.error('usage: node r2-direct.mjs <repo> <pwsh.exe>');
  process.exit(2);
}
const bootstrap = readFileSync(path.join(here, 'bootstrap.txt'), 'utf8');
const expectedSha = crypto.createHash('sha256').update(bootstrap).digest('hex');
const payload = JSON.stringify({ session_id: 'direct', hook_event_name: 'SessionStart', source: 'startup' });
const log = path.join(repo, '.git', 'grimoire', 'hook-log.jsonl');

const variants = { plain: `node -e "${bootstrap}" hook session-start`, dashdash: `node -e "${bootstrap}" -- hook session-start` };
/** @type {Record<string, (cmd: string) => { file: string, args: string[], verbatim?: boolean }>} */
const shells = {
  'powershell-5.1': (cmd) => ({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoProfile', '-Command', cmd] }),
  'pwsh-7': (cmd) => ({ file: pwsh, args: ['-NoProfile', '-Command', cmd] }),
  'cmd': (cmd) => ({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', `"${cmd}"`], verbatim: true }),
  'sh': (cmd) => ({ file: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', args: ['-c', cmd] }),
};

const results = [];
for (const [shellName, make] of Object.entries(shells)) {
  for (const [variantName, cmd] of Object.entries(variants)) {
    const tag = `${shellName}/${variantName}`;
    const { file, args, verbatim } = make(cmd);
    const before = safeRead(log).length;
    const r = spawnSync(file, args, {
      cwd: repo,
      input: payload,
      encoding: 'utf8',
      windowsVerbatimArguments: Boolean(verbatim),
      env: { ...process.env, GRIMOIRE_PROBE_TAG: tag },
      timeout: 30000,
    });
    const added = safeRead(log).slice(before).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const entry = added.find((e) => e.tag === tag);
    results.push({
      tag,
      exit: r.status,
      stdout: (r.stdout ?? '').trim(),
      stderr: (r.stderr ?? '').trim().slice(0, 300),
      ran: Boolean(entry),
      args: entry?.args ?? null,
      bootstrapIntact: entry ? entry.bootstrapSha256 === expectedSha : null,
      stdinIntact: entry ? entry.stdin === payload : null,
      parent: entry?.parent ?? null,
    });
  }
}
console.log(JSON.stringify(results, null, 1));

/** @param {string} p */
function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
