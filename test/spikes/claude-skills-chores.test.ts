// Spike C (GOK-128): the Claude Code behaviours that evolved-skill delivery and the
// chore carrier rest on, encoded against the real artifacts the spike captured.
// Findings: docs/research/spikes/claude-skills-chores.md
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureJson } from '#harness';

interface HookPayload {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  tool_name?: string;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
}

interface ToolsCall {
  method: string;
  params: { name: string; arguments: unknown; _meta: Record<string, unknown> };
}

type Block = { type: string; [key: string]: unknown };
interface TranscriptLine {
  type: string;
  uuid?: string;
  isMeta?: boolean;
  sourceToolUseID?: string;
  message?: { role: string; content: string | Block[] };
}

const hook = (name: string) => readFixtureJson<HookPayload>(`claude-code/hook-payloads/${name}`);

const transcript = (name: string): TranscriptLine[] =>
  readFixture(`claude-code/transcripts/${name}`)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);

const toolUses = (lines: TranscriptLine[]) =>
  lines.flatMap((line, index) =>
    line.type === 'assistant' && Array.isArray(line.message?.content)
      ? line.message.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ index, id: block.id as string, name: block.name as string, input: block.input as Record<string, string> }))
      : [],
  );

describe('C1: the chore subagent is identified in PreToolUse payloads', () => {
  it("names the forked grimoire-chores subagent by agent_type, with an agent_id, for its grimoire tool calls", () => {
    const payload = hook('pre-tool-use-chore-subagent.json');
    expect(payload.hook_event_name).toBe('PreToolUse');
    expect(payload.tool_name).toBe('mcp__grimoire__chore_start');
    expect(payload.agent_type).toBe('grimoire-chores');
    expect(payload.agent_id).toMatch(/^\S+$/);
  });

  it("carries the parent session's transcript_path, not the subagent's", () => {
    const payload = hook('pre-tool-use-chore-subagent.json');
    expect(payload.transcript_path.endsWith(`${payload.session_id}.jsonl`)).toBe(true);
  });

  it('pairs with the tools/call by tool_use_id, and _meta itself carries no agent identity', () => {
    const payload = hook('pre-tool-use-chore-subagent.json');
    const call = readFixtureJson<ToolsCall>('claude-code/meta/tools-call-chore-subagent.json');
    expect(call.method).toBe('tools/call');
    expect(call.params.name).toBe('chore_start');
    expect(call.params._meta['claudecode/toolUseId']).toBe(payload.tool_use_id);
    expect(Object.keys(call.params._meta).sort()).toEqual(['claudecode/toolUseId', 'progressToken']);
  });

  it('gives another subagent its own agent_type, and the main context neither field', () => {
    expect(hook('pre-tool-use-general-purpose-subagent.json').agent_type).toBe('general-purpose');
    const main = hook('pre-tool-use-main-context.json');
    expect(main.tool_name).toBe('mcp__grimoire__chore_start');
    expect(main).not.toHaveProperty('agent_id');
    expect(main).not.toHaveProperty('agent_type');
  });

  it("finds the subagent's own transcript at <session>/subagents/agent-<agent_id>.jsonl, typed by its meta file", () => {
    const start = hook('subagent-start-chore-subagent.json');
    expect(start.agent_type).toBe('grimoire-chores');
    const dir = `chore-fork/${start.session_id}/subagents/agent-${start.agent_id}`;
    expect(readFixtureJson<{ agentType: string }>(`claude-code/transcripts/${dir}.meta.json`).agentType).toBe(
      'grimoire-chores',
    );
    const calls = toolUses(transcript(`${dir}.jsonl`)).map((use) => use.name);
    expect(calls).toEqual([
      'ToolSearch',
      'mcp__grimoire__chore_start',
      'mcp__grimoire__chore_read',
      'mcp__grimoire__chore_submit',
    ]);
  });
});

describe('P2: Claude Code matches a self-ignoring stub by description, then reads the copy', () => {
  const COPY = '.grimoire/skills/changelog-entry/SKILL.md';
  const readsCopy = (use: { name: string; input: Record<string, string> }) => {
    const target = use.name === 'Read' ? use.input.file_path : use.name === 'Bash' ? use.input.command : '';
    return (target ?? '').replace(/\\/g, '/').includes(COPY);
  };

  for (const [name, reader] of [
    ['stub-match-read-tool.jsonl', 'Read'],
    ['stub-match-shell-read.jsonl', 'Bash'],
  ] as const) {
    it(`invokes the grimoire- stub first, then reads the copy (${reader})`, () => {
      const lines = transcript(name);
      const uses = toolUses(lines);
      expect(uses[0]).toMatchObject({ name: 'Skill', input: { skill: 'grimoire-changelog-entry' } });
      const read = uses.find(readsCopy);
      expect(read?.name).toBe(reader);
      expect(read!.index).toBeGreaterThan(uses[0]!.index);

      // The stub body reaches the model as a meta user message tied to the Skill call.
      const body = lines.find((line) => line.isMeta && line.sourceToolUseID === uses[0]!.id);
      const text = JSON.stringify(body?.message?.content);
      expect(text).toContain('Generated by grimoire. Read and follow `.grimoire/skills/changelog-entry/SKILL.md`.');
    });
  }
});

describe('B1: the SessionStart payload the fast path receives', () => {
  it('is a startup event with the session id and transcript path', () => {
    const payload = hook('session-start-startup.json');
    expect(payload.hook_event_name).toBe('SessionStart');
    expect(payload.source).toBe('startup');
    expect(payload.transcript_path.endsWith(`${payload.session_id}.jsonl`)).toBe(true);
  });
});
