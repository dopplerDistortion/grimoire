// Spike F (GOK-131) P5, role-config side: a skill instruction makes the root
// thread spawn the `grimoire-chores` role (a project role file in
// .codex/agents/) with a fresh context. What reaches the child thread: the
// role's developer_instructions, its tool list (shell disabled), the grimoire
// MCP tools, and none of the root's history?
//
//   node p5-role.mjs <scratch-dir> <fresh|fork>
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findFiles, git, KIT, mkRepo, plan, readRequests, runCodex, startMock, writeFile, writeHome } from './kit.mjs';

const [scratchArg = '.', variant = 'fresh'] = process.argv.slice(2);
const scratch = path.resolve(scratchArg);
const R = path.join(scratch, 'runs', `p5-${variant}`);
const W = mkRepo(path.join(R, 'work'));
const home = path.join(R, 'home');
const mcpLog = path.join(R, 'mcp.jsonl');
rmSync(mcpLog, { force: true });

const ROLE_MARKER = 'GRIM-P5-ROLE-INSTRUCTIONS';
const ROOT_MARKER = 'GRIM-P5-ROOT-ONLY-CONTEXT';

writeFile(path.join(W, '.grimoire/config.yml'), 'version: 0.0.0\n');
writeFile(
  path.join(W, '.codex/agents/grimoire-chores.toml'),
  `name = "grimoire-chores"
description = "Runs grimoire's due maintenance chores with the grimoire chore tools only. Spawn it only from the grimoire-chores skill."
developer_instructions = """
${ROLE_MARKER}
Run grimoire's due maintenance chore with the grimoire chore tools (chore_start, chore_read, chore_submit, chore_abandon).
1. Call chore_start. 2. Page the inputs with chore_read. 3. Reason. 4. Submit with chore_submit.
5. At most one fix-up. 6. Run the Skill Proposer if it became due. 7. Return the last summary verbatim.
Never edit files and never ask for approval.
"""

[features]
shell_tool = false
apps = false
plugins = false
memories = false
request_permissions_tool = false

[skills]
include_instructions = false
`,
);
writeFile(
  path.join(W, '.agents/skills/grimoire-chores/SKILL.md'),
  `---
name: grimoire-chores
description: Run grimoire's due maintenance chores in an isolated subagent. Use when grimoire's session notice says one is due and the user agrees, or when the user asks.
---

Spawn a subagent with \`spawn_agent\`, \`agent_type\` set to \`grimoire-chores\` and \`fork_context\` set to \`false\` (on the v2 tool: \`fork_turns: "none"\`). Give it the message "Run the due grimoire chore." Wait for it, then return its final message verbatim.

If spawning is unavailable, run the chore here instead: call \`chore_start\`, page with \`chore_read\`, submit with \`chore_submit\`, and return the last summary verbatim.
`,
);
const stubMcp = path.join(KIT, 'stub-mcp.mjs').replaceAll('\\', '/');
writeFile(
  path.join(W, '.codex/config.toml'),
  `[mcp_servers.grimoire]\ncommand = "node"\nargs = [${JSON.stringify(stubMcp)}]\nenv = { GOK131_MCP_LOG = ${JSON.stringify(mcpLog.replaceAll('\\', '/'))} }\n`,
);
git(W, 'add', '.');
git(W, '-c', 'user.email=a@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'setup');

const mock = await startMock(path.join(R, 'mock'));
writeHome(home, mock.port, { trust: [W] });

const child = [
  { call: 'exec_command', args: { cmd: 'Get-ChildItem' } },
  { call: 'apply_patch', custom: true, input: '*** Begin Patch\n*** Add File: chore-wrote.txt\n+written by the chore role\n*** End Patch\n' },
  { search: 'grimoire chore_start chore', limit: 8 },
  { call: 'chore_start', ns: 'mcp__grimoire', args: {} },
  { say: 'grimoire chores: compile done (stub), 0 traces' },
];
const root = [
  { call: 'exec_command', args: { cmd: 'Get-Content .agents/skills/grimoire-chores/SKILL.md' } },
  { search: 'spawn agent subagent wait', limit: 12 },
  {
    call: 'spawn_agent',
    ns: 'multi_agent_v1',
    args: { agent_type: 'grimoire-chores', fork_context: variant === 'fork', message: `Run the due grimoire chore. ${plan(child)}` },
  },
  { call: 'wait_agent', ns: 'multi_agent_v1', args: { targets: ['$AGENT'], timeout_ms: 60000 } },
  { say: 'chores done' },
];
const prompt = `${ROOT_MARKER}: run the grimoire chores. ${plan(root)}`;
const result = await runCodex(['exec', '--json', '-s', 'danger-full-access', '--skip-git-repo-check', prompt], { cwd: W, home });
mock.stop();
writeFileSync(path.join(R, 'stdout.jsonl'), result.stdout);
writeFileSync(path.join(R, 'stderr.txt'), result.stderr);

/**
 * A Responses API input item (only the fields read here).
 * @typedef {{ type: string, role?: string, content?: { text?: string }[], output?: unknown, tools?: { name: string, tools?: { name: string }[] }[] }} Item
 */
/** @typedef {{ input?: Item[], tools?: { name?: string, type: string }[] }} Body */

const reqs = readRequests(path.join(R, 'mock')).filter((r) => r.url.includes('/responses'));
const threads = [...new Set(reqs.map((r) => r.headers['thread-id']))];
/** @param {Body} b */
const devText = (b) =>
  (b.input ?? [])
    .filter((i) => i.role === 'developer')
    .flatMap((i) => (i.content ?? []).map((c) => c.text ?? ''))
    .join('\n');
/** @param {Body} b */
const allText = (b) => JSON.stringify(b.input ?? []);
for (const t of threads) {
  const mine = reqs.filter((r) => r.headers['thread-id'] === t);
  /** @type {Body} */
  const first = mine[0]?.body ?? {};
  /** @type {Body} */
  const last = mine.at(-1)?.body ?? {};
  console.log(
    JSON.stringify({
      thread: t,
      requests: mine.length,
      tools: (first.tools ?? []).map((x) => x.name ?? x.type),
      roleInstructions: devText(first).includes(ROLE_MARKER),
      rootContextSeen: allText(first).includes(ROOT_MARKER),
      outputs: (last.input ?? [])
        .filter((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output')
        .map((i) => String(i.output).slice(0, 120)),
      searchTools: (last.input ?? [])
        .filter((i) => i.type === 'tool_search_output')
        .flatMap((i) => (i.tools ?? []).map((x) => `${x.name}:${(x.tools ?? []).map((y) => y.name).join('/')}`)),
    }),
  );
}
/** @type {{ msg: { method?: string, params?: unknown } }[]} */
const mcp = readFileSync(mcpLog, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
for (const m of mcp.filter((m) => m.msg.method === 'tools/call')) console.log('MCP call', JSON.stringify(m.msg.params));
console.log('exit', result.code, 'chore-wrote.txt exists:', existsSync(path.join(W, 'chore-wrote.txt')));
for (const f of findFiles(path.join(home, 'sessions'))) console.log('rollout', f);
