// Seam 3, in process (spec §8, §16 Carriers; spike C): the chore surface of
// `grimoire mcp`. The server lists the 4 chore tools under the neutral chore
// description and serves the `chores` prompt; and a whole in-session chore run,
// made by a stub agent in the `grimoire-chores` subagent (its hint filled by
// grimoire's own PreToolUse hook from the real payload, checked against the
// call's `_meta`), ends with grimoire's own summary and nothing else.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { tmpdir } from 'node:os';
import { describe, expect } from 'vitest';
import { readFixtureJson } from '#harness';
import type { Core } from '../../../src/core';
import { CHORE_PROCEDURE, CHORES_PROMPT_TEXT } from '../../../src/knowledge/chores/offering';
import { preToolUse } from '../../../src/surfaces/hooks/pre-tool-use';
import { grimoireServerFactory } from '../../../src/surfaces/mcp/server';
import { Clock, terminal, workPair } from '../../core/chore-support';
import { coreTest as test, T0 } from '../../core/support';

const CHORE_TOOLS = ['chore_start', 'chore_read', 'chore_submit', 'chore_abandon'];
const CHORE_DESCRIPTION = 'Grimoire maintenance chore. Use only while following the grimoire-chores skill.';

/** Serves `core` for `dir` in-process and connects a client of `era`. */
async function serve(core: Core, dir: string, era: 'legacy' | 'modern'): Promise<{ client: Client; close(): Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(grimoireServerFactory({ core: async () => core, startDir: dir, nonce: 'nonce-chores' }), { transport: serverSide });
  const client =
    era === 'legacy'
      ? new Client({ name: 'some-client', version: '1.0.0' }, { supportedProtocolVersions: ['2025-06-18'] })
      : new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await handle.close();
    },
  };
}

describe('the chore surface of grimoire mcp', () => {
  test('lists the 4 chore tools, each with the neutral chore description, and serves the chores prompt carrying the procedure', async ({ world, grimoire }) => {
    for (const era of ['legacy', 'modern'] as const) {
      const { client, close } = await serve(grimoire.core, world.a.dir, era);
      try {
        const { tools } = await client.listTools();
        const chores = tools.filter((tool) => tool.name.startsWith('chore_'));
        expect(chores.map((tool) => tool.name).sort(), era).toEqual([...CHORE_TOOLS].sort());
        for (const tool of chores) {
          // Never mentioning the wiki.
          expect(tool.description, `${era} ${tool.name}`).toBe(CHORE_DESCRIPTION);
        }

        const { prompts } = await client.listPrompts();
        expect(prompts.map((prompt) => prompt.name), era).toEqual(['chores']);
        const prompt = await client.getPrompt({ name: 'chores' });
        expect(prompt.messages, era).toEqual([{ role: 'user', content: { type: 'text', text: CHORES_PROMPT_TEXT } }]);
        expect(CHORES_PROMPT_TEXT).toContain(CHORE_PROCEDURE);
        await expect(client.getPrompt({ name: 'wiki' }), era).rejects.toThrow(/chores/);
      } finally {
        await close();
      }
    }
  });

  test('a stub agent in the grimoire-chores subagent runs a whole chore through MCP and ends with only grimoire’s summary', async ({ world, grimoire }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
    const fail = await workPair(core, grimoire.ctx, 'fail');
    clock.advance(25);
    const { client, close } = await serve(core, world.a.dir, 'modern');

    /** One tool call as the chore subagent makes it: grimoire's PreToolUse hook fills the hint from the real payload; `_meta` names the same call. */
    let calls = 0;
    const call = async (tool: string, input: Record<string, unknown>): Promise<Record<string, any>> => {
      const toolUseId = `toolu_stub_${++calls}`;
      const payload = { ...readFixtureJson<Record<string, unknown>>('claude-code/hook-payloads/pre-tool-use-chore-subagent.json'), tool_name: `mcp__grimoire__${tool}`, tool_input: input, tool_use_id: toolUseId };
      const hooked = JSON.parse(await preToolUse(JSON.stringify(payload), { startDir: tmpdir() })) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } };
      const result = await client.callTool({ name: tool, arguments: hooked.hookSpecificOutput.updatedInput, _meta: { 'claudecode/toolUseId': toolUseId } });
      return result.structuredContent as Record<string, any>;
    };

    /** The stub agent: the procedure's steps, with a result that consumes every pair as no_pattern. */
    const stubAgent = async (): Promise<string> => {
      const brief = await call('chore_start', {});
      expect(brief, JSON.stringify(brief)).toMatchObject({ kind: 'wiki-maintainer', isolation: 'claude-chore-agent' });
      let cursor: string | undefined;
      do {
        const page = await call('chore_read', { run: brief.run, ...(cursor ? { cursor } : {}) });
        cursor = page.cursor;
      } while (cursor);
      const consumption = (brief.pairs as { pair: string }[]).map(({ pair }) => ({ pair, no_pattern: 'STUB-REASON nothing recurs' }));
      let last = await call('chore_submit', { run: brief.run, result: { pages: [], consumption, client: 'stub', model: 'stub' } });
      // Step 6: the Skill Proposer, if it became due.
      const proposer = await call('chore_start', { kind: 'skill-proposer' });
      if (!proposer.error) last = proposer;
      return last.summary as string;
    };

    try {
      const answer = await stubAgent();
      expect(answer).toMatch(/^grimoire chores: compile done, 1 trace, 0 pages \(0 created, 0 updated\); run \S+$/);
      expect(answer).not.toContain('STUB-REASON');
      expect(answer).not.toContain(fail);
    } finally {
      await close();
    }
  });
});
