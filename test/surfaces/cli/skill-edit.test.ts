// `grimoire skill edit <name>` (spec §15 Human editing, §7 the human-only
// gate): the user's git editor opens on a temp copy outside every worktree; the
// edit's base is checked, the diff shown, the text secret-scanned, and a new
// skill version committed after the typed name. Driven with the real git
// editor launch (a stand-in editor on GIT_EDITOR), a real core and real repos;
// only the terminal's answers are scripted.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../../src/core';
import { gitEditor, skillEditFlow, type SkillEditIo } from '../../../src/surfaces/cli/skill-edit';
import { makeTempDir, removeDir, type GitWorld } from '#harness';
import { coreTest as test, expectRefUnmoved } from '../../core/support';

const FAKE_EDITOR = fileURLToPath(new URL('./fake-editor.mjs', import.meta.url));

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

function notes(line: string): string {
  return `---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\n${line}\n`;
}

interface EditorStep {
  write?: string;
  replace?: [string, string];
}

/** A scripted terminal and the stand-in editor, with what each was shown. */
async function scripted(world: GitWorld, steps: EditorStep[], answers: string[], beforeEdit: (() => Promise<void>)[] = []) {
  const dir = await makeTempDir('grimoire-editor-');
  const plan = path.join(dir, 'plan.json');
  const log = path.join(dir, 'log.jsonl');
  await writeFile(plan, JSON.stringify(steps));
  await writeFile(log, '');
  const quote = (file: string) => `"${file.replace(/\\/g, '/')}"`;
  const env = { ...process.env, GIT_EDITOR: `${quote(process.execPath)} ${quote(FAKE_EDITOR)}`, FAKE_EDITOR_PLAN: plan, FAKE_EDITOR_LOG: log };
  const launch = gitEditor(world.a.dir, env);
  const said: string[] = [];
  const asked: string[] = [];
  const io: SkillEditIo = {
    async edit(file) {
      await beforeEdit.shift()?.();
      await launch(file);
    },
    async ask(question) {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
    say(text) {
      said.push(text);
    },
  };
  const opened = async () =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { file: string; before: string });
  return { io, said, asked, opened, cleanup: () => removeDir(dir) };
}

async function read(core: Core, ctx: CallContext): Promise<string | null> {
  const result = await core.call('skill_read', { name: 'release-notes' }, ctx);
  return result.ok ? result.result.text : null;
}

describe('grimoire skill edit', () => {
  test('opens the git editor on a temp copy outside every worktree, shows the diff, and commits after the typed name', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const worktree = await world.a.addWorktree('feature');
    const first = await scripted(world, [{ write: notes('Create `changes/<slug>.md`.') }], ['release-notes']);
    const second = await scripted(world, [{ replace: ['Create', 'Always create'] }], ['release-notes']);
    try {
      const created = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: first.io });
      const edited = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: second.io });

      expect(created).toMatchObject({ ok: true, result: { name: 'release-notes', created: true, changed: true } });
      expect(edited).toMatchObject({ ok: true, result: { created: false, changed: true } });
      expect(await read(core, ctx)).toBe(notes('Always create `changes/<slug>.md`.'));
      const [[opened1], [opened2]] = [await first.opened(), await second.opened()];
      // A new skill opens on a template; an existing one on its current text.
      expect(opened1!.before).toMatch(/^---\nname: release-notes\ndescription: *\n---\n/);
      expect(opened2!.before).toBe(notes('Create `changes/<slug>.md`.'));
      for (const { file } of [opened1!, opened2!]) {
        expect(path.basename(file)).toBe('SKILL.md');
        for (const checkout of [world.a.dir, worktree.dir, world.root]) {
          expect(path.relative(checkout, file).startsWith('..'), `${file} is outside ${checkout}`).toBe(true);
        }
      }
      expect(second.said.join('\n')).toMatch(/^-Create `changes/m);
      expect(second.said.join('\n')).toMatch(/^\+Always create `changes/m);
      expect(second.asked).toEqual([expect.stringContaining('release-notes')]);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  test('without the typed name nothing is committed: edit again, or discard', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const run = await scripted(world, [{ write: notes('One.') }, { write: notes('Two.') }], ['release', 'e', 'release-notes']);
    const discard = await scripted(world, [{ write: notes('Three.') }], ['nope', 'd']);
    try {
      const committed = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io });
      const discarded = await expectRefUnmoved(world.a, () => skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: discard.io }));

      expect(committed).toMatchObject({ ok: true, result: { created: true } });
      expect(await read(core, ctx)).toBe(notes('Two.'));
      // Editing again starts from the draft, not from scratch.
      expect((await run.opened())[1]!.before).toBe(notes('One.'));
      expect(discarded).toEqual({ ok: true, result: { name: 'release-notes', changed: false, discarded: true } });
    } finally {
      await run.cleanup();
      await discard.cleanup();
    }
  });

  test('saving the text unchanged commits nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await core.call('skill_edit', { name: 'release-notes', text: notes('One.'), base: null }, terminal(ctx));
    const run = await scripted(world, [{}], []);
    try {
      const outcome = await expectRefUnmoved(world.a, () => skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io }));

      expect(outcome).toEqual({ ok: true, result: { name: 'release-notes', changed: false, discarded: true } });
      expect(run.said.join('\n')).toMatch(/no changes/i);
    } finally {
      await run.cleanup();
    }
  });

  test('when the skill moved while the editor was open: redo on the current text, replace with the draft (confirmed), or discard', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await core.call('skill_edit', { name: 'release-notes', text: notes('One.'), base: null }, terminal(ctx));
    let current = notes('One.');
    /** Someone else commits a new version while the editor is open. */
    const moveTo = (text: string) => async () => {
      const shown = await core.call('skill_read', { name: 'release-notes' }, ctx);
      const base = shown.ok ? shown.result.version : null;
      const moved = await core.call('skill_edit', { name: 'release-notes', text, base }, terminal(ctx));
      expect(moved.ok).toBe(true);
      current = text;
    };
    const discard = await scripted(world, [{ write: notes('Mine.') }], ['release-notes', '3'], [moveTo(notes('Theirs.'))]);
    const replace = await scripted(world, [{ write: notes('Mine.') }], ['release-notes', '2', 'release-notes'], [moveTo(notes('Theirs again.'))]);
    const redo = await scripted(
      world,
      [{ write: notes('Mine, a second time.') }, { replace: ['Theirs once more.', 'Theirs once more, and mine.'] }],
      ['release-notes', '1', 'release-notes'],
      [moveTo(notes('Theirs once more.'))],
    );
    try {
      const discarded = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: discard.io });
      const afterDiscard = await read(core, ctx);
      const replaced = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: replace.io });
      const afterReplace = await read(core, ctx);
      const redone = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: redo.io });

      expect(discarded).toEqual({ ok: true, result: { name: 'release-notes', changed: false, discarded: true } });
      expect(afterDiscard).toBe(notes('Theirs.'));
      expect(discard.asked[1]).toMatch(/Redo my edit on the current text.*Replace with my draft.*Discard/s);
      expect(replaced).toMatchObject({ ok: true, result: { changed: true } });
      expect(afterReplace).toBe(notes('Mine.'));
      expect(replace.asked[2]).toContain('release-notes');
      expect(redone).toMatchObject({ ok: true, result: { changed: true } });
      // Redo reopens the editor on the current text.
      expect((await redo.opened())[1]!.before).toBe(current);
      expect(await read(core, ctx)).toBe(notes('Theirs once more, and mine.'));
    } finally {
      await discard.cleanup();
      await replace.cleanup();
      await redo.cleanup();
    }
  });

  test('a secret in the draft blocks the commit: the message names the rule and line, and editing again fixes it', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const token = `ghp_${'Q1w2E3r4T5y6'.repeat(3)}`;
    const run = await scripted(
      world,
      [{ write: notes(`export GITHUB_TOKEN=${token}`) }, { replace: [`export GITHUB_TOKEN=${token}`, 'Read the token from the environment.'] }],
      ['release-notes', 'e', 'release-notes'],
    );
    try {
      const outcome = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io });

      expect(outcome).toMatchObject({ ok: true, result: { created: true } });
      expect(await read(core, ctx)).toBe(notes('Read the token from the environment.'));
      const told = run.said.join('\n');
      expect(told).toMatch(/secret \(github-pat\) on line 7/);
      expect(told.split(token).length).toBe(2); // only in the diff the human typed, never in grimoire's message
    } finally {
      await run.cleanup();
    }
  });

  test('from an agent surface it gives HUMAN_ONLY and never opens the editor', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const run = await scripted(world, [{ write: notes('One.') }], ['release-notes']);
    try {
      const marked = await skillEditFlow('release-notes', {
        core,
        ctx: { ...terminal(ctx), evidence: { agentMarkers: ['AI_AGENT'] } },
        io: run.io,
      });
      const noTty = await skillEditFlow('release-notes', { core, ctx: { ...terminal(ctx), tty: false }, io: run.io });

      for (const outcome of [marked, noTty]) expect(outcome).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
      expect(await run.opened()).toEqual([]);
    } finally {
      await run.cleanup();
    }
  });
});
