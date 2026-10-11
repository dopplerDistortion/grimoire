// Spike F (GOK-131): the Codex CLI 0.162.1 behaviours that skill delivery, the
// Codex chore carrier and the `codex exec` runner rest on, encoded against the
// real, sanitized artifacts the spike captured (seam 2).
// Findings and verdicts: docs/research/spikes/codex-skills-role-exec.md.
//
// Codex was never logged in: model turns came from a scripted stand-in for the
// Responses API (test/spikes/codex-skills-role-exec/scripted-responses.mjs).
// Everything else in these artifacts is the real Codex binary, except
// `exec-json/runner/not-logged-in.jsonl`, which had no stand-in at all.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixturePath, readFixture } from '#harness';

interface RolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown> & { type?: string };
}

interface ExecEvent {
  type: string;
  thread_id?: string;
  message?: string;
  item?: { id: string; type: string; text?: string; message?: string };
  error?: { message: string };
}

interface ParsedCommand {
  type: string;
  path?: string;
}

interface CommandExecution {
  type: 'CommandExecution';
  parsed_cmd: ParsedCommand[];
  aggregated_output: string;
  exit_code: number;
}

const jsonl = <T>(name: string): T[] =>
  readFixture(name)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);

/** The rollouts in a fixture folder, keyed by thread id (from the file name). */
function rollouts(folder: string): Map<string, RolloutLine[]> {
  const out = new Map<string, RolloutLine[]>();
  for (const file of readdirSync(fixturePath(folder)).filter((f) => f.endsWith('.jsonl')).sort()) {
    const threadId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1];
    if (threadId) out.set(threadId, jsonl<RolloutLine>(`${folder}/${file}`));
  }
  return out;
}

/** Splits a rollout into turns at each `task_started` event. */
function turns(lines: RolloutLine[]): RolloutLine[][] {
  const out: RolloutLine[][] = [];
  for (const line of lines) {
    if (line.type === 'event_msg' && line.payload.type === 'task_started') out.push([]);
    out.at(-1)?.push(line);
  }
  return out;
}

const textOf = (line: RolloutLine): string =>
  Array.isArray(line.payload.content)
    ? (line.payload.content as { text?: string }[]).map((c) => c.text ?? '').join('')
    : '';

const isMessage = (line: RolloutLine, role: string) =>
  line.type === 'response_item' && line.payload.type === 'message' && line.payload.role === role;

/** The `<skills_instructions>` listings Codex put in front of the model. */
const skillListings = (lines: RolloutLine[]) =>
  lines.filter((l) => isMessage(l, 'developer') && textOf(l).includes('<skills_instructions>')).map(textOf);

const commandExecutions = (lines: RolloutLine[]): CommandExecution[] =>
  lines
    .filter((l) => l.type === 'event_msg' && l.payload.type === 'item_completed')
    .map((l) => l.payload.item as { type: string })
    .filter((item): item is CommandExecution => item.type === 'CommandExecution');

const sessionMeta = (lines: RolloutLine[]) => lines[0]?.payload as Record<string, unknown> & { cwd: string };

describe('B2, root created mid-session: a repo with no .agents/ folder when the thread starts', () => {
  const [[, lines]] = [...rollouts('codex/transcripts/skill-stub-read')] as [[string, RolloutLine[]]];
  const [turn1, turn2, turn3] = turns(lines) as [RolloutLine[], RolloutLine[], RolloutLine[]];

  it('the session has three turns on one thread', () => {
    expect(turns(lines)).toHaveLength(3);
  });

  it("turn 1's listing holds no grimoire stub", () => {
    const [listing] = skillListings(turn1);
    expect(listing).toBeDefined();
    expect(listing).not.toContain('grimoire-');
  });

  it("turn 2 opens with a new full listing naming both stubs under the repo's self-ignoring .agents/skills root", () => {
    const listings = skillListings(turn2);
    expect(listings).toHaveLength(1);
    const listing = listings[0] as string;
    const root = `${sessionMeta(lines).cwd.replaceAll('\\', '/')}/.agents/skills`;
    expect(listing).toContain(`- \`r1\` = \`${root}\``);
    expect(listing).toContain(
      '- grimoire-hook-skill: Rotate the hook ledger in this repo. Use when the user asks to rotate, roll or archive the hook ledger. (file: r1/grimoire-hook-skill/SKILL.md)',
    );
    expect(listing).toContain(
      '- grimoire-tidewater-ledger: Reconcile the tidewater ledger files in this repo. Use when the user asks to reconcile, balance or settle the tidewater ledger. (file: r1/grimoire-tidewater-ledger/SKILL.md)',
    );
  });

  it('the turn-2 listing is recorded as a partial world_state update of host_skills', () => {
    const update = turn2.find((l) => l.type === 'world_state');
    expect(update?.payload.full).toBe(false);
    expect(Object.keys(update?.payload.state as object)).toEqual(['host_skills']);
  });

  it('a description rewritten in place during turn 2 is not re-listed in turn 3', () => {
    const rewrite = commandExecutions(turn2).find((c) => c.aggregated_output === '' && JSON.stringify(c).includes('(v2)'));
    expect(rewrite?.exit_code).toBe(0);
    expect(skillListings(turn3)).toEqual([]);
    expect(skillListings(lines).some((l) => l.includes('(v2)'))).toBe(false);
  });
});

/** The single rollout in a fixture folder. */
const onlyRollout = (folder: string): RolloutLine[] => [...rollouts(folder).values()][0] as RolloutLine[];

/** The `- grimoire-<name>: …` entry of a listing, or undefined. */
const entry = (listing: string | undefined, name: string) =>
  listing?.split('\n').find((line) => line.startsWith(`- grimoire-${name}:`));

describe('B2, root present at thread start: changes reach the next turn once the watcher delivers them', () => {
  const lines = onlyRollout('codex/transcripts/skill-roots/existing-root');
  const all = turns(lines);
  const [turn1, turn2, turn3, turn4, turn5] = all as [RolloutLine[], RolloutLine[], RolloutLine[], RolloutLine[], RolloutLine[]];
  const hookNote = (ls: RolloutLine[]) => ls.findIndex((l) => isMessage(l, 'developer') && textOf(l).startsWith('GRIM-B2-HOOK-WROTE '));

  it('the session has five turns on one thread, and turn 1 lists the committed grimoire-chores skill', () => {
    expect(all).toHaveLength(5);
    expect(entry(skillListings(turn1)[0], 'chores')).toBeDefined();
  });

  it("Codex builds turn 1's listing before the SessionStart hook runs, so the hook's stub misses turn 1", () => {
    const listingAt = turn1.findIndex((l) => isMessage(l, 'developer') && textOf(l).includes('<skills_instructions>'));
    expect(listingAt).toBeGreaterThanOrEqual(0);
    expect(hookNote(turn1)).toBeGreaterThan(listingAt);
    expect(entry(skillListings(turn1)[0], 'hook-skill')).toBeUndefined();
  });

  it('turn 2 lists the hook-written stub and the folder turn 1 wrote', () => {
    const [listing] = skillListings(turn2);
    expect(entry(listing, 'hook-skill')).toBeDefined();
    expect(entry(listing, 'tidewater-ledger')).toContain('settle the tidewater ledger. (file: r1/grimoire-tidewater-ledger/SKILL.md)');
  });

  it('changes made within 10 s of the previous watcher event wait: no new listing in turns 3 and 4', () => {
    expect(skillListings(turn3)).toEqual([]);
    expect(skillListings(turn4)).toEqual([]);
  });

  it('they are delayed, not dropped: turn 5, 11 s later, lists the turn-2 description edit and the turn-3 folder', () => {
    const [listing] = skillListings(turn5);
    expect(entry(listing, 'tidewater-ledger')).toContain('settle the tidewater ledger (v2).');
    expect(entry(listing, 'late-folder')).toBeDefined();
    const gap = Date.parse(turn5[0]?.timestamp as string) - Date.parse(turn4.at(-1)?.timestamp as string);
    expect(gap).toBeGreaterThan(10_000);
  });
});

describe('B2, root present at thread start, 11 s between turns: every change is listed in the next turn', () => {
  const lines = onlyRollout('codex/transcripts/skill-roots/existing-root-wait11000');
  const [, turn2, turn3, turn4, turn5] = turns(lines) as RolloutLine[][];

  it('turn 2 lists the folder turn 1 wrote, turn 3 the turn-2 description edit, turn 4 the folder turn 3 wrote', () => {
    expect(entry(skillListings(turn2 as RolloutLine[])[0], 'tidewater-ledger')).toContain('settle the tidewater ledger. (file:');
    expect(entry(skillListings(turn3 as RolloutLine[])[0], 'tidewater-ledger')).toContain('settle the tidewater ledger (v2).');
    expect(entry(skillListings(turn4 as RolloutLine[])[0], 'late-folder')).toBeDefined();
  });

  it('turn 5, with nothing changed, gets no new listing', () => {
    expect(skillListings(turn5 as RolloutLine[])).toEqual([]);
  });
});

describe('B2, root created mid-session, later changes: the new root is listed once and then never re-read', () => {
  const lines = onlyRollout('codex/transcripts/skill-roots/new-root-late');
  const all = turns(lines);
  const [, turn2, turn3, turn4] = all as RolloutLine[][];

  it('turn 2 lists the new root with both stubs', () => {
    const [listing] = skillListings(turn2 as RolloutLine[]);
    expect(entry(listing, 'hook-skill')).toBeDefined();
    expect(entry(listing, 'tidewater-ledger')).toContain('settle the tidewater ledger. (file:');
  });

  it('neither the turn-2 description edit nor a folder written in turn 3, each followed by an 11 s pause, is ever listed', () => {
    expect(all).toHaveLength(4);
    expect(commandExecutions(turn3 as RolloutLine[]).some((c) => c.exit_code === 0)).toBe(true);
    expect(skillListings(turn3 as RolloutLine[])).toEqual([]);
    expect(skillListings(turn4 as RolloutLine[])).toEqual([]);
    expect(skillListings(lines).some((l) => l.includes('(v2)') || l.includes('grimoire-late-folder'))).toBe(false);
  });
});

describe('P2 (Codex half, scripted model): the read signal for a stub match', () => {
  const [[, lines]] = [...rollouts('codex/transcripts/skill-stub-read')] as [[string, RolloutLine[]]];
  const turn2 = turns(lines)[1] as RolloutLine[];

  it('Codex parses each shell read into a read action naming the path: the stub first, then the copy', () => {
    const reads = commandExecutions(turn2).flatMap((c) => c.parsed_cmd.filter((p) => p.type === 'read').map((p) => p.path));
    expect(reads).toEqual(['.agents/skills/grimoire-tidewater-ledger/SKILL.md', '.grimoire/skills/tidewater-ledger/SKILL.md']);
  });

  it("the stub read returns the stub body pointing at the copy; the copy read returns the copy's procedure", () => {
    const [stub, copy] = commandExecutions(turn2);
    expect(stub?.aggregated_output).toContain('Generated by grimoire. Read and follow `.grimoire/skills/tidewater-ledger/SKILL.md`.');
    expect(copy?.aggregated_output).toContain('marker GRIM-B2-COPY-READ');
  });

  it("parsed_cmd exists only in paginated rollouts: a legacy rollout's shell read is just the exec_command call's cmd (Spike E's fixture)", () => {
    const legacy = onlyRollout('codex/transcripts/legacy');
    expect(commandExecutions(legacy)).toEqual([]);
    expect(JSON.stringify(legacy)).not.toContain('parsed_cmd');
    const cmds = legacy
      .filter((l) => l.type === 'response_item' && l.payload.type === 'function_call' && l.payload.name === 'exec_command')
      .map((l) => (JSON.parse(l.payload.arguments as string) as { cmd: string }).cmd);
    expect(cmds).toContain('Get-Content .grimoire/skills/probe/SKILL.md');
  });
});

describe('P5 (role-config side): spawn_agent with the grimoire-chores role and a fresh context', () => {
  const threads = rollouts('codex/transcripts/chore-role');
  const [root, child] = [...threads.values()].sort((a, b) =>
    sessionMeta(a).thread_source === 'user' ? -1 : sessionMeta(b).thread_source === 'user' ? 1 : 0,
  ) as [RolloutLine[], RolloutLine[]];
  const rootId = sessionMeta(root).id as string;
  const childId = sessionMeta(child).id as string;
  const items = (lines: RolloutLine[], type: string) =>
    lines.filter((l) => l.type === 'response_item' && l.payload.type === type).map((l) => l.payload);

  it('the root spawned the role with fork_context false and got the child thread id back', () => {
    const spawn = items(root, 'function_call').find((p) => p.name === 'spawn_agent');
    expect(spawn?.namespace).toBe('multi_agent_v1');
    expect(JSON.parse(spawn?.arguments as string)).toMatchObject({ agent_type: 'grimoire-chores', fork_context: false });
    const output = items(root, 'function_call_output').find((p) => p.call_id === spawn?.call_id);
    expect(JSON.parse(output?.output as string)).toMatchObject({ agent_id: childId });
  });

  it("the project role file is offered in spawn_agent's agent_type description", () => {
    const search = items(root, 'tool_search_output')[0] as { tools: { name: string; tools: { name: string; parameters: unknown }[] }[] };
    const spawn = search.tools.flatMap((ns) => ns.tools).find((t) => t.name === 'spawn_agent');
    expect(JSON.stringify(spawn?.parameters)).toContain(
      "grimoire-chores: {\\nRuns grimoire's due maintenance chores with the grimoire chore tools only. Spawn it only from the grimoire-chores skill.\\n}",
    );
  });

  it("the child's rollout names its role and its root, so capture can tell a chore thread", () => {
    const meta = sessionMeta(child);
    expect(meta).toMatchObject({
      session_id: rootId,
      parent_thread_id: rootId,
      thread_source: 'subagent',
      agent_role: 'grimoire-chores',
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_role: 'grimoire-chores' } } },
    });
    expect(sessionMeta(root)).not.toHaveProperty('agent_role');
  });

  it("the child starts fresh: the role's developer_instructions, no skills listing (the role turns it off) and none of the root's history", () => {
    const developer = child.filter((l) => isMessage(l, 'developer')).map(textOf);
    expect(developer.some((t) => t.startsWith('GRIM-P5-ROLE-INSTRUCTIONS\n'))).toBe(true);
    expect(skillListings(child)).toEqual([]);
    expect(readFixture(`codex/transcripts/chore-role/${readdirSync(fixturePath('codex/transcripts/chore-role')).find((f) => f.includes(childId))}`)).not.toContain(
      'GRIM-P5-ROOT-ONLY-CONTEXT',
    );
    expect(root.filter((l) => isMessage(l, 'user')).map(textOf).some((t) => t.startsWith('GRIM-P5-ROOT-ONLY-CONTEXT'))).toBe(true);
  });

  it('the role disabled the shell: the child exec_command call is refused as unsupported', () => {
    const call = items(child, 'function_call').find((p) => p.name === 'exec_command');
    const output = items(child, 'function_call_output').find((p) => p.call_id === call?.call_id);
    expect(output?.output).toBe('unsupported call: exec_command');
  });

  it('apply_patch stays available to the role thread: the child added a file', () => {
    const call = items(child, 'custom_tool_call').find((p) => p.name === 'apply_patch');
    const output = items(child, 'custom_tool_call_output').find((p) => p.call_id === call?.call_id);
    expect(output?.output).toContain('Success. Updated the following files:\nA chore-wrote.txt');
  });

  it("the child's grimoire call carries threadId = child and sessionId = root in _meta, and no role", () => {
    const call = jsonl<{ method: string; params: { name: string; _meta: Record<string, unknown> } }>('codex/mcp/chore-role/c2s.jsonl').find(
      (m) => m.method === 'tools/call',
    );
    expect(call?.params.name).toBe('chore_start');
    expect(call?.params._meta).toMatchObject({
      threadId: childId,
      sessionId: rootId,
      'x-codex-turn-metadata': { subagent_kind: 'thread_spawn', thread_source: 'subagent', parent_thread_id: rootId },
    });
    expect(JSON.stringify(call?.params._meta)).not.toContain('grimoire-chores');
  });
});

describe('P7 and the runner: `codex exec --json` streams of the spec §16 invocation', () => {
  const types = (name: string) => jsonl<ExecEvent>(`codex/exec-json/runner/${name}`).map((e) => e.type);
  /** The tool calls and outputs Codex sent the model in the run's last request, paired by call_id. */
  const toolIo = (name: string) => {
    const items = jsonl<{ type: string; call_id: string; name?: string; namespace?: string; output?: string }>(`codex/exec-json/runner/${name}`);
    return items
      .filter((i) => i.type === 'function_call')
      .map((call) => ({ name: call.namespace ? `${call.namespace}:${call.name}` : call.name, output: items.find((i) => i.type === 'function_call_output' && i.call_id === call.call_id)?.output }));
  };

  it('a read-only run without prefer_mxc completes with the schema-shaped answer and no command_execution item', () => {
    const events = jsonl<ExecEvent>('codex/exec-json/runner/success.jsonl');
    expect(events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(events[2]?.item?.type).toBe('agent_message');
    expect(JSON.parse(events[2]?.item?.text as string)).toEqual({ verdict: 'no_pattern', pairs: ['pair-1'] });
  });

  it('in that run both shell calls (a read, then a write) reached Codex and were refused before running: "blocked by policy"', () => {
    const io = toolIo('success.tool-io.jsonl');
    expect(io.map((c) => c.name)).toEqual(['exec_command', 'exec_command']);
    for (const call of io) {
      expect(call.output).toMatch(/^exec_command failed: CreateProcess \{ message: "Rejected\(/);
      expect(call.output).toContain('rejected: blocked by policy');
    }
  });

  it('with the shell tool turned off the stream has the same shape, and the calls got "unsupported call: exec_command"', () => {
    expect(types('no-shell-tool.jsonl')).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(toolIo('no-shell-tool.tool-io.jsonl')).toEqual([
      { name: 'exec_command', output: 'unsupported call: exec_command' },
      { name: 'exec_command', output: 'unsupported call: exec_command' },
    ]);
  });

  it('a model API error ends in error then turn.failed, carrying the API error body', () => {
    const events = jsonl<ExecEvent>('codex/exec-json/runner/model-api-error.jsonl');
    expect(events.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'error', 'turn.failed']);
    expect(JSON.parse(events[3]?.error?.message as string)).toMatchObject({ error: { message: 'scripted model-side failure' } });
  });

  it('with no login: four WebSocket reconnects (2/5 to 5/5), the HTTPS fallback item, five HTTPS reconnects, an error, then turn.failed with a 401', () => {
    const events = jsonl<ExecEvent>('codex/exec-json/runner/not-logged-in.jsonl');
    const shape = events.map((e) => {
      const reconnect = /^Reconnecting\.\.\. (\d)\/5 \(.*url: (wss|https):/.exec(e.message ?? '');
      if (e.type === 'error' && reconnect) return `reconnect ${reconnect[2]} ${reconnect[1]}`;
      if (e.item?.type === 'error') return `item error: ${e.item.message?.slice(0, 48)}`;
      return e.type;
    });
    expect(shape).toEqual([
      'thread.started',
      'turn.started',
      'reconnect wss 2',
      'reconnect wss 3',
      'reconnect wss 4',
      'reconnect wss 5',
      'item error: Falling back from WebSockets to HTTPS transport.',
      'reconnect https 1',
      'reconnect https 2',
      'reconnect https 3',
      'reconnect https 4',
      'reconnect https 5',
      'error',
      'turn.failed',
    ]);
    expect(events.at(-1)?.error?.message).toMatch(/^unexpected status 401 Unauthorized/);
  });
});

describe('C4 fallback: the final runner invocation, keeping the user config', () => {
  const events = jsonl<ExecEvent>('codex/exec-json/runner/fallback-final.jsonl');

  it('completes with the schema-shaped answer even though the stream carries reconnect errors and a fallback error item', () => {
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'turn.started',
      'error',
      'error',
      'error',
      'error',
      'item.completed',
      'item.completed',
      'turn.completed',
    ]);
    expect(events[6]?.item?.message).toMatch(/^Falling back from WebSockets to HTTPS transport\./);
    expect(JSON.parse(events[7]?.item?.text as string)).toEqual({ verdict: 'no_pattern', pairs: ['pair-1'] });
  });

  it("the model has no shell, and the user config's MCP server is not there to call", () => {
    const items = jsonl<{ type: string; call_id: string; name?: string; namespace?: string; output?: string }>(
      'codex/exec-json/runner/fallback-final.tool-io.jsonl',
    );
    const outputs = items.filter((i) => i.type === 'function_call_output').map((i) => i.output);
    expect(outputs).toEqual(['unsupported call: exec_command', 'unsupported call: mcp__usermcpchore_start']);
  });
});
