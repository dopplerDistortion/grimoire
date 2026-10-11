// Seam 3, in process: the MCP surface's server factory, served by the SDK's
// `serveStdio` over an in-memory transport, with the real core behind it. A
// recording wrapper around the core shows what each call handed the core,
// which is the surface's whole job (spec §8: transport and gating).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect } from 'vitest';
import { gitTest, readFixtureJson, type Checkout } from '#harness';
import { createCore, type CallContext, type Core } from '../../../src/core';
import { grimoireServerFactory, type McpCore } from '../../../src/surfaces/mcp/server';
import { VERSION } from '../../../src/version';
import { commitToTracker, initializeTracker } from '../../core/support';

type Era = 'legacy' | 'modern';

interface Seen {
  name: string;
  input: unknown;
  ctx: CallContext;
}

interface Served {
  client: Client;
  seen: Seen[];
  close(): Promise<void>;
}

/** Serves grimoire for `checkout` in-process and connects a client of `era`. */
async function serve(
  checkout: Checkout,
  era: Era,
  options: { wrap?: (core: Core) => McpCore; startDir?: string } = {},
): Promise<Served> {
  const core = createCore();
  const seen: Seen[] = [];
  const recording: McpCore = {
    ops: core.ops,
    call: (name, input, ctx) => {
      seen.push({ name, input, ctx });
      return core.call(name, input, ctx);
    },
  };
  const wrapped = options.wrap ? options.wrap({ ...core, ...recording }) : recording;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    grimoireServerFactory({ core: async () => wrapped, startDir: options.startDir ?? checkout.dir, nonce: 'nonce-test' }),
    { transport: serverSide },
  );
  const client =
    era === 'legacy'
      ? new Client({ name: 'codex-mcp-client', version: '0.162.1' }, { supportedProtocolVersions: ['2025-06-18'] })
      : new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(clientSide);
  return {
    client,
    seen,
    async close() {
      await client.close();
      await handle.close();
      await core.close();
    },
  };
}

async function inBothEras(checkout: Checkout, body: (served: Served, era: Era) => Promise<void>): Promise<void> {
  for (const era of ['legacy', 'modern'] as const) {
    const served = await serve(checkout, era);
    try {
      await body(served, era);
    } finally {
      await served.close();
    }
  }
}

describe('the reserved hint key', () => {
  gitTest('is stripped from the arguments before validation and handed to the core in the call context', async ({
    world,
  }) => {
    await initializeTracker(world.a, world.a);
    const hint = {
      session_id: 'session-1',
      tool_use_id: 'toolu_01',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      // The spike-era hint carried a path; the server never keeps it.
      transcript_path: 'C:/Users/user/.claude/projects/x/session-1.jsonl',
    };

    await inBothEras(world.a, async ({ client, seen }, era) => {
      const result = await client.callTool({
        name: 'create',
        arguments: { title: `Hinted ${era}`, _grimoire: hint },
        _meta: { 'claudecode/toolUseId': 'toolu_01' },
      });

      expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
      const [call] = seen;
      expect(call!.input).toEqual({ title: `Hinted ${era}` });
      expect(call!.ctx.mcp).toEqual({
        era,
        hint: { session_id: 'session-1', tool_use_id: 'toolu_01', agent_id: 'agent-1', agent_type: 'general-purpose' },
        meta: { 'claudecode/toolUseId': 'toolu_01' },
      });
    });
  });

  gitTest('a malformed hint is still stripped, and claims nothing', async ({ world }) => {
    await initializeTracker(world.a, world.a);

    await inBothEras(world.a, async ({ client, seen }) => {
      for (const malformed of ['session-1', { tool_use_id: 'toolu_01' }, { session_id: 7, tool_use_id: 'x' }, null]) {
        const result = await client.callTool({ name: 'labels', arguments: { _grimoire: malformed } });
        expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
      }
      for (const call of seen) {
        expect(call.input).toEqual({});
        expect(call.ctx.mcp?.hint).toBeNull();
      }
    });
  });
});

describe('notices', () => {
  gitTest('after the checkout moves to another pin, every result says to restart the session', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const served = await serve(world.a, 'modern');
    try {
      const before = await served.client.callTool({ name: 'labels', arguments: {} });
      await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
      await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), 'version: 9.9.9\ninstall_format: 1\n');
      const ok = await served.client.callTool({ name: 'labels', arguments: {} });
      const failed = await served.client.callTool({ name: 'show', arguments: { ref: 'gr-zzzzzzzz' } });

      const notice = `this checkout now pins 9.9.9; this session runs ${VERSION}; restart it`;
      expect(before.structuredContent).toEqual({ labels: [] });
      expect(ok.structuredContent).toEqual({ labels: [], notices: [notice] });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toMatchObject({ error: { code: 'NOT_FOUND' }, notices: [notice] });
      expect(served.seen.at(-1)!.ctx.repo.pin).toBe('9.9.9');
    } finally {
      await served.close();
    }
  });

  gitTest('a checkout pinning the running release gets no notice', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    await world.a.commitFile('.grimoire/config.yml', `version: ${VERSION}\ninstall_format: 1\n`);
    const served = await serve(world.a, 'legacy');
    try {
      const result = await served.client.callTool({ name: 'labels', arguments: {} });

      expect(result.structuredContent).toEqual({ labels: [] });
      expect(served.seen[0]!.ctx.repo).toEqual({ root: world.a.dir, pin: VERSION, installFormat: 1 });
    } finally {
      await served.close();
    }
  });

  gitTest('a server launched below the repo root serves the repo, and says to launch from the root', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const below = path.join(world.a.dir, 'src', 'deep');
    await mkdir(below, { recursive: true });
    const served = await serve(world.a, 'legacy', { startDir: below });
    try {
      const result = await served.client.callTool({ name: 'create', arguments: { title: 'From below' } });

      expect(result.structuredContent).toEqual({
        id: expect.any(String),
        created: true,
        notices: [expect.stringMatching(/launched in src\/deep, below the repo root.*launch .* from the repo root/)],
      });
      expect(served.seen[0]!.ctx.repo.root).toBe(world.a.dir);
    } finally {
      await served.close();
    }
  });
});

describe('result layout', () => {
  gitTest('a cut result keeps its notices under the limit and ends with truncated, then cursor', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const below = path.join(world.a.dir, 'docs');
    await mkdir(below, { recursive: true });
    const served = await serve(world.a, 'legacy', { startDir: below });
    try {
      for (let i = 0; i < 12; i++) {
        await served.client.callTool({ name: 'create', arguments: { title: `${i} ${'long title '.repeat(250)}` } });
      }
      const result = await served.client.callTool({ name: 'list', arguments: {} });

      const text = (result.content as { text: string }[])[0]!.text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(24 * 1024);
      expect(Object.keys(result.structuredContent!)).toEqual(['rows', 'total', 'notices', 'truncated', 'cursor']);
      expect(result.structuredContent).toMatchObject({ total: 12, truncated: true, cursor: expect.any(String) });
    } finally {
      await served.close();
    }
  });
});

describe('lazy per-call checks', () => {
  gitTest('the format checks run per call, so a running server notices a newer store or install format', async ({
    world,
  }) => {
    await initializeTracker(world.a, world.a);
    const served = await serve(world.a, 'modern');
    try {
      const before = await served.client.callTool({ name: 'labels', arguments: {} });
      await commitToTracker(world.a, { format: 'format: 2\ncompat: 2\nrequires: "2.0.0"\n' });
      const store = await served.client.callTool({ name: 'labels', arguments: {} });
      await world.a.commitFile('.grimoire/config.yml', 'version: 2.0.0\ninstall_format: 2\n');
      const install = await served.client.callTool({ name: 'create', arguments: { title: 'x' } });

      expect(before.isError).toBeFalsy();
      expect(store.structuredContent).toMatchObject({
        error: { code: 'UPGRADE_REQUIRED', details: { marker: 'store', why: 'newer', requires: '2.0.0' } },
      });
      expect(install.structuredContent).toMatchObject({
        error: { code: 'UPGRADE_REQUIRED', details: { marker: 'install', why: 'newer', pin: '2.0.0', requires: '2.0.0' } },
        notices: [`this checkout now pins 2.0.0; this session runs ${VERSION}; restart it`],
      });
    } finally {
      await served.close();
    }
  });
});

describe('gating', () => {
  const withOffSurfaceOps = (core: McpCore): McpCore => ({
    ops: [
      ...core.ops,
      ...(['human-only', 'human-read', 'internal'] as const).map((policy) => ({
        name: `${policy}-op`,
        description: `A ${policy} op.`,
        kind: 'write' as const,
        policy,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { destructiveHint: false, openWorldHint: false },
      })),
    ],
    call: core.call,
  });

  gitTest('only agent ops are listed; a human-only op is refused and an unlisted one is unknown', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const served = await serve(world.a, 'modern', { wrap: withOffSurfaceOps });
    try {
      const { tools } = await served.client.listTools();
      const humanOnly = await served.client.callTool({ name: 'human-only-op', arguments: {} });
      const humanRead = await served.client.callTool({ name: 'human-read-op', arguments: {} });
      const internal = await served.client.callTool({ name: 'internal-op', arguments: {} });
      const unknown = await served.client.callTool({ name: 'no-such-tool', arguments: {} });

      expect(tools.map((tool) => tool.name)).toEqual(['show', 'list', 'labels', 'create', 'update', 'comment', 'claim', 'release', 'close']);
      expect(humanOnly.structuredContent).toMatchObject({ error: { code: 'HUMAN_ONLY', retryable: false } });
      expect(humanRead.structuredContent).toMatchObject({ error: { code: 'HUMAN_ONLY', retryable: false } });
      for (const result of [internal, unknown]) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID', details: { fields: { name: expect.any(String) } } } });
      }
      // None of them reached the core.
      expect(served.seen).toEqual([]);
    } finally {
      await served.close();
    }
  });
});

describe('failures', () => {
  gitTest('a handler that throws answers with an error envelope, and the server keeps serving', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const exploding = (core: McpCore): McpCore => ({
      ops: core.ops,
      call: (name, input, ctx) => (name === 'labels' ? Promise.reject(new Error('disk on fire')) : core.call(name, input, ctx)),
    });

    for (const era of ['legacy', 'modern'] as const) {
      const served = await serve(world.a, era, { wrap: exploding });
      try {
        const failed = await served.client.callTool({ name: 'labels', arguments: {} });
        const after = await served.client.callTool({ name: 'create', arguments: { title: 'Still serving' } });

        expect(failed.isError).toBe(true);
        expect(failed.structuredContent).toEqual({
          error: {
            code: 'INTERNAL',
            message: expect.stringContaining('disk on fire'),
            retryable: false,
            details: {},
          },
        });
        expect(failed.content).toEqual([{ type: 'text', text: JSON.stringify(failed.structuredContent) }]);
        expect(after.isError).toBeFalsy();
        expect(after.structuredContent).toMatchObject({ created: true });
      } finally {
        await served.close();
      }
    }
  });

  gitTest('a server started outside any git repository answers every call with NO_REPO', async ({ world }) => {
    // The world's root holds the remote and the clones but is no repository itself.
    const served = await serve(world.a, 'legacy', { startDir: world.root });
    try {
      const result = await served.client.callTool({ name: 'labels', arguments: {} });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: 'NO_REPO', retryable: false } });
    } finally {
      await served.close();
    }
  });
});

describe('per-call _meta', () => {
  gitTest('a call without _meta is served, and its context says so', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const served = await serve(world.a, 'legacy');
    try {
      const result = await served.client.callTool({ name: 'labels', arguments: {} });

      expect(result.structuredContent).toEqual({ labels: [] });
      expect(served.seen[0]!.ctx.mcp).toEqual({ era: 'legacy', hint: null, meta: null });
    } finally {
      await served.close();
    }
  });

  gitTest("Codex's real _meta reaches the context as ids, without the turn metadata and its paths", async ({ world }) => {
    await initializeTracker(world.a, world.a);
    const { params } = readFixtureJson<{ params: { _meta: Record<string, unknown> } }>('codex/meta/tools-call.json');
    const served = await serve(world.a, 'legacy');
    try {
      await served.client.callTool({ name: 'labels', arguments: {}, _meta: params._meta });

      const { meta } = served.seen[0]!.ctx.mcp!;
      expect(meta).toEqual({
        callId: params._meta.callId,
        threadId: params._meta.threadId,
        sessionId: params._meta.sessionId,
        windowId: params._meta.windowId,
        itemId: params._meta.itemId,
        progressToken: params._meta.progressToken,
      });
      expect(JSON.stringify(meta)).not.toContain('\\\\');
    } finally {
      await served.close();
    }
  });
});
