// Seam 3: `grimoire mcp` over real stdio, in both MCP eras (spec §8; spikes B and E).
import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, readFixture, readFixtureJson } from '#harness';
import { SERVER_INSTRUCTIONS } from '../../../src/instructions';
import { initializeTracker, TRACKER_REF } from '../../core/support';
import { buildGrimoire, connect, inBothEras, rawSession, type JsonRpcMessage } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

const AGENT_TOOLS = ['show', 'list', 'labels', 'create', 'update', 'comment', 'claim', 'release', 'close'];

describe('grimoire mcp over stdio', () => {
  gitTest('a 2025-06-18 client and a 2026-07-28 client list the same tools', async ({ world }) => {
    await initializeTracker(world.a, world.a);

    const { legacy, modern } = await inBothEras(bin, { cwd: world.a.dir }, async (client) => ({
      version: client.getNegotiatedProtocolVersion(),
      tools: (await client.listTools()).tools,
    }));

    expect(legacy.version).toBe('2025-06-18');
    expect(modern.version).toBe('2026-07-28');
    expect(legacy.tools.map((tool) => tool.name)).toEqual(AGENT_TOOLS);
    expect(modern.tools).toEqual(legacy.tools);
  });

  gitTest('both eras get the shipped instructions, whose first 512 characters carry the working contract', async ({
    world,
  }) => {
    const { legacy, modern } = await inBothEras(bin, { cwd: world.a.dir }, async (client) => client.getInstructions());

    expect(legacy).toBe(SERVER_INSTRUCTIONS);
    expect(modern).toBe(SERVER_INSTRUCTIONS);
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    // Codex lists the instructions in its tool_search description: name grimoire and issues first (spike E).
    expect(head).toMatch(/^grimoire\b.*\bissue/);
    const contract: [string, RegExp][] = [
      ['issues live in grimoire, so use these tools', /issues live in grimoire.*use these (grimoire )?tools/is],
      ['claim only the leaf you will work', /claim only the leaf/i],
      ['ALREADY_CLAIMED means move on', /ALREADY_CLAIMED means move on/],
      ['finish with close or release and a debrief', /finish .*`close` or `release`.*debrief/i],
      ['never edit, stage or commit .grimoire/', /never edit, stage or commit `\.grimoire\/`/i],
      // Codex (and Claude Code with many tools) defer MCP tools behind a tool search, so none
      // are "listed" until the model searches: the fallback must wait for the search (spike E).
      ['the CLI only when no tools are listed, even through tool search', /CLI only when no grimoire tools are listed or found by tool search/i],
      ['when no tools are listed, run status', /`node \.grimoire\/run\.cjs status`/],
      ['hand-written skills outrank evolved skills', /hand-written skills outrank evolved skills \(`skill_list`, `skill_read`\)/i],
    ];
    for (const [item, pattern] of contract) expect(head, item).toMatch(pattern);
  });

  gitTest('annotations mark reads read-only and writes local and non-destructive; only close and release are idempotent', async ({
    world,
  }) => {
    const client = await connect(bin, 'legacy', { cwd: world.a.dir });
    const { tools } = await client.listTools().finally(() => client.close());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    for (const name of ['show', 'list', 'labels']) {
      expect(byName[name]!.annotations, name).toEqual({ readOnlyHint: true });
    }
    for (const name of ['create', 'update', 'comment', 'claim']) {
      expect(byName[name]!.annotations, name).toEqual({ destructiveHint: false, openWorldHint: false });
    }
    for (const name of ['close', 'release']) {
      expect(byName[name]!.annotations, name).toEqual({ destructiveHint: false, openWorldHint: false, idempotentHint: true });
    }
    for (const tool of tools) {
      expect(tool, tool.name).not.toHaveProperty('outputSchema');
      // Codex defers MCP tools behind a BM25 tool_search over names and descriptions (spike E).
      expect(tool.description, tool.name).toMatch(/\bgrimoire\b/);
      expect(tool.description, tool.name).toMatch(/\bissues?\b/);
      // The reserved hint key is never advertised, and inputs stay closed.
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('_grimoire');
    }
  });

  gitTest('create, show, claim and close work in both eras, as compact JSON twice over', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const debrief = { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' };

    const results = await inBothEras(bin, { cwd: world.a.dir }, async (client, era) => {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        const blocks = result.content as { type: string; text: string }[];
        expect(blocks).toHaveLength(1);
        expect(blocks[0]!.type).toBe('text');
        // The text block is the compact JSON of structuredContent, byte for byte.
        expect(blocks[0]!.text).toBe(JSON.stringify(result.structuredContent));
        return result;
      };
      const created = await call('create', { title: `Fix the ${era} bug`, body: 'Steps.' });
      const { id } = created.structuredContent as { id: string };
      const shown = await call('show', { ref: id });
      const claimed = await call('claim', { id });
      const { attempt } = claimed.structuredContent as { attempt: string };
      const closed = await call('close', { id, reason: 'done', attempt, debrief });
      const after = await call('show', { ref: id, comments: 'none' });
      return { created, shown, claimed, closed, after };
    });

    for (const [era, { created, shown, claimed, closed, after }] of Object.entries(results)) {
      expect(created.isError, era).toBeFalsy();
      expect(created.structuredContent).toEqual({ id: expect.stringMatching(/^gr-/), created: true });
      expect(shown.structuredContent).toMatchObject({ title: `Fix the ${era} bug`, body: 'Steps.', status: 'open' });
      expect(claimed.isError, era).toBeFalsy();
      expect(claimed.structuredContent).toMatchObject({ attempt: expect.any(String) });
      expect(closed.isError, era).toBeFalsy();
      expect(after.structuredContent).toMatchObject({ status: 'done', open_attempts: [] });
    }
  });

  gitTest('a result over 24 KB arrives cut well-formed, ending in truncated and a cursor that reaches the rest', async ({
    world,
  }) => {
    await initializeTracker(world.a, world.a);
    const body = Array.from({ length: 1500 }, (_, i) => `Line ${i}: ${'détail '.repeat(6)}`).join('\n');
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(60_000);

    const pages = await inBothEras(bin, { cwd: world.a.dir }, async (client) => {
      const { structuredContent } = await client.callTool({ name: 'create', arguments: { title: 'Huge', body } });
      const { id } = structuredContent as { id: string };
      const results = [];
      let cursor: string | undefined;
      do {
        const result = await client.callTool({ name: 'show', arguments: { ref: id, comments: 'none', ...(cursor ? { cursor } : {}) } });
        results.push(result);
        cursor = (result.structuredContent as { cursor: string | null }).cursor ?? undefined;
      } while (cursor && results.length < 10);
      return results;
    });

    for (const results of Object.values(pages)) {
      expect(results.length).toBeGreaterThan(2);
      const [first] = results;
      const text = (first!.content as { text: string }[])[0]!.text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(24 * 1024);
      expect(JSON.parse(text)).toEqual(first!.structuredContent);
      expect(Object.keys(first!.structuredContent!).slice(-2)).toEqual(['truncated', 'cursor']);
      expect(first!.structuredContent).toMatchObject({ truncated: true, cursor: expect.any(String) });
      const parts = results.map((result) => (result.structuredContent as { body: string }).body);
      expect(parts.join('')).toBe(body);
    }
  });

  gitTest('the writes are made by the person, as an agent actor of the client that connected', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const env = { CLAUDE_CODE_SESSION_ID: 'spawn-session-1' };

    const ids = await inBothEras(bin, { cwd: world.a.dir, env }, async (client, era) => {
      const result = await client.callTool({ name: 'create', arguments: { title: `By ${era}` } });
      return (result.structuredContent as { id: string }).id;
    });

    const commit = async (id: string) => {
      const log = await world.a.git(['log', '--format=%an <%ae>%n%(trailers:key=Grimoire-Actor,valueonly,unfold)', `--grep=create ${id}`, TRACKER_REF]);
      const [author, actor] = log.split('\n');
      return { author, actor: JSON.parse(actor!) as Record<string, unknown> };
    };
    const legacy = await commit(ids.legacy);
    const modern = await commit(ids.modern);
    expect(legacy.author).toBe(`${world.a.identity.name} <${world.a.identity.email}>`);
    expect(legacy.actor).toMatchObject({ kind: 'agent', client: 'codex-mcp-client', spawn_env: 'spawn-session-1' });
    expect(modern.author).toBe(`${world.a.identity.name} <${world.a.identity.email}>`);
    expect(modern.actor).toMatchObject({ kind: 'agent', client: 'claude-code', spawn_env: 'spawn-session-1' });
    // Both processes of the run carry a nonce, and no two processes share one.
    expect(legacy.actor.nonce).toEqual(expect.any(String));
    expect(legacy.actor.nonce).not.toBe(modern.actor.nonce);
  });
});

/**
 * A fixture's JSON-RPC lines, each probe tool call turned into a grimoire
 * `create`: its own arguments replaced by a title, its reserved key and
 * `_meta` kept exactly as the client sent them.
 */
function asCreates(rel: string): string[] {
  return readFixture(rel)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.method !== 'tools/call' || !message.params) return line;
      const { _grimoire } = message.params.arguments ?? {};
      const args = { title: `Replayed call ${message.id}`, _grimoire };
      return JSON.stringify({ ...message, params: { ...message.params, name: 'create', arguments: args } });
    });
}

describe("the real clients' traffic, replayed on the raw wire", () => {
  gitTest("Claude Code's 2026-07-28 session: discover, list, and calls carrying the hint key", async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const lines = asCreates('claude-code/mcp/session-hint-hook/c2s.jsonl');
    // The real calls carry the reserved key (in its spike-era shape, with a path) and Claude Code's _meta.
    expect(lines.filter((line) => line.includes('"_grimoire"'))).toHaveLength(3);

    const responses = await rawSession(bin, world.a.dir, lines);

    for (const response of responses.values()) expect(response.error).toBeUndefined();
    expect(responses.get('server-discover-probe-1')?.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      instructions: SERVER_INSTRUCTIONS,
    });
    expect((responses.get(0)?.result?.tools as { name: string }[]).map((tool) => tool.name)).toEqual(AGENT_TOOLS);
    for (const id of [1, 2, 3]) {
      expect(responses.get(id)?.result, `call ${id}`).toMatchObject({ structuredContent: { created: true } });
      expect(responses.get(id)?.result?.isError).toBeUndefined();
    }
  });

  gitTest("Codex's 2025-06-18 handshake, then calls with Codex's _meta and with none at all", async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const codexCall = readFixtureJson<JsonRpcMessage>('codex/meta/tools-call.json');
    const lines = [
      ...readFixture('codex/mcp/handshake/c2s.jsonl').split('\n').filter(Boolean),
      JSON.stringify({ ...codexCall, id: 2, params: { ...codexCall.params, name: 'create', arguments: { title: 'From Codex' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'labels', arguments: {} } }),
    ];

    const responses = await rawSession(bin, world.a.dir, lines);

    expect(responses.get(0)?.result).toMatchObject({ protocolVersion: '2025-06-18', instructions: SERVER_INSTRUCTIONS });
    expect((responses.get(1)?.result?.tools as unknown[]).length).toBe(AGENT_TOOLS.length);
    expect(responses.get(2)?.result).toMatchObject({ structuredContent: { created: true } });
    expect(responses.get(3)?.result).toMatchObject({ structuredContent: { labels: [] } });
  });

  gitTest('a tools/call with no handshake and no _meta at all is served as 2025-era traffic', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create', arguments: { title: 'Bare' } } };

    const responses = await rawSession(bin, world.a.dir, [JSON.stringify(call)]);

    expect(responses.get(1)?.result).toMatchObject({ structuredContent: { created: true } });
  });
});

describe('the server process', () => {
  gitTest('honours --from, ignores unknown flags, and exits 0 once the client closes stdin', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const child = spawn(process.execPath, [bin, 'mcp', '--no-such-flag', '--from', world.a.dir, 'extra'], {
      cwd: world.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const lines: JsonRpcMessage[] = [];
    let buffered = '';
    child.stdout.setEncoding('utf8');
    const answered = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
          lines.push(JSON.parse(buffered.slice(0, newline)) as JsonRpcMessage);
          buffered = buffered.slice(newline + 1);
        }
        if (lines.some((line) => line.id === 2)) resolve();
      });
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create', arguments: { title: 'Then goodbye' } } });
    await answered;
    child.stdin.end();

    const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000))]);
    if (code === 'hung') child.kill();

    expect(lines.find((line) => line.id === 2)?.result).toMatchObject({ structuredContent: { created: true } });
    expect(code).toBe(0);
  });

  gitTest('a write still running when the client closes stdin finishes before the process exits', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    // A fresh ref lock (another writer mid-update) holds the write for 3 s, longer than
    // the process's 2 s last-resort exit, which only a drained shutdown arms after the write.
    const lock = path.join(world.a.dir, '.git', 'refs', 'grimoire', 'tracker.lock');
    await writeFile(lock, '');
    const child = spawn(process.execPath, [bin, 'mcp'], { cwd: world.a.dir, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create', arguments: { title: 'Written on the way out' } } });
    child.stdin.end();
    const unlocked = setTimeout(() => void rm(lock, { force: true }), 3_000);

    const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000))]);
    clearTimeout(unlocked);
    await rm(lock, { force: true });
    if (code === 'hung') child.kill();

    expect(code).toBe(0);
    const subjects = (await world.a.git(['log', '--format=%s', TRACKER_REF])).split('\n');
    expect(subjects.filter((subject) => /^grimoire: create gr-/.test(subject))).toHaveLength(1);
  });
});
