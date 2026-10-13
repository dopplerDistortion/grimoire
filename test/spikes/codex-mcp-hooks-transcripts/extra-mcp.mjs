// A raw newline-delimited JSON-RPC stdio MCP server (no SDK) with tools that
// spike B's probe lacks: `huge` (an uncut result of N bytes, to find the
// client's own truncation) and `fail` (an isError result with grimoire's error
// envelope). Captures c2s to $EXTRA_CAPTURE_DIR/c2s.jsonl when set.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cap = process.env.EXTRA_CAPTURE_DIR;
if (cap) {
  mkdirSync(cap, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CODEX|GRIMOIRE)/i.test(k)));
  appendFileSync(path.join(cap, 'env.json'), `${JSON.stringify({ pid: process.pid, keys: Object.keys(process.env).sort(), codex: env })}
`);
}
/** @param {unknown} msg */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const tools = [
  {
    name: 'writeish',
    description: 'A write tool annotated the way grimoire annotates writes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'huge',
    description: 'Returns an uncut result of about `bytes` bytes, as structuredContent and a text block.',
    inputSchema: { type: 'object', properties: { bytes: { type: 'integer' } }, required: ['bytes'] },
  },
  {
    name: 'fail',
    description: 'Returns isError: true with an error envelope, as structuredContent and a text block.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'textonly',
    description: 'Returns only a text block (no structuredContent).',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** @param {number} bytes */
function hugeBody(bytes) {
  const rows = [];
  let i = 0;
  let size = 20;
  while (size < bytes) {
    const row = { id: `row-${i}`, n: i, title: `Row ${i}: ${'lorem ipsum '.repeat(12).trim()}` };
    size += JSON.stringify(row).length + 1;
    rows.push(row);
    i++;
  }
  return { rows, truncated: false };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (cap) appendFileSync(path.join(cap, 'c2s.jsonl'), `${line}\n`);
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'extra', version: '0.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    let body;
    let isError = false;
    if (name === 'huge') body = hugeBody(args.bytes ?? 1000);
    else if (name === 'fail') {
      body = { error: { code: 'NOT_FOUND', message: 'no issue gr-zzzzz', retryable: false, details: {} } };
      isError = true;
    } else if (name === 'writeish') {
      body = { ok: true };
    } else if (name === 'textonly') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'plain text only' }] } });
      return;
    }
    const text = JSON.stringify(body);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text }], structuredContent: body, ...(isError && { isError: true }) },
    });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
