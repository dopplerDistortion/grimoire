// Uninstall's checkout half (spec §21 Uninstall; §11 The manifest). Seam 1:
// the manifest-driven removal against a real checkout that `init --yes`
// installed, with the person's own content in the shared files. What the
// checkout holds afterwards is checked through git: against the commit before
// the install, `git diff` shows nothing but what the person changed since.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { readManifest } from '../../src/installer/manifest';
import { planRemoval, removeCheckout } from '../../src/installer/removal';
import { USER_AGENTS, USER_SETTINGS, USER_TOML, differences, installedRepo, jsonText, put } from './uninstall-support';

async function text(root: string, relative: string): Promise<string> {
  return readFile(path.join(root, ...relative.split('/')), 'utf8');
}

describe('the removal', () => {
  gitTest('takes out exactly what the manifest records: the checkout is as it was before the install, the person’s content in AGENTS.md, the settings JSON and the TOML kept', async ({ world }) => {
    const { before } = await installedRepo(world.a);
    const manifest = await readManifest(world.a.dir);
    expect(new Set(manifest.entries.map((entry) => entry.kind))).toEqual(new Set(['file', 'json-key', 'json-array-item', 'toml-table', 'marker-block', 'seeded-file', 'npm-script']));

    const plan = await planRemoval(world.a.dir);
    expect(plan.unknown).toEqual([]);
    expect(plan.problems).toEqual([]);
    const done = await removeCheckout(plan);

    expect(done.problems).toEqual([]);
    expect(done.complete).toBe(true);
    expect(await differences(world.a, before)).toEqual([]);
    expect(existsSync(path.join(world.a.dir, '.grimoire'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.mcp.json'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, 'docs'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.claude', 'skills'))).toBe(false);
    expect(await text(world.a.dir, 'AGENTS.md')).toBe(USER_AGENTS);
    expect(await text(world.a.dir, '.codex/config.toml')).toBe(USER_TOML);
    expect(JSON.parse(await text(world.a.dir, '.claude/settings.json'))).toEqual(USER_SETTINGS);
    // Every manifest entry is accounted for, none drifted.
    expect(done.removed).toHaveLength(manifest.entries.length);
    expect(done.removed.every((entry) => !entry.drift)).toBe(true);
    expect(done.deleted.at(-1)).toBe('.grimoire/manifest.yml');
  });

  gitTest('entries are removed even if edited, found by the frozen bootstrap first: a renamed server, an edited block and an edited hook group go, with drift reported', async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    const mcp = JSON.parse(await text(world.a.dir, '.mcp.json'));
    mcp.mcpServers = { 'my-tracker': mcp.mcpServers.grimoire, other: { command: 'other' } };
    await writeFile(path.join(world.a.dir, '.mcp.json'), jsonText(mcp));
    const settings = JSON.parse(await text(world.a.dir, '.claude/settings.json'));
    settings.hooks.SessionStart[0].hooks[0].timeout = 30;
    await writeFile(path.join(world.a.dir, '.claude/settings.json'), jsonText(settings));
    await writeFile(path.join(world.a.dir, 'AGENTS.md'), (await text(world.a.dir, 'AGENTS.md')).replace('## grimoire', '## grimoire (ours)'));

    const done = await removeCheckout(await planRemoval(world.a.dir));

    expect(done.problems).toEqual([]);
    expect(JSON.parse(await text(world.a.dir, '.mcp.json'))).toEqual({ mcpServers: { other: { command: 'other' } } });
    expect(JSON.parse(await text(world.a.dir, '.claude/settings.json'))).toEqual(USER_SETTINGS);
    expect(await text(world.a.dir, 'AGENTS.md')).toBe(USER_AGENTS);
    const drifted = done.removed.filter((entry) => entry.drift).map((entry) => `${entry.path} ${entry.hook ?? entry.marker ?? entry.key?.join('.')}`);
    expect(drifted.sort()).toEqual(['.claude/settings.json session-start', '.mcp.json mcpServers.grimoire', 'AGENTS.md grimoire'].sort());
    expect(installed).toBeTruthy();
  });

  gitTest('a whole file edited and committed goes with drift reported; one whose edits git doesn’t have, a changed npm script and a changed seed stay, reported', async ({ world }) => {
    await installedRepo(world.a);
    await world.a.commitFile('.claude/rules/grimoire.md', '# grimoire\n\nOur own note.\n', 'edit the rules');
    await writeFile(path.join(world.a.dir, '.claude/agents/grimoire-chores.md'), 'uncommitted edit\n');
    const pkg = JSON.parse(await text(world.a.dir, 'package.json'));
    pkg.scripts.grimoire = 'node .grimoire/run.cjs --from .';
    await writeFile(path.join(world.a.dir, 'package.json'), jsonText(pkg));
    await writeFile(path.join(world.a.dir, 'docs/agents/triage-labels.md'), '# Our labels\n');

    const done = await removeCheckout(await planRemoval(world.a.dir));

    expect(done.problems).toEqual([]);
    expect(done.complete).toBe(true);
    expect(existsSync(path.join(world.a.dir, '.claude/rules/grimoire.md'))).toBe(false);
    expect(done.removed).toContainEqual(expect.objectContaining({ path: '.claude/rules/grimoire.md', drift: true }));
    expect(await text(world.a.dir, '.claude/agents/grimoire-chores.md')).toBe('uncommitted edit\n');
    expect(JSON.parse(await text(world.a.dir, 'package.json')).scripts.grimoire).toBe('node .grimoire/run.cjs --from .');
    expect(await text(world.a.dir, 'docs/agents/triage-labels.md')).toBe('# Our labels\n');
    expect(done.kept.map((item) => item.path).sort()).toEqual(['.claude/agents/grimoire-chores.md', 'docs/agents/triage-labels.md', 'package.json'].sort());
  });

  gitTest('files in .grimoire grimoire never wrote stay, reported, and so does the folder; config.yml and the manifest go', async ({ world }) => {
    await installedRepo(world.a);
    await put(world.a.dir, '.grimoire/notes.md', 'ours\n');

    const done = await removeCheckout(await planRemoval(world.a.dir));

    expect(done.kept).toContainEqual({ path: '.grimoire/notes.md', why: expect.stringMatching(/didn’t write it/) });
    expect(await text(world.a.dir, '.grimoire/notes.md')).toBe('ours\n');
    expect(existsSync(path.join(world.a.dir, '.grimoire/config.yml'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.grimoire/manifest.yml'))).toBe(false);
  });

  gitTest('what mentions grimoire outside the manifest is reported and never touched', async ({ world }) => {
    await installedRepo(world.a);
    const settings = JSON.parse(await text(world.a.dir, '.claude/settings.json'));
    settings.permissions.allow.push('mcp__grimoire__create');
    await writeFile(path.join(world.a.dir, '.claude/settings.json'), jsonText(settings));

    const plan = await planRemoval(world.a.dir);
    const done = await removeCheckout(plan);

    expect(done.problems).toEqual([]);
    expect(plan.mentions).toEqual([expect.objectContaining({ path: '.claude/settings.json', text: '"mcp__grimoire__create"' })]);
    expect(JSON.parse(await text(world.a.dir, '.claude/settings.json')).permissions.allow).toEqual(['Bash(npm test)', 'mcp__grimoire__create']);
  });

  gitTest('names the Codex SessionStart groups after grimoire’s, whose positions shift', async ({ world }) => {
    await installedRepo(world.a);
    const group = '\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo later"\n';
    await writeFile(path.join(world.a.dir, '.codex/config.toml'), `${await text(world.a.dir, '.codex/config.toml')}${group}`);

    const plan = await planRemoval(world.a.dir);
    await removeCheckout(plan);

    expect(plan.codex).toEqual([{ from: 1, to: 0, command: 'echo later' }]);
    expect(await text(world.a.dir, '.codex/config.toml')).toBe(`${USER_TOML}${group}`);
  });

  gitTest('a file it can’t change safely stops the removal before config.yml: the manifest stays, and a second run after the fix finishes', async ({ world }) => {
    const { before } = await installedRepo(world.a);
    const mcp = await text(world.a.dir, '.mcp.json');
    await writeFile(path.join(world.a.dir, '.mcp.json'), `// ours\n${mcp}`);

    const done = await removeCheckout(await planRemoval(world.a.dir));

    expect(done.complete).toBe(false);
    expect(done.problems).toEqual([expect.stringMatching(/^\.mcp\.json: it is not valid JSON/)]);
    expect(existsSync(path.join(world.a.dir, '.grimoire/config.yml'))).toBe(true);
    expect(existsSync(path.join(world.a.dir, '.grimoire/manifest.yml'))).toBe(true);

    await writeFile(path.join(world.a.dir, '.mcp.json'), mcp);
    const again = await removeCheckout(await planRemoval(world.a.dir));
    expect(again.complete).toBe(true);
    expect(await differences(world.a, before)).toEqual([]);
  });

  gitTest('a run stopped after any step (as a crash would) leaves the manifest; running it again completes the removal', async ({ world }) => {
    const { before } = await installedRepo(world.a);
    let steps = 0;
    const crashAt = 3;
    await expect(
      removeCheckout(await planRemoval(world.a.dir), {
        onStep: () => {
          if (++steps === crashAt) throw new Error('killed');
        },
      }),
    ).rejects.toThrow('killed');
    expect(existsSync(path.join(world.a.dir, '.grimoire/manifest.yml'))).toBe(true);
    expect(await differences(world.a, before)).not.toEqual([]);

    const again = await removeCheckout(await planRemoval(world.a.dir));

    expect(again.problems).toEqual([]);
    expect(again.complete).toBe(true);
    expect(await differences(world.a, before)).toEqual([]);
  });

  gitTest('an unknown manifest kind or format stops it before any write', async ({ world }) => {
    const { installed } = await installedRepo(world.a);
    const manifestFile = path.join(world.a.dir, '.grimoire/manifest.yml');
    await writeFile(manifestFile, `${await readFile(manifestFile, 'utf8')}  - {"path":"x.json","kind":"yaml-key","hash":"sha256:0","created":true}\n`);

    const plan = await planRemoval(world.a.dir);
    const done = await removeCheckout(plan);

    expect(plan.unknown).toEqual(['yaml-key']);
    expect(done.complete).toBe(false);
    expect(await differences(world.a, installed)).toEqual(['.grimoire/manifest.yml']);

    await writeFile(manifestFile, (await readFile(manifestFile, 'utf8')).replace('format: 1', 'format: 2'));
    expect((await planRemoval(world.a.dir)).unknown).toEqual(['manifest format 2', 'yaml-key']);
  });
});
