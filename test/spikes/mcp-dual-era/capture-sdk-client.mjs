// Spike B (GOK-127): records a 2025-06-18 session from the MCP TypeScript SDK
// client, shaped like Codex's `initialize`, against the probe server: a
// `tools/call` with no `_meta` at all, and one carrying the reserved key.
//
//   node test/spikes/mcp-dual-era/capture-sdk-client.mjs <capture-dir>
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { bundleProbe } from './bundle-probe.mjs';

const captureDir = process.argv[2] && path.resolve(process.argv[2]);
if (!captureDir || existsSync(captureDir)) {
  process.stderr.write('usage: node capture-sdk-client.mjs <capture-dir>  (must not exist yet)\n');
  process.exit(2);
}

const probe = await bundleProbe(mkdtempSync(path.join(os.tmpdir(), 'grimoire-sdk-probe-')));
const client = new Client(
  { name: 'codex-shaped-test-client', version: '0.0.0' },
  { capabilities: { elicitation: {} }, supportedProtocolVersions: ['2025-06-18'] },
);
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [probe],
    env: { ...getDefaultEnvironment(), GRIMOIRE_PROBE_CAPTURE_DIR: captureDir },
  }),
);
await client.listTools();
await client.callTool({ name: 'echo', arguments: { text: 'no meta' } });
await client.callTool({
  name: 'echo',
  arguments: {
    text: 'with the reserved key',
    _grimoire: {
      session_id: '00000000-0000-4000-8000-000000000001',
      transcript_path:
        'C:\\Users\\USER\\.claude\\projects\\C--repo\\00000000-0000-4000-8000-000000000001.jsonl',
      tool_use_id: 'toolu_01ReservedKeyExample00000',
    },
  },
});
await client.close();
process.stdout.write(`captured in ${captureDir}\n`);
