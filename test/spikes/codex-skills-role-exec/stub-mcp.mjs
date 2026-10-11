// Spike F (GOK-131): a minimal stdio MCP server registered as `grimoire`. It
// serves the four chore tools and skill_read, answers every call with a short
// text, and appends each request it receives (with its _meta) to
// $GOK131_MCP_LOG. Spike scaffolding, never part of the package.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const log = process.env.GOK131_MCP_LOG;
/**
 * @param {string} name
 * @param {string} description
 */
const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {}, additionalProperties: true } });
const tools = [
  tool('chore_start', 'Start a due grimoire chore run.'),
  tool('chore_read', 'Page the inputs of a chore run.'),
  tool('chore_submit', 'Submit a chore run result.'),
  tool('chore_abandon', 'Abandon a chore run.'),
  tool('skill_read', 'Read an evolved skill by name.'),
];
/** @param {unknown} msg */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, msg })}\n`);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'grimoire', version: '0.0.0' } },
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const text =
      msg.params?.name === 'chore_start'
        ? 'run gr-run-1 started (stub)'
        : `${msg.params?.name} ok (stub)`;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
