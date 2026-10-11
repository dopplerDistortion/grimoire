// Spike D (GOK-129) throwaway probe: spawn claude.exe the way the runner would.
// Usage: node probe-claude.mjs <case-name> out/<case-name>.cfg.json  (writes out/<case>.record.json and .stdout.txt)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [caseName, configPath] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const outDir = cfg.outDir;

const env = { ...process.env };
if (cfg.env?.stripSession) {
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_AGENT_SDK_VERSION') delete env[k];
  }
}
for (const k of cfg.env?.remove ?? []) delete env[k];
Object.assign(env, cfg.env?.set ?? {});

const cwd = mkdtempSync(join(tmpdir(), 'grimoire-runner-'));
const args = cfg.args.map((a) => a.replaceAll('{CWD}', cwd));
const started = Date.now();
const child = spawn(cfg.bin, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
const killer = setTimeout(() => child.kill(), 15 * 60 * 1000);
if (cfg.stdinFile) child.stdin.end(readFileSync(cfg.stdinFile));
else child.stdin.end();
child.on('close', (code, signal) => {
  clearTimeout(killer);
  const leftovers = readdirSync(cwd);
  rmSync(cwd, { recursive: true, force: true });
  const envKeysPassed = Object.keys(env).filter((k) => /claude|anthropic/i.test(k)).sort();
  const record = { caseName, bin: cfg.bin, args, envKeysPassed, envSet: cfg.env?.set ?? {}, cwdLeftovers: leftovers, exitCode: code, signal, durationMs: Date.now() - started, stdout, stderr };
  writeFileSync(join(outDir, `${caseName}.record.json`), JSON.stringify(record, null, 2));
  writeFileSync(join(outDir, `${caseName}.stdout.txt`), stdout);
  console.log(JSON.stringify({ caseName, exitCode: code, durationMs: record.durationMs, stderr: stderr.slice(0, 500), stdoutHead: stdout.slice(0, 1500) }, null, 2));
});
