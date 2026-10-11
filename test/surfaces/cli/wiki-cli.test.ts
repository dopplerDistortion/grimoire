// Seam 3 for the `wiki` verbs (spec Testing Decisions; §10, §7): the built CLI
// bundle, spawned the way a person or an agent would run it. Transport and
// gating only: one JSON object on stdout, exit codes, and the human-read and
// human-only gates. The editor session itself is tested in wiki-edit.test.ts.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';
import { editWorkspace, openGitEditor } from '../../../src/surfaces/cli/editor';
import { buildGrimoire } from '../mcp/support';
import { coreTest as test } from '../../core/support';

let bin = '';
let cleanup: () => Promise<void> = async () => {};

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
}, 120_000);
afterAll(() => cleanup());

const PAGE = {
  slug: 'flaky-port-binding',
  title: 'Flaky port binding',
  kind: 'failure',
  summary: 'Tests fail when two servers race for one port.',
  body: 'Bind to port 0.\n',
};

/** The environment of a person's shell, with no agent marker. */
function shellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID'].includes(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

describe('grimoire wiki', () => {
  test('wiki list prints one JSON object; under an agent marker wiki show is refused; without a TTY wiki edit is refused', async ({
    world,
    grimoire,
  }) => {
    const human = { ...grimoire.ctx, surface: 'cli' as const, client: null, evidence: {}, tty: true };
    const created = await grimoire.core.call('wiki_edit', { ...PAGE, base: null }, human);
    expect(created.ok).toBe(true);
    const run = (args: string[], env = shellEnv()) => runCommand(process.execPath, [bin, ...args], { cwd: world.a.dir, env });

    const listed = await run(['wiki', 'list']);
    const marked = await run(['wiki', 'show', PAGE.slug], shellEnv({ AI_AGENT: '1' }));
    const edit = await run(['wiki', 'edit', PAGE.slug]);
    const usage = await run(['wiki']);

    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ pages: [{ slug: PAGE.slug, title: PAGE.title, conflicted: false, quarantined: false }] });
    expect(marked.code).toBe(1);
    expect(JSON.parse(marked.stdout)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(marked.stdout).not.toContain('AI_AGENT');
    expect(edit.code).toBe(1);
    expect(JSON.parse(edit.stdout)).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(usage.code).toBe(2);
  });
});

describe('the git editor', () => {
  test('opens the file in the editor git would use, through its shell, outside every worktree', async ({ world }) => {
    const scripts = await makeTempDir('grimoire-editor-');
    try {
      const script = path.join(scripts, 'editor.mjs');
      await writeFile(
        script,
        "import { appendFileSync } from 'node:fs';\nconst file = process.argv.at(-1);\nappendFileSync(file, `edited with ${process.argv[2]}\\n`);\n",
      );
      const slashed = (p: string) => p.replaceAll('\\', '/');
      vi.stubEnv('GIT_EDITOR', `"${slashed(process.execPath)}" "${slashed(script)}" --wait`);
      const workspace = await editWorkspace(world.a.dir);
      try {
        expect(path.relative(world.a.dir, workspace.dir).startsWith('..')).toBe(true);
        const file = path.join(workspace.dir, 'page.md');
        await writeFile(file, 'draft\n');

        await openGitEditor(file, world.a.dir);

        expect(await readFile(file, 'utf8')).toBe('draft\nedited with --wait\n');
        vi.stubEnv('GIT_EDITOR', `"${slashed(process.execPath)}" -e "process.exit(3)"`);
        await expect(openGitEditor(file, world.a.dir)).rejects.toThrow(/exited with 3/);
      } finally {
        await workspace.remove();
      }
    } finally {
      await removeDir(scripts);
    }
  });
});
