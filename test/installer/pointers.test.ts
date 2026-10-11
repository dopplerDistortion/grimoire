// Seam 1 for the installer (spec Testing Decisions): the manifest and pointer
// writers, driven directly against real temporary checkouts. What each file
// must hold comes from spec §11 and spikes A, C and E.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { BOOTSTRAP, codexHookCommand } from '../../src/installer';
import { readManifest, type ClientName } from '../../src/installer/manifest';
import { desiredEntries, type PointerOptions } from '../../src/installer/pointers';
import { parseToml } from '../../src/installer/toml';
import { applyFiles, planFiles } from '../../src/installer/writer';
import { SERVER_INSTRUCTIONS } from '../../src/instructions';

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
      ['.codex/config.toml', 'toml-table', true],
      ['AGENTS.md', 'marker-block', true],
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

    expect(plan.entries.find((entry) => entry.path === '.codex/config.toml')).toMatchObject({ action: 'rewrite', why: expect.stringContaining('default_tools_approval_mode') });
    const after = await read(root, '.codex/config.toml');
    // In place: grimoire's group keeps its position (and Codex's trust key), and the later group stays after it.
    expect(sessionStartCommands(after)).toEqual([codexHookCommand(), 'echo later']);
    expect(after).toContain('timeout = 10');
    expect(after).toContain('default_tools_approval_mode = "prompt"');
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
    expect(new Set(refused.map((entry) => entry.path))).toEqual(new Set(['.mcp.json', '.claude/settings.json', '.claude/rules/grimoire.md']));
    expect(refused.find((entry) => entry.path === '.claude/settings.json')?.why).toMatch(/symlink/);
    expect(refused.find((entry) => entry.path === '.mcp.json')?.why).toMatch(/not valid JSON/);
    expect(existsSync(path.join(elsewhere, 'settings.json'))).toBe(false);
    expect(await read(root, '.mcp.json')).toBe('{ // my servers\n}\n');
    expect(applied.written).toContain('.codex/config.toml');
  });
});
