// Spike B (GOK-127): one bundled MCP SDK v2 `serveStdio` server serves both MCP
// eras. These tests encode what the spike verified, against the throwaway probe
// server bundled exactly as scripts/build.mjs bundles the CLI, over real stdio.
// Findings: docs/research/spikes/mcp-dual-era.md.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, readFixture, removeDir } from '#harness';
import { bundleProbe } from './bundle-probe.mjs';

/** The probe's stand-in for grimoire's reserved hint key (spec §8). */
const RESERVED_KEY = '_grimoire';

let dir: string;
let probe: string;

beforeAll(async () => {
  dir = await makeTempDir('grimoire-mcp-probe-');
  probe = await bundleProbe(dir);
});
afterAll(() => removeDir(dir));

/** A client shaped like Codex's: `initialize` at 2025-06-18, declaring only elicitation. */
async function connectCodexShaped(env?: Record<string, string>): Promise<Client> {
  const client = new Client(
    { name: 'codex-shaped-test-client', version: '0.0.0' },
    { capabilities: { elicitation: {} }, supportedProtocolVersions: ['2025-06-18'] },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [probe],
      stderr: 'pipe',
      ...(env && { env: { ...getDefaultEnvironment(), ...env } }),
    }),
  );
  return client;
}

/** A client pinned to 2026-07-28, the revision Claude Code negotiates. */
async function connectModern(): Promise<Client> {
  const client = new Client(
    { name: 'modern-test-client', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [probe], stderr: 'pipe' }),
  );
  return client;
}

/** Runs `body` against a fresh connection in each era. */
async function inBothEras<T>(
  body: (client: Client) => Promise<T>,
): Promise<{ legacy: T; modern: T }> {
  const results: Partial<Record<'legacy' | 'modern', T>> = {};
  for (const [era, connect] of [
    ['legacy', connectCodexShaped],
    ['modern', connectModern],
  ] as const) {
    const client = await connect();
    try {
      results[era] = await body(client);
    } finally {
      await client.close();
    }
  }
  return results as { legacy: T; modern: T };
}

describe('one factory, both eras', () => {
  it('lists the same tools, with nothing but the declared arguments advertised', async () => {
    const { legacy, modern } = await inBothEras((client) => client.listTools());

    expect(modern.tools).toEqual(legacy.tools);
    const echo = legacy.tools.find((tool) => tool.name === 'echo');
    expect(echo?.inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    });
    expect(echo?.annotations).toEqual({ readOnlyHint: true });
    expect(echo).not.toHaveProperty('outputSchema');
  });

  it('delivers the same server instructions in both eras', async () => {
    const { legacy, modern } = await inBothEras(async (client) => client.getInstructions());

    expect(legacy).toMatch(/^Probe instructions:/);
    expect(modern).toBe(legacy);
  });

  it('answers a throwing handler with a JSON-RPC error and keeps serving the connection', async () => {
    const { legacy, modern } = await inBothEras(async (client) => {
      const thrown = await client.callTool({ name: 'boom', arguments: {} }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const after = await client.callTool({ name: 'echo', arguments: { text: 'still here' } });
      return { thrown, after };
    });

    for (const { thrown, after } of [legacy, modern]) {
      expect(thrown).toMatchObject({ message: expect.stringContaining('probe exploded') });
      expect(after.structuredContent).toMatchObject({ input: { text: 'still here' } });
    }
  });

  it('hands the undeclared reserved key to the handler, which strips it before schema validation', async () => {
    const hint = {
      session_id: 'session-1',
      transcript_path: 'C:/transcripts/session-1.jsonl',
      tool_use_id: 'toolu_01',
      agent_id: 'agent-1',
      agent_type: 'grimoire-chores',
    };
    const { legacy, modern } = await inBothEras((client) =>
      client.callTool({ name: 'echo', arguments: { text: 'hi', [RESERVED_KEY]: hint } }),
    );

    for (const result of [legacy, modern]) {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ input: { text: 'hi' }, hint });
    }
  });

  it('still rejects any other undeclared argument', async () => {
    const { legacy, modern } = await inBothEras((client) =>
      client.callTool({ name: 'echo', arguments: { text: 'hi', other: 1 } }),
    );

    for (const result of [legacy, modern]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
  });
});

describe('the 2026-07-28 era (Claude Code)', () => {
  it('negotiates 2026-07-28 through server/discover', async () => {
    const client = await connectModern();
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()?.name).toBe('grimoire-probe');
    } finally {
      await client.close();
    }
  });

  it("passes Claude Code's tool-use id through _meta, with the envelope lifted out", async () => {
    const client = await connectModern();
    try {
      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'hi' },
        _meta: { 'claudecode/toolUseId': 'toolu_01' },
      });

      expect(result.structuredContent).toMatchObject({
        era: 'modern',
        protocolVersion: '2026-07-28',
        meta: { 'claudecode/toolUseId': 'toolu_01' },
        envelope: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      });
      const { meta } = result.structuredContent as { meta: Record<string, unknown> };
      expect(Object.keys(meta).filter((key) => key.startsWith('io.modelcontextprotocol/'))).toEqual(
        [],
      );
    } finally {
      await client.close();
    }
  });
});

describe('the 2025-06-18 era (Codex-shaped initialize)', () => {
  it('negotiates 2025-06-18 through initialize', async () => {
    const client = await connectCodexShaped();
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-06-18');
      expect(client.getServerVersion()?.name).toBe('grimoire-probe');
    } finally {
      await client.close();
    }
  });

  it('accepts tools/call with no _meta at all', async () => {
    const client = await connectCodexShaped();
    try {
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        era: 'legacy',
        protocolVersion: '2025-06-18',
        input: { text: 'hi' },
        meta: null,
        envelope: null,
      });
    } finally {
      await client.close();
    }
  });

  it("passes Codex's per-call _meta through to the handler", async () => {
    const codexMeta = { sessionId: 'session-1', threadId: 'thread-1', callId: 'call_01' };
    const client = await connectCodexShaped();
    try {
      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'hi' },
        _meta: codexMeta,
      });

      expect(result.structuredContent).toMatchObject({ meta: codexMeta, envelope: null });
    } finally {
      await client.close();
    }
  });
});

describe('wire capture (how the fixtures were recorded)', () => {
  it('appends the raw bytes of each direction when GRIMOIRE_PROBE_CAPTURE_DIR is set', async () => {
    const captureDir = path.join(dir, 'capture');
    const client = await connectCodexShaped({ GRIMOIRE_PROBE_CAPTURE_DIR: captureDir });
    await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    await client.close();

    const lines = (file: string) =>
      readFileSync(path.join(captureDir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; result?: unknown });
    expect(lines('c2s.jsonl').map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(lines('s2c.jsonl')).toHaveLength(2);
    expect(lines('s2c.jsonl')[0]?.result).toMatchObject({ protocolVersion: '2025-06-18' });
  });

  it('records one start line per server process, so a client spawning twice shows up', async () => {
    const captureDir = path.join(dir, 'capture-starts');
    for (let i = 0; i < 2; i++) {
      const client = await connectCodexShaped({ GRIMOIRE_PROBE_CAPTURE_DIR: captureDir });
      await client.close();
    }

    const starts = readFileSync(path.join(captureDir, 'starts.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; at: string });
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((start) => start.pid)).size).toBe(2);
    for (const start of starts) expect(Date.parse(start.at)).not.toBeNaN();
  });
});

describe('results', () => {
  it('a result cut at 24 KB arrives well-formed in both eras, with truncated and a cursor', async () => {
    const { legacy, modern } = await inBothEras((client) =>
      client.callTool({ name: 'big', arguments: { rows: 1000 } }),
    );

    for (const result of [legacy, modern]) {
      const [block] = result.content as { type: string; text: string }[];
      expect(result.content).toHaveLength(1);
      expect(block?.type).toBe('text');
      expect(Buffer.byteLength(block!.text, 'utf8')).toBeLessThanOrEqual(24 * 1024);
      expect(JSON.parse(block!.text)).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        cursor: expect.any(String),
      });
      expect((result.structuredContent as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    }
  });

  it('carries structuredContent and the text block unchanged, even when they differ', async () => {
    const { legacy, modern } = await inBothEras((client) =>
      client.callTool({ name: 'which', arguments: {} }),
    );

    for (const result of [legacy, modern]) {
      expect(result.structuredContent).toEqual({ seen_via: 'structuredContent' });
      expect(result.content).toEqual([{ type: 'text', text: '{"seen_via":"text"}' }]);
    }
  });
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const parseLines = (text: string): JsonRpcMessage[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcMessage);

/**
 * Writes raw JSON-RPC lines to a fresh probe, exactly as given, and collects
 * the response to every request among them, by id.
 */
function rawSession(lines: string[]): Promise<Map<string | number, JsonRpcMessage>> {
  const pending = new Set(
    lines
      .map((line) => JSON.parse(line) as JsonRpcMessage)
      .filter((message) => message.method !== undefined && message.id !== undefined)
      .map((message) => message.id!),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const responses = new Map<string | number, JsonRpcMessage>();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response to ${[...pending].join(', ')}`));
    }, 10_000);
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline)) as JsonRpcMessage;
        buffered = buffered.slice(newline + 1);
        if (message.id === undefined || message.method !== undefined) continue;
        responses.set(message.id, message);
        pending.delete(message.id);
      }
      if (pending.size === 0) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.on('error', reject);
    for (const line of lines) child.stdin.write(`${line}\n`);
  });
}

const fixtureLines = (rel: string) => readFixture(rel).split('\n').filter(Boolean);

describe("the real clients' traffic, replayed (seam-2 fixtures)", () => {
  it('each real client started exactly one server process for its session', () => {
    for (const session of [
      'claude-code/mcp/session-hint-hook',
      'claude-code/mcp/session-no-hook',
      'codex/mcp/handshake',
    ]) {
      expect(fixtureLines(`${session}/starts.jsonl`), session).toHaveLength(1);
    }
  });

  it('Claude Code 2.1.296 opens with server/discover and never sends initialize', () => {
    const methods = parseLines(readFixture('claude-code/mcp/session-hint-hook/c2s.jsonl')).map(
      (message) => message.method,
    );
    expect(methods).toEqual([
      'server/discover',
      'tools/list',
      'tools/call',
      'tools/call',
      'tools/call',
    ]);
  });

  it("Claude Code stamps every request with the 2026-07-28 envelope, and the hint's tool-use id matches _meta", () => {
    const requests = parseLines(readFixture('claude-code/mcp/session-hint-hook/c2s.jsonl'));
    for (const request of requests) {
      expect(request.params?._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.296' },
      });
    }
    const calls = requests.filter((request) => request.method === 'tools/call');
    for (const call of calls) {
      const hint = call.params?.arguments?.[RESERVED_KEY] as { tool_use_id: string };
      expect(hint.tool_use_id).toBe(call.params?._meta?.['claudecode/toolUseId']);
    }
  });

  it('serves the replayed Claude Code session, stripping the hint from every call', async () => {
    const lines = fixtureLines('claude-code/mcp/session-hint-hook/c2s.jsonl');
    const responses = await rawSession(lines);

    for (const response of responses.values()) expect(response.error).toBeUndefined();
    expect(responses.get('server-discover-probe-1')?.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
    });
    const echo = responses.get(1)?.result?.structuredContent as Record<string, unknown>;
    expect(echo).toMatchObject({ era: 'modern', input: { text: 'hello' } });
    expect(echo.hint).toMatchObject({ tool_use_id: 'toolu_01Upxr4h3yPJt3sNY1vWtkWy' });
    expect(echo.meta).toEqual({
      progressToken: 1,
      'claudecode/toolUseId': 'toolu_01Upxr4h3yPJt3sNY1vWtkWy',
    });
  });

  it('serves the replayed Codex 0.162.1 handshake at 2025-06-18', async () => {
    const lines = fixtureLines('codex/mcp/handshake/c2s.jsonl');
    expect(parseLines(lines.join('\n'))[0]?.params).toMatchObject({
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'codex-mcp-client', version: '0.162.1' },
    });

    const responses = await rawSession(lines);

    expect(responses.get(0)?.result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect((responses.get(1)?.result?.tools as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('tools/call without the modern _meta envelope (A1), on the raw wire', () => {
  const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const callEcho = (id: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' }, ...extra },
    });

  it('serves one that arrives with no handshake at all, as 2025-era traffic', async () => {
    const responses = await rawSession([callEcho(1)]);

    expect(responses.get(1)?.result?.structuredContent).toMatchObject({
      era: 'legacy',
      input: { text: 'hi' },
    });
  });

  it('serves one that follows an abandoned server/discover probe, as 2025-era traffic', async () => {
    const discover = JSON.stringify({
      jsonrpc: '2.0',
      id: 'd',
      method: 'server/discover',
      params: { _meta: ENVELOPE },
    });
    const responses = await rawSession([
      discover,
      callEcho(1, { _meta: { 'claudecode/toolUseId': 'toolu_x' } }),
    ]);

    expect(responses.get(1)?.result?.structuredContent).toMatchObject({
      era: 'legacy',
      meta: { 'claudecode/toolUseId': 'toolu_x' },
    });
  });

  it('refuses one on a connection already pinned to 2026-07-28 with -32602 (the 2026-07-28 rule)', async () => {
    const list = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: ENVELOPE },
    });
    const responses = await rawSession([list, callEcho(2)]);

    expect(responses.get(1)?.result?.tools).toBeDefined();
    expect(responses.get(2)?.error).toMatchObject({ code: -32602 });
  });
});
