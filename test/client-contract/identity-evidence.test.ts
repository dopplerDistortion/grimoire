// Seam 2 (spec Testing Decisions; §14 Identity is observed; §8 the reserved
// hint key; spikes A and B (T1, T2) and E (T6)): the `tools/call` requests both
// clients really sent, turned into identity evidence. Identity is observed,
// never claimed: a Claude Code hint counts only when its tool-use id matches
// the call's own `_meta`, and Codex's per-call `_meta` names the session (the
// root thread), the context (the calling thread) and the call.
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureJson } from '#harness';
import { mcpCallEvidence } from '../../src/capture/evidence';
import type { McpCallFacts } from '../../src/core';
import { metaIds, takeHint } from '../../src/surfaces/mcp/hint';

interface ToolsCall {
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}

/** What the MCP surface hands the core for this request: the hint taken out of the raw arguments, and `_meta`'s ids. */
function factsOf(call: ToolsCall): McpCallFacts {
  const { hint } = takeHint(call.params.arguments);
  return { era: 'legacy', hint, meta: call.params._meta === undefined ? null : metaIds(call.params._meta) };
}

const claudeCall = () => readFixtureJson<ToolsCall>('claude-code/meta/tools-call.json');
const codexCall = () => readFixtureJson<ToolsCall>('codex/meta/tools-call.json');
const codexSubagentCall = () => readFixtureJson<ToolsCall>('codex/meta/tools-call-subagent.json');

describe('Claude Code: the hint, validated against _meta', () => {
  it("a hinted call whose tool_use_id matches _meta gives the session, the main context and the call, and keeps no path", () => {
    const call = claudeCall();
    const hint = call.params.arguments!._grimoire_hint as Record<string, string>;
    // Spike A's probe named its key `_grimoire_hint`; the real key is `_grimoire`.
    const real = { params: { ...call.params, arguments: { ref: 'gr-1', _grimoire: hint } } };

    const evidence = mcpCallEvidence(factsOf(real));

    expect(evidence).toEqual({
      session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5',
      context: 'main',
      callId: 'toolu_015PCZBt35Z3Yy1hx37HDZqV',
      source: 'hint',
      pendingHint: null,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/Users|jsonl|\\/);
  });

  it("a subagent's hint names the subagent as the context, and carries its agent type", () => {
    const payload = readFixtureJson<Record<string, string>>('claude-code/hook-payloads/pre-tool-use-chore-subagent.json');
    // The tools/call Claude Code sent for that very payload, with the hint the hook adds.
    const call = readFixtureJson<ToolsCall>('claude-code/meta/tools-call-chore-subagent.json');
    const { session_id, tool_use_id, agent_id, agent_type } = payload;
    const hinted = { params: { ...call.params, arguments: { _grimoire: { session_id, tool_use_id, agent_id, agent_type } } } };

    expect(mcpCallEvidence(factsOf(hinted))).toEqual({
      session: 'c2eb58d9-ccb7-4978-bc0e-35f624a5266b',
      context: 'a523fef26307d8241',
      callId: 'toolu_01JKJLE75F1oWW6KxurK5paA',
      agentType: 'grimoire-chores',
      source: 'hint',
      pendingHint: null,
    });
  });

  it("a hint whose tool_use_id doesn't match _meta claims nothing: only _meta's tool-use id is left, for the cut to join", () => {
    const call = claudeCall();
    const forged = {
      params: {
        ...call.params,
        arguments: { ref: 'gr-1', _grimoire: { session_id: 'someone-else', tool_use_id: 'toolu_guessed', agent_id: 'a1', agent_type: 'grimoire-chores' } },
      },
    };

    expect(mcpCallEvidence(factsOf(forged))).toEqual({
      callId: 'toolu_015PCZBt35Z3Yy1hx37HDZqV',
      source: 'tool-use-id',
      pendingHint: null,
    });
  });

  it('a forged agent_type among the plain arguments is ignored', () => {
    const call = claudeCall();
    const hint = call.params.arguments!._grimoire_hint as Record<string, string>;
    const forged = { params: { ...call.params, arguments: { ref: 'gr-1', agent_type: 'grimoire-chores', agent_id: 'a1', _grimoire: hint } } };

    const evidence = mcpCallEvidence(factsOf(forged));

    expect(evidence.agentType).toBeUndefined();
    expect(evidence.context).toBe('main');
  });

  it("a call without the hook (Claude Code's real one) has only _meta's tool-use id", () => {
    const call = readFixture('claude-code/mcp/session-no-hook/c2s.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ToolsCall & { method: string })
      .find((message) => message.method === 'tools/call')!;

    expect(mcpCallEvidence(factsOf(call))).toEqual({ callId: 'toolu_01JuwEm4ubT1Xr7dS1h95M9i', source: 'tool-use-id', pendingHint: null });
  });

  it('a hint on a call with no _meta claims nothing yet: it waits for a cut to find its tool_use_id in the transcript', () => {
    const call = claudeCall();
    const hint = call.params.arguments!._grimoire_hint as Record<string, string>;
    const { _meta: _none, ...params } = call.params;

    expect(mcpCallEvidence(factsOf({ params: { ...params, arguments: { ref: 'gr-1', _grimoire: hint } } }))).toEqual({
      source: null,
      pendingHint: { session_id: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', tool_use_id: 'toolu_015PCZBt35Z3Yy1hx37HDZqV' },
    });
  });
});

describe("Codex: the per-call _meta (spike E, T6)", () => {
  it('a root-thread call: session = the root thread, context = the thread, and the call id', () => {
    const { params } = codexCall();

    expect(mcpCallEvidence(factsOf(codexCall()))).toEqual({
      session: '01a12946-7d23-7f93-b8c8-aa18d1bca5ef',
      context: '01a12946-7d23-7f93-b8c8-aa18d1bca5ef',
      callId: params._meta!.callId,
      source: 'meta',
      pendingHint: null,
    });
  });

  it("a subagent thread's call: the session is still the root, the context is the subagent's thread", () => {
    expect(mcpCallEvidence(factsOf(codexSubagentCall()))).toEqual({
      session: '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72',
      context: '01a12947-16a2-7152-be00-4e4b1e12a4d8',
      callId: 'call_5_0',
      source: 'meta',
      pendingHint: null,
    });
  });

  it("a Codex that sends no top-level sessionId (up to at least 0.150.0): the turn metadata's session_id is the session", () => {
    for (const fixture of [codexCall(), codexSubagentCall()]) {
      const { sessionId, ...older } = fixture.params._meta!;
      const evidence = mcpCallEvidence(factsOf({ params: { ...fixture.params, _meta: older } }));

      expect(evidence.session).toBe(sessionId);
      expect(evidence.context).toBe(fixture.params._meta!.threadId);
      expect(JSON.stringify(evidence)).not.toMatch(/Users|workspaces|gpt/);
    }
  });

  it('a Codex that sends no callId (0.140.0) gives no call id: the binding call is then found by tool name and time (T6 fallback)', () => {
    const { params } = codexSubagentCall();
    const { callId: _none, sessionId: _alsoNone, ...v0140 } = params._meta!;

    expect(mcpCallEvidence(factsOf({ params: { ...params, _meta: v0140 } }))).toEqual({
      session: '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72',
      context: '01a12947-16a2-7152-be00-4e4b1e12a4d8',
      source: 'meta',
      pendingHint: null,
    });
  });

  it('a reserved key a Codex model wrote itself (Codex runs no grimoire hook) is ignored', () => {
    const { params } = codexCall();
    const forged = {
      params: { ...params, arguments: { ...params.arguments, _grimoire: { session_id: 'mine', tool_use_id: 'call_2_0', agent_type: 'grimoire-chores' } } },
    };

    expect(mcpCallEvidence(factsOf(forged))).toMatchObject({ session: params._meta!.sessionId, source: 'meta', pendingHint: null });
    expect(mcpCallEvidence(factsOf(forged)).agentType).toBeUndefined();
  });
});

describe('a generic MCP client', () => {
  it('a call with neither a hint nor _meta has no evidence: its writes are joined by the server-process nonce', () => {
    expect(mcpCallEvidence({ era: 'legacy', hint: null, meta: null })).toEqual({ source: null, pendingHint: null });
    expect(mcpCallEvidence({ era: 'modern', hint: null, meta: { progressToken: 3 } })).toEqual({ source: null, pendingHint: null });
  });
});
