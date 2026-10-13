// Spike B (GOK-127) throwaway probe: one MCP SDK v2 `serveStdio` server that
// serves both MCP eras from a single factory. Not grimoire's server: it exists
// to verify P1, A1, T2 and R7 (docs/research/spikes/mcp-dual-era.md).
//
// It uses the SDK's low-level `Server` (not `McpServer.registerTool`), so its
// `tools/call` handler sees the raw `params.arguments` before any tool schema.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  Server,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/** The probe's stand-in for grimoire's reserved hint key (spec §8). Never advertised. */
const RESERVED_KEY = '_grimoire';

/** grimoire's result budget (spec §8): the text block stays within this many bytes. */
const RESULT_BUDGET_BYTES = 24 * 1024;

interface Call {
  input: Record<string, unknown>;
  hint: unknown;
  era: 'legacy' | 'modern';
  server: Server;
  ctx: ServerContext;
}

interface ProbeTool {
  tool: Tool;
  run(call: Call): CallToolResult;
}

/** Compact JSON, sent as both `structuredContent` and one text block (spec §8). */
function result(body: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body as CallToolResult['structuredContent'],
    ...(isError && { isError: true }),
  };
}

function errorResult(code: string, message: string, details: unknown = {}): CallToolResult {
  return result({ error: { code, message, retryable: false, details } }, true);
}

function objectSchema(
  properties: NonNullable<Tool['inputSchema']['properties']>,
  required: string[] = [],
): Tool['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

const PROBE_TOOLS: ProbeTool[] = [
  {
    tool: {
      name: 'echo',
      description: 'Echoes its text argument back with what the server saw of the call.',
      inputSchema: objectSchema({ text: { type: 'string' } }, ['text']),
      annotations: { readOnlyHint: true },
    },
    run: ({ input, hint, era, server, ctx }) =>
      result({
        era,
        protocolVersion: server.getNegotiatedProtocolVersion() ?? null,
        input,
        hint: hint ?? null,
        meta: ctx.mcpReq._meta ?? null,
        envelope: ctx.mcpReq.envelope ?? null,
      }),
  },
  {
    tool: {
      name: 'big',
      description:
        'Returns the requested number of rows, cut well-formed at 24 KB with truncated and a cursor.',
      inputSchema: objectSchema({ rows: { type: 'integer', minimum: 1 } }, ['rows']),
      annotations: { readOnlyHint: true },
    },
    run: ({ input }) => {
      const wanted = input.rows as number;
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < wanted; i++) {
        const row = { id: `row-${i}`, title: `Row ${i}: ${'lorem ipsum '.repeat(12).trim()}` };
        const candidate = { rows: [...rows, row], truncated: true, cursor: String(i + 1) };
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > RESULT_BUDGET_BYTES) {
          return result({ rows, truncated: true, cursor: String(i) });
        }
        rows.push(row);
      }
      return result({ rows, truncated: false });
    },
  },
  {
    tool: {
      name: 'which',
      description:
        'Returns a structuredContent and a text block that differ, to show which one a client uses.',
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true },
    },
    run: () => ({
      content: [{ type: 'text', text: JSON.stringify({ seen_via: 'text' }) }],
      structuredContent: { seen_via: 'structuredContent' },
    }),
  },
  {
    tool: {
      name: 'boom',
      description: 'Throws from the handler, to show what the SDK does with an uncaught error.',
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true },
    },
    run: () => {
      throw new Error('probe exploded');
    },
  },
];

const INSTRUCTIONS =
  'Probe instructions: the same text must reach both eras (initialize result and server/discover result).';

const TOOLS = new Map(
  PROBE_TOOLS.map((entry) => [
    entry.tool.name,
    { ...entry, validator: fromJsonSchema(entry.tool.inputSchema as JsonSchemaType) },
  ]),
);

/**
 * The wire. With GRIMOIRE_PROBE_CAPTURE_DIR set, the probe appends one line per
 * process start to starts.jsonl there, and the raw bytes of each direction to
 * c2s.jsonl (client to server) and s2c.jsonl (server to client), synchronously,
 * so a client that kills the server loses nothing.
 */
function wire(): StdioServerTransport {
  const captureDir = process.env.GRIMOIRE_PROBE_CAPTURE_DIR;
  if (!captureDir) return new StdioServerTransport();
  mkdirSync(captureDir, { recursive: true });
  appendFileSync(
    path.join(captureDir, 'starts.jsonl'),
    `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
  );
  const c2s = path.join(captureDir, 'c2s.jsonl');
  const s2c = path.join(captureDir, 's2c.jsonl');
  process.stdin.on('data', (chunk: Buffer) => appendFileSync(c2s, chunk));
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      appendFileSync(s2c, chunk);
      process.stdout.write(chunk, callback);
    },
  });
  return new StdioServerTransport(process.stdin, stdout);
}

serveStdio(
  ({ era }) => {
    const server = new Server(
      { name: 'grimoire-probe', version: '0.0.0' },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler('tools/list', () => ({
      tools: PROBE_TOOLS.map((entry) => entry.tool),
    }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      // Read and strip the reserved key from the raw arguments, before validation.
      const { [RESERVED_KEY]: hint, ...raw } = request.params.arguments ?? {};

      const entry = TOOLS.get(request.params.name);
      if (!entry) return errorResult('UNKNOWN_TOOL', `no tool named ${request.params.name}`);
      const parsed = await entry.validator['~standard'].validate(raw);
      if (parsed.issues) {
        return errorResult('INVALID_INPUT', 'the arguments do not match the tool schema', {
          issues: parsed.issues.map((issue) => issue.message),
        });
      }
      const input = parsed.value as Record<string, unknown>;
      return entry.run({ input, hint, era, server, ctx });
    });
    return server;
  },
  { transport: wire() },
);
