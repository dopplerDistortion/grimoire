// Seam 1 for the installer (spec Testing Decisions): the manifest and pointer
// writers, driven directly against real temporary checkouts. What each file
// must hold comes from spec §11 and spikes A, C and E.
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { gitTest } from '#harness';
import { BOOTSTRAP, codexHookCommand } from '../../src/installer';
import { readManifest, type ClientName } from '../../src/installer/manifest';
import { desiredEntries, type PointerOptions } from '../../src/installer/pointers';
import { parseToml } from '../../src/installer/toml';
import { applyFiles, planFiles } from '../../src/installer/writer';
import { SERVER_INSTRUCTIONS } from '../../src/instructions';
import { adapterBlockBody } from '../../src/installer/texts';
import { createCore } from '../../src/core';
import { parseCommand } from '../../src/surfaces/cli/args';

const BOTH: ClientName[] = ['claude-code', 'codex'];
const OPTIONS: PointerOptions = { clients: BOTH, npmScript: false, adapter: 'end' };

async function install(root: string, options: Partial<PointerOptions> = {}, restoreGrants = false) {
  const plan = await planFiles(root, desiredEntries({ ...OPTIONS, ...options }), { restoreGrants });
  const applied = await applyFiles(plan);
  return { plan, applied };
}

const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8');
const readJson = async (root: string, file: string) => JSON.parse(await read(root, file)) as Record<string, any>;

/** The `[[hooks.SessionStart]]` groups of a Codex config, as Codex orders them. */
function sessionStartCommands(toml: string): string[] {
  const parsed = parseToml(toml) as { hooks?: { SessionStart?: { hooks: { command: string }[] }[] } };
  return (parsed.hooks?.SessionStart ?? []).map((group) => group.hooks[0]!.command);
}

describe('a first install into a checkout', () => {
  gitTest('writes each client’s pointer files and the dotfolder files, and the manifest records every entry', async ({ world }) => {
    const root = world.a.dir;
    const { applied } = await install(root);

    const mcp = await readJson(root, '.mcp.json');
    expect(mcp).toEqual({ mcpServers: { grimoire: { command: 'node', args: ['-e', BOOTSTRAP, 'mcp'] } } });

    const settings = await readJson(root, '.claude/settings.json');
    expect(settings.permissions.allow).toEqual(['mcp__grimoire']);
    expect(settings.enabledMcpjsonServers).toEqual(['grimoire']);
    // Spike A R3: `--` ends node's options, so `--from` reaches the bootstrap.
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'mcp__grimoire__.*',
        hooks: [{ type: 'command', command: 'node', args: ['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'pre-tool-use'], timeout: 5 }],
      },
    ]);
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'node', args: ['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'session-start'], timeout: 10 }] },
    ]);
    expect(await read(root, '.claude/rules/grimoire.md')).toContain(SERVER_INSTRUCTIONS);

    const toml = await read(root, '.codex/config.toml');
    const codex = parseToml(toml) as Record<string, any>;
    expect(codex.mcp_servers.grimoire).toEqual({
      command: 'node',
      args: ['-e', BOOTSTRAP, 'mcp'],
      env_vars: [
        'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
      ],
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
      default_tools_approval_mode: 'approve',
    });
    expect(codex.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: codexHookCommand(), timeout: 10 }] }]);
    expect(toml).toMatch(/^# >>> grimoire \(managed block\)\n[\s\S]*# <<< grimoire\n$/);

    const agents = await read(root, 'AGENTS.md');
    expect(agents).toBe(`<!-- >>> grimoire (managed block) -->\n## grimoire\n\n${SERVER_INSTRUCTIONS}\n<!-- <<< grimoire -->\n`);
    expect(await read(root, '.grimoire/.gitattributes')).toBe('* text=auto eol=lf\n');
    expect(await read(root, 'docs/agents/issue-tracker.md')).toMatch(/^<!-- >>> grimoire issue-tracker-grimoire\.md \(managed block\) -->\n# Issue tracker: grimoire\n/);
    expect(await read(root, 'docs/agents/triage-labels.md')).toContain('`ready-for-agent`');
    expect(existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(path.join(root, 'package.json'))).toBe(false);

    const manifest = await readManifest(root);
    expect(manifest.entries.map((entry) => [entry.path, entry.kind, entry.created])).toEqual([
      ['.grimoire/.gitattributes', 'file', true],
      ['.grimoire/run.cjs', 'file', true],
      ['.mcp.json', 'json-key', true],
      ['.claude/settings.json', 'json-array-item', true],
      ['.claude/settings.json', 'json-array-item', true],
      ['.claude/settings.json', 'json-array-item', true],
      ['.claude/settings.json', 'json-array-item', true],
      ['.claude/rules/grimoire.md', 'file', true],
      ['.claude/skills/grimoire-chores/SKILL.md', 'file', true],
      ['.claude/agents/grimoire-chores.md', 'file', true],
      ['.codex/config.toml', 'toml-table', true],
      ['AGENTS.md', 'marker-block', true],
      ['.agents/skills/grimoire-chores/SKILL.md', 'file', true],
      ['.codex/agents/grimoire-chores.toml', 'file', true],
      ['docs/agents/issue-tracker.md', 'marker-block', true],
      ['docs/agents/triage-labels.md', 'seeded-file', true],
    ]);
    expect(manifest.entries.filter((entry) => entry.permission).map((entry) => entry.item ?? entry.path)).toEqual([
      'mcp__grimoire',
      'grimoire',
      '.codex/config.toml',
    ]);
    // Every file written is in the manifest, and the manifest is written last.
    expect(applied.written.at(-1)).toBe('.grimoire/manifest.yml');
    expect(new Set(applied.written.slice(0, -1))).toEqual(new Set(manifest.entries.map((entry) => entry.path)));
  });

  gitTest('a second run on the same checkout writes nothing', async ({ world }) => {
    await install(world.a.dir);
    const { plan, applied } = await install(world.a.dir);

    expect(applied.written).toEqual([]);
    expect(new Set(plan.entries.map((entry) => entry.action))).toEqual(new Set(['unchanged']));
  });

  gitTest('managed files checked out with CRLF line endings or a byte order mark, or JSON re-indented, are unchanged: nothing is written', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');
    for (const file of ['.claude/rules/grimoire.md', '.codex/config.toml', '.grimoire/run.cjs', '.grimoire/manifest.yml']) {
      await writeFile(path.join(root, file), crlf(await read(root, file)));
    }
    await writeFile(path.join(root, 'AGENTS.md'), `﻿${crlf(await read(root, 'AGENTS.md'))}`);
    await writeFile(path.join(root, '.mcp.json'), `﻿${await read(root, '.mcp.json')}`);
    await writeFile(path.join(root, '.claude/settings.json'), crlf(`${JSON.stringify(await readJson(root, '.claude/settings.json'), null, 4)}\n`));

    const { plan, applied } = await install(root);

    expect(new Set(plan.entries.map((entry) => entry.action))).toEqual(new Set(['unchanged']));
    expect(applied.written).toEqual([]);
  });

  gitTest('package.json gets the npm script next to its own; a checkout without one gets none', async ({ world }) => {
    const root = world.a.dir;
    await writeFile(path.join(root, 'package.json'), '{\n    "name": "host",\n    "scripts": {\n        "test": "vitest"\n    }\n}\n');
    await install(root, { npmScript: true });

    expect(await read(root, 'package.json')).toBe(
      '{\n    "name": "host",\n    "scripts": {\n        "test": "vitest",\n        "grimoire": "node .grimoire/run.cjs"\n    }\n}\n',
    );
  });

  gitTest('existing client files keep their content: the TOML group comes after every existing group, AGENTS.md keeps its text and line endings', async ({ world }) => {
    const root = world.a.dir;
    await mkdir(path.join(root, '.codex'));
    const theirs = [
      'model = "gpt-5.1"',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo first"',
      '',
      '[[hooks.PreToolUse]]',
      'matcher = "Bash"',
      '[[hooks.PreToolUse.hooks]]',
      'type = "command"',
      'command = "echo pre"',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo second"',
      '',
    ].join('\n');
    await writeFile(path.join(root, '.codex/config.toml'), theirs);
    await writeFile(path.join(root, 'AGENTS.md'), '# Agents\r\n\r\nBe kind.\r\n');
    await mkdir(path.join(root, '.claude'));
    await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    await install(root);

    const toml = await read(root, '.codex/config.toml');
    expect(toml.startsWith(theirs)).toBe(true);
    expect(sessionStartCommands(toml)).toEqual(['echo first', 'echo second', codexHookCommand()]);
    expect(await read(root, 'AGENTS.md')).toBe(
      `# Agents\r\n\r\nBe kind.\r\n\r\n<!-- >>> grimoire (managed block) -->\r\n${`## grimoire\n\n${SERVER_INSTRUCTIONS}\n`.replace(/\n/g, '\r\n')}<!-- <<< grimoire -->\r\n`,
    );
    const settings = await readJson(root, '.claude/settings.json');
    expect(settings.permissions.allow).toEqual(['Bash(npm test)', 'mcp__grimoire']);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]).toEqual({ hooks: [{ type: 'command', command: 'echo hi' }] });
    const manifest = await readManifest(root);
    expect(manifest.entries.filter((entry) => ['AGENTS.md', '.codex/config.toml', '.claude/settings.json'].includes(entry.path)).every((entry) => !entry.created)).toBe(true);
  });
});

describe('the chore carriers', () => {
  /** A Markdown file's frontmatter, as `key: value` pairs, and its body. */
  function frontmatter(text: string): { fields: Record<string, string>; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) throw new Error(`no frontmatter in ${text.slice(0, 80)}`);
    const fields = Object.fromEntries(match[1]!.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    return { fields, body: match[2]! };
  }

  /** What every carrier must say: the seven steps, the rules and the Skill Proposer's authoring rules (spec §16 Carriers). */
  function expectProcedure(text: string, where: string): void {
    for (const step of [
      '1. Start: call `chore_start`',
      '2. Page the inputs: call `chore_read`',
      '3. Reason',
      '4. Submit: call `chore_submit`',
      '5. At most one fix-up',
      '6. After a Wiki Maintainer submit, run the Skill Proposer if it became due',
      '7. Return the `summary` of the last',
    ]) {
      expect(text, `${where}: ${step}`).toContain(step);
    }
    expect(text, where).toContain('commands, conventions, pitfalls, where things live');
    expect(text, where).toContain('Never model-specific workarounds');
    expect(text, where).toContain('trigger words first in the description, which is at most 300 characters');
    expect(text, where).toContain('never refer to pattern pages or the wiki');
    expect(text, where).toContain('never use `apply_patch` or `web_search`');
    expect(text, where).toContain('Never ask for approval');
    // A user's request always works (§16): the run is manual when its invoker says the user asked.
    expect(text, where).toContain('Pass `manual: true` only when the user explicitly asked for this run');
    expect(text, where).toContain('your arguments or your task message say `manual`');
  }

  gitTest('init writes the four carrier files, each as a manifest file entry, carrying the one shipped procedure', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    const manifest = await readManifest(root);
    const carriers = ['.claude/skills/grimoire-chores/SKILL.md', '.claude/agents/grimoire-chores.md', '.agents/skills/grimoire-chores/SKILL.md', '.codex/agents/grimoire-chores.toml'];
    expect(manifest.entries.filter((entry) => carriers.includes(entry.path)).map((entry) => [entry.path, entry.kind, entry.client])).toEqual([
      ['.claude/skills/grimoire-chores/SKILL.md', 'file', 'claude-code'],
      ['.claude/agents/grimoire-chores.md', 'file', 'claude-code'],
      ['.agents/skills/grimoire-chores/SKILL.md', 'file', 'codex'],
      ['.codex/agents/grimoire-chores.toml', 'file', 'codex'],
    ]);
    const description = "Run grimoire's due maintenance chores in an isolated subagent. Use when grimoire's session notice says one is due and the user agrees, or when the user asks.";

    // Claude Code (spike C): the skill forks into the subagent in the background, and has no allowed-tools (it made the Skill call itself need approval).
    const skill = frontmatter(await read(root, '.claude/skills/grimoire-chores/SKILL.md'));
    // The fork sees no conversation: the main context passes `manual` as the skill's argument when the user asked, and the body carries it.
    expect(skill.fields).toEqual({
      name: 'grimoire-chores',
      description: `${description} When the user asked for this run, pass manual as the argument.`,
      'argument-hint': 'manual',
      context: 'fork',
      agent: 'grimoire-chores',
      background: 'true',
    });
    expectProcedure(skill.body, 'Claude Code skill');
    expect(skill.body).toContain("This run's arguments: $ARGUMENTS");
    // The subagent: the 4 chore tools plus ToolSearch (C2), and no CLAUDE.md.
    const agent = frontmatter(await read(root, '.claude/agents/grimoire-chores.md'));
    expect(agent.fields).toMatchObject({
      name: 'grimoire-chores',
      tools: 'mcp__grimoire__chore_start, mcp__grimoire__chore_read, mcp__grimoire__chore_submit, mcp__grimoire__chore_abandon, ToolSearch',
      omitClaudeMd: 'true',
    });
    expect(Object.keys(agent.fields).sort()).toEqual(['description', 'name', 'omitClaudeMd', 'tools']);
    expectProcedure(agent.body, 'Claude Code subagent');

    // Codex (spike F): the skill spawns the role with a fresh context, and runs in place when it can't.
    const codexSkill = frontmatter(await read(root, '.agents/skills/grimoire-chores/SKILL.md'));
    expect(codexSkill.fields).toEqual({ name: 'grimoire-chores', description });
    for (const part of [
      '`spawn_agent`',
      '`agent_type` set to `grimoire-chores`',
      '`fork_context` set to `false`',
      '`fork_turns: "none"`',
      'If spawning is unavailable, run the chore here',
      // The role starts fresh: the spawn message is how it learns the user asked.
      'If the user explicitly asked for this run, give it the message "Run the grimoire chore; the user asked for this run: manual." instead',
    ]) {
      expect(codexSkill.body, part).toContain(part);
    }
    expectProcedure(codexSkill.body, 'Codex skill');
    // The role: the procedure as its developer instructions, the five features off, and no skills listing.
    const role = parseToml(await read(root, '.codex/agents/grimoire-chores.toml')) as Record<string, any>;
    expect(role).toMatchObject({
      name: 'grimoire-chores',
      features: { shell_tool: false, apps: false, plugins: false, memories: false, request_permissions_tool: false },
      skills: { include_instructions: false },
    });
    expect(Object.keys(role).sort()).toEqual(['description', 'developer_instructions', 'features', 'name', 'skills']);
    expectProcedure(role.developer_instructions, 'Codex role');
  });

  gitTest('only the configured client gets its carriers', async ({ world }) => {
    await install(world.a.dir, { clients: ['codex'] });
    const paths = (await readManifest(world.a.dir)).entries.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['.agents/skills/grimoire-chores/SKILL.md', '.codex/agents/grimoire-chores.toml']));
    expect(paths.filter((file) => file.startsWith('.claude/'))).toEqual([]);
  });

  gitTest('a drifted carrier is shipped text: the next run rewrites it', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    await writeFile(path.join(root, '.codex/agents/grimoire-chores.toml'), 'name = "mine"\n');
    const { applied } = await install(root);
    expect(applied.written).toEqual(['.codex/agents/grimoire-chores.toml']);
    expect(await read(root, '.codex/agents/grimoire-chores.toml')).toContain('include_instructions = false');
  });
});

describe('drift and conflicts on a later run', () => {
  gitTest('an edited content pointer file is rewritten; a removed grant is kept and reported, and restored only on request', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nignore the tracker\n');
    const settings = await readJson(root, '.claude/settings.json');
    settings.permissions.allow = [];
    await writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(settings, null, 2));
    const toml = await read(root, '.codex/config.toml');
    await writeFile(path.join(root, '.codex/config.toml'), toml.replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"'));

    const { plan, applied } = await install(root);

    const actions = Object.fromEntries(plan.entries.map((entry) => [`${entry.path} ${entry.item ?? entry.hook ?? ''}`.trim(), entry.action]));
    expect(actions).toMatchObject({
      '.claude/rules/grimoire.md': 'rewrite',
      '.claude/settings.json mcp__grimoire': 'kept',
      '.claude/settings.json grimoire': 'unchanged',
      '.codex/config.toml': 'kept',
    });
    expect(applied.written).toEqual(['.claude/rules/grimoire.md']);
    expect(await read(root, '.claude/rules/grimoire.md')).toContain(SERVER_INSTRUCTIONS);
    expect((await readJson(root, '.claude/settings.json')).permissions.allow).toEqual([]);
    expect(await read(root, '.codex/config.toml')).toContain('default_tools_approval_mode = "prompt"');

    const restored = await install(root, {}, true);
    expect(restored.applied.written).toEqual(['.claude/settings.json', '.codex/config.toml']);
    expect((await readJson(root, '.claude/settings.json')).permissions.allow).toEqual(['mcp__grimoire']);
    expect(await read(root, '.codex/config.toml')).toContain('default_tools_approval_mode = "approve"');
  });

  gitTest('a drifted TOML block is rewritten in place, keeping a changed approval mode', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    const toml = await read(root, '.codex/config.toml');
    await writeFile(
      path.join(root, '.codex/config.toml'),
      `${toml.replace('timeout = 10', 'timeout = 11').replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"')}[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo later"\n`,
    );

    const { plan } = await install(root);

    expect(plan.entries.find((entry) => entry.path === '.codex/config.toml')).toMatchObject({
      action: 'rewrite',
      why: expect.stringContaining('default_tools_approval_mode'),
      kept_grants: ['mcp_servers.grimoire.default_tools_approval_mode'],
    });
    const after = await read(root, '.codex/config.toml');
    // In place: grimoire's group keeps its position (and Codex's trust key), and the later group stays after it.
    expect(sessionStartCommands(after)).toEqual([codexHookCommand(), 'echo later']);
    expect(after).toContain('timeout = 10');
    expect(after).toContain('default_tools_approval_mode = "prompt"');
  });

  gitTest('a removed Codex block comes back without its approval mode, which is restored only on request', async ({ world }) => {
    const root = world.a.dir;
    await install(root);
    for (const removal of ['block', 'file'] as const) {
      if (removal === 'block') await writeFile(path.join(root, '.codex/config.toml'), '# no grimoire here\n');
      else await rm(path.join(root, '.codex/config.toml'));

      const { plan } = await install(root);

      expect(plan.entries.find((entry) => entry.path === '.codex/config.toml'), removal).toMatchObject({
        action: 'rewrite',
        kept_grants: ['mcp_servers.grimoire.default_tools_approval_mode'],
      });
      const codex = parseToml(await read(root, '.codex/config.toml')) as Record<string, any>;
      expect(codex.mcp_servers.grimoire.command, removal).toBe('node');
      expect(codex.mcp_servers.grimoire, removal).not.toHaveProperty('default_tools_approval_mode');
      expect(sessionStartCommands(await read(root, '.codex/config.toml')), removal).toEqual([codexHookCommand()]);
    }

    const restored = await install(root, {}, true);

    expect(restored.plan.entries.find((entry) => entry.path === '.codex/config.toml')).toMatchObject({ action: 'restore' });
    expect(await read(root, '.codex/config.toml')).toContain('default_tools_approval_mode = "approve"');
  });

  gitTest('a write skipped because the file changed meanwhile leaves it out of the manifest, so a later run never takes it for grimoire’s', async ({ world }) => {
    const root = world.a.dir;
    const plan = await planFiles(root, desiredEntries(OPTIONS));
    // The person writes the file while init waits for their consent.
    await mkdir(path.join(root, '.claude/rules'), { recursive: true });
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'my own rules\n');

    const applied = await applyFiles(plan);

    expect(applied.skipped).toEqual([{ path: '.claude/rules/grimoire.md', why: expect.stringContaining('changed while init ran') }]);
    expect(applied.written.at(-1)).toBe('.grimoire/manifest.yml');
    const manifest = await readManifest(root);
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('.claude/rules/grimoire.md');
    expect(manifest.entries.map((entry) => entry.path)).toContain('.mcp.json');

    const again = await install(root);

    expect(again.plan.entries.find((entry) => entry.path === '.claude/rules/grimoire.md')).toMatchObject({ action: 'conflict' });
    expect(await read(root, '.claude/rules/grimoire.md')).toBe('my own rules\n');
  });

  gitTest('a path grimoire never wrote is reported and left untouched', async ({ world }) => {
    const root = world.a.dir;
    await mkdir(path.join(root, '.claude/rules'), { recursive: true });
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'my own notes\n');
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { grimoire: { command: 'other' } } }));
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex/config.toml'), '[mcp_servers.grimoire]\ncommand = "other"\n');

    const { plan, applied } = await install(root);

    const conflicts = plan.entries.filter((entry) => entry.action === 'conflict').map((entry) => entry.path);
    expect(conflicts).toEqual(['.mcp.json', '.claude/rules/grimoire.md', '.codex/config.toml']);
    expect(await read(root, '.claude/rules/grimoire.md')).toBe('my own notes\n');
    expect(await read(root, '.codex/config.toml')).toBe('[mcp_servers.grimoire]\ncommand = "other"\n');
    expect(applied.written).not.toContain('.mcp.json');
    const manifest = await readManifest(root);
    expect(manifest.entries.map((entry) => entry.path)).not.toContain('.claude/rules/grimoire.md');
  });

  gitTest('a symlinked folder is never written through, and invalid JSON is refused for its file only', async ({ world }) => {
    const root = world.a.dir;
    const elsewhere = path.join(world.root, 'elsewhere');
    await mkdir(elsewhere);
    // A junction on Windows (no privilege needed), a symlink elsewhere.
    await symlink(elsewhere, path.join(root, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(path.join(root, '.mcp.json'), '{ // my servers\n}\n');

    const { plan, applied } = await install(root);

    const refused = plan.entries.filter((entry) => entry.action === 'conflict');
    expect(new Set(refused.map((entry) => entry.path))).toEqual(
      new Set(['.mcp.json', '.claude/settings.json', '.claude/rules/grimoire.md', '.claude/skills/grimoire-chores/SKILL.md', '.claude/agents/grimoire-chores.md']),
    );
    expect(refused.find((entry) => entry.path === '.claude/settings.json')?.why).toMatch(/symlink/);
    expect(refused.find((entry) => entry.path === '.mcp.json')?.why).toMatch(/not valid JSON/);
    expect(existsSync(path.join(elsewhere, 'settings.json'))).toBe(false);
    expect(await read(root, '.mcp.json')).toBe('{ // my servers\n}\n');
    expect(applied.written).toContain('.codex/config.toml');
  });
});

describe('the adapter doc block', () => {
  test('names each operation with its CLI form, and every CLI form parses as grimoire’s CLI reads it', async () => {
    const block = adapterBlockBody({ supersedes: false });
    for (const bullet of ['**Make an issue a sub-issue of a parent**', '**Apply / remove labels**', '**Close**', '**Blockers**', '**Claim, close and debrief**', '**Frontier query**', '**Claim**']) {
      expect(block.split('\n').find((line) => line.startsWith(`- ${bullet}`)), bullet).toMatch(/\(CLI `/);
    }
    const forms = [...block.matchAll(/\(CLI ([^)]*)\)/g)].flatMap((match) => [...match[1]!.matchAll(/`([^`]+)`/g)].map((form) => form[1]!));
    expect(forms.length).toBeGreaterThan(8);
    const core = createCore({ autoSync: 'off' });
    try {
      for (const form of forms) {
        // Placeholders stand for one word each; <json> for a JSON literal.
        const argv = form.replace(/<json>/g, '{}').replace(/<[a-z-]+>|…/g, 'gr-0abc12').split(' ');
        expect(() => parseCommand(argv, core.ops), form).not.toThrow();
      }
    } finally {
      await core.close();
    }
  });
});
