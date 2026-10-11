// Spike B (GOK-127): runs the installed Claude Code headless against the probe
// server and records the real wire traffic (c2s.jsonl, s2c.jsonl), the hint
// hook's input and output, and Claude's stream-json output.
//
//   node test/spikes/mcp-dual-era/capture-claude.mjs <capture-dir> [--model <m>] [--no-hook]
//
// Needs `claude` on PATH and logged in. The capture directory must not exist yet.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleProbe } from './bundle-probe.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string', default: 'haiku' },
    'no-hook': { type: 'boolean', default: false },
    prompt: { type: 'string' },
  },
});
const [target] = positionals;
if (positionals.length !== 1 || target === undefined) {
  process.stderr.write('usage: node capture-claude.mjs <capture-dir> [--model <m>] [--no-hook]\n');
  process.exit(2);
}
const captureDir = path.resolve(target);
if (existsSync(captureDir)) {
  process.stderr.write(`${captureDir} already exists\n`);
  process.exit(2);
}
mkdirSync(captureDir, { recursive: true });

const work = mkdtempSync(path.join(os.tmpdir(), 'grimoire-claude-probe-'));
const project = path.join(work, 'project');
mkdirSync(project);
const probe = await bundleProbe(work);
const hook = fileURLToPath(new URL('./hint-hook.mjs', import.meta.url));
/** @param {string} p */
const slash = (p) => p.replaceAll('\\', '/');

const mcpConfig = path.join(work, 'mcp.json');
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      probe: {
        command: process.execPath,
        args: [probe],
        env: { GRIMOIRE_PROBE_CAPTURE_DIR: captureDir },
      },
    },
  }),
);

const settings = path.join(work, 'settings.json');
writeFileSync(
  settings,
  JSON.stringify(
    values['no-hook']
      ? {}
      : {
          hooks: {
            PreToolUse: [
              {
                matcher: 'mcp__probe__.*',
                hooks: [
                  {
                    type: 'command',
                    command: `"${slash(process.execPath)}" "${slash(hook)}" "${slash(captureDir)}"`,
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
  ),
);

const prompt =
  values.prompt ??
  [
    'Use the probe MCP server tools, one at a time, in this order:',
    '1. Call echo with text "hello".',
    '2. Call big with rows 1000.',
    '3. Call which with no arguments.',
    'After all three calls, for each call quote verbatim the first 200 characters of exactly what the tool returned to you,',
    'and say whether you received one payload or two (a text block and a separate structured payload).',
  ].join('\n');

const result = spawnSync(
  'claude',
  [
    '-p',
    prompt,
    '--model',
    values.model,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--settings',
    settings,
    '--allowedTools',
    'mcp__probe__echo',
    'mcp__probe__big',
    'mcp__probe__which',
    '--output-format',
    'stream-json',
    '--verbose',
  ],
  { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 300_000 },
);
writeFileSync(path.join(captureDir, 'claude-stream.jsonl'), result.stdout ?? '');
writeFileSync(path.join(captureDir, 'claude-stderr.txt'), result.stderr ?? '');
process.stdout.write(
  `claude exited ${result.status}; capture in ${captureDir}; work dir ${work}\n`,
);
