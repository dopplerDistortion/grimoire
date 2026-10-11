// Spike B (GOK-127), R7: cold start of the bundled probe server, from spawn to
// the first response line on stdout, for each era's real opening message
// (Codex's `initialize`, Claude Code's `server/discover`, both from the fixtures).
// A no-op stdio responder gives Node's own floor on this machine.
//
//   node test/spikes/mcp-dual-era/measure-cold-start.mjs [--runs 20] [--node <path>]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleProbe } from './bundle-probe.mjs';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    node: { type: 'string', default: process.execPath },
  },
});
const runs = Number(values.runs);
const node = values.node;

const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url));
/** @param {string} rel */
const firstLine = (rel) => readFileSync(path.join(fixtures, rel), 'utf8').split('\n')[0] + '\n';
const openings = {
  'legacy (Codex initialize)': firstLine('codex/mcp/handshake/c2s.jsonl'),
  'modern (Claude Code server/discover)': firstLine('claude-code/mcp/session-hint-hook/c2s.jsonl'),
};

const work = mkdtempSync(path.join(os.tmpdir(), 'grimoire-cold-start-'));
const floor = path.join(work, 'floor.mjs');
writeFileSync(
  floor,
  "process.stdin.once('data', () => process.stdout.write('{}\\n', () => process.exit(0)));\n",
);
const entries = {
  'node floor (no-op responder)': floor,
  'probe bundle': await bundleProbe(work),
  'probe bundle, minified': await bundleProbe(work, { minify: true }),
};

/**
 * @param {string} entry
 * @param {string} opening
 * @returns {Promise<number>} milliseconds from spawn to the first stdout line
 */
function coldStart(entry, opening) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(node, [entry], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        child.kill();
        resolve(ms);
      }
    });
    child.stdin.write(opening);
  });
}

/** @param {number[]} xs */
function summary(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (/** @type {number} */ q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const f = (/** @type {number | undefined} */ x) => (x ?? NaN).toFixed(0).padStart(4);
  return `min ${f(s[0])}  median ${f(at(0.5))}  p90 ${f(at(0.9))}  max ${f(s.at(-1))}  (ms, n=${s.length})`;
}

process.stdout.write(`node ${node}\n`);
for (const [name, entry] of Object.entries(entries)) {
  process.stdout.write(`\n${name}: ${(statSync(entry).size / 1024).toFixed(0)} KB\n`);
  for (const [era, opening] of Object.entries(openings)) {
    await coldStart(entry, opening); // warm the file cache once
    const times = [];
    for (let i = 0; i < runs; i++) times.push(await coldStart(entry, opening));
    process.stdout.write(`  ${era.padEnd(38)} ${summary(times)}\n`);
  }
}
