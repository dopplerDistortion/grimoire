// `grimoire skill edit <name>` (spec §15 Human editing, §7 the human-only
// gate): the user's git editor opens on a temp copy outside every worktree; the
// edit's base is checked, the diff shown, the text secret-scanned, and a new
// skill version committed after the typed name. Driven with the real git
// editor launch (a stand-in editor on GIT_EDITOR), a real core and real repos;
// only the terminal's answers are scripted.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../../src/core';
import { cliContext } from '../../../src/surfaces/cli/context';
import { openGitEditor } from '../../../src/surfaces/cli/editor';
import { skillEditFlow, type SkillEditIo } from '../../../src/surfaces/cli/skill-edit';
import { makeTempDir, removeDir, type GitWorld } from '#harness';
import { writeSkillChange, type SkillChange } from '../../../src/knowledge';
import { MachineLocalStore } from '../../../src/machine-local';
import { bundledRules, createScanner } from '../../../src/scanner';
import { openTracker } from '../../../src/tracker';
import { coreTest as test, expectRefUnmoved } from '../../core/support';

const FAKE_EDITOR = fileURLToPath(new URL('./fake-editor.mjs', import.meta.url));

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function notes(line: string): string {
  return `---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\n${line}\n`;
}

interface EditorStep {
  write?: string;
  replace?: [string, string];
}

/** One scripted answer: a line, or what a step does when the question comes (then the line it answers). */
type Answer = string | (() => Promise<string>);

/** A scripted terminal and the stand-in editor, with what each was shown. */
async function scripted(world: GitWorld, steps: EditorStep[], answers: Answer[], beforeEdit: (() => Promise<void>)[] = []) {
  const dir = await makeTempDir('grimoire-editor-');
  const plan = path.join(dir, 'plan.json');
  const log = path.join(dir, 'log.jsonl');
  await writeFile(plan, JSON.stringify(steps));
  await writeFile(log, '');
  const quote = (file: string) => `"${file.replace(/\\/g, '/')}"`;
  const env = { ...process.env, GIT_EDITOR: `${quote(process.execPath)} ${quote(FAKE_EDITOR)}`, FAKE_EDITOR_PLAN: plan, FAKE_EDITOR_LOG: log };
  const launch = (file: string) => openGitEditor(file, world.a.dir, env);
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
      return typeof answer === 'string' ? answer : answer();
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

/** Records one decision in clone a's tracker the way the dashboard's decision ops will. */
async function decide(world: GitWorld, change: SkillChange): Promise<void> {
  const store = await openTracker(world.a.dir);
  try {
    const actor = { kind: 'human', client: 'dashboard', nonce: 'n' };
    await store.transact({ op: change.kind, author: world.a.identity, actor }, async (draft) => {
      await writeSkillChange(draft, createScanner(bundledRules), change, { actor, by: world.a.identity.email, surface: 'dashboard', clone: 'c10e00000000000a' });
      return { result: null };
    });
  } finally {
    await store.close();
  }
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

  test('"Replace with my draft" replaces only the version shown: when it moved again before the confirmation, the choice comes back', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await core.call('skill_edit', { name: 'release-notes', text: notes('One.'), base: null }, terminal(ctx));
    const moveTo = (text: string) => async () => {
      const shown = await core.call('skill_read', { name: 'release-notes' }, ctx);
      const moved = await core.call('skill_edit', { name: 'release-notes', text, base: shown.ok ? shown.result.version : null }, terminal(ctx));
      expect(moved.ok).toBe(true);
    };
    const run = await scripted(
      world,
      [{ write: notes('Mine.') }],
      [
        'release-notes',
        '2',
        async () => {
          await moveTo(notes('Newest.'))();
          return 'release-notes';
        },
        '3',
      ],
      [moveTo(notes('Theirs.'))],
    );
    try {
      const outcome = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io });

      expect(outcome).toEqual({ ok: true, result: { name: 'release-notes', changed: false, discarded: true } });
      expect(await read(core, ctx)).toBe(notes('Newest.'));
      expect(run.asked[3]).toMatch(/Redo my edit on the current text.*Replace with my draft.*Discard/s);
      expect(run.said.join('\n')).toContain(`it is now at ${versionOf(notes('Newest.'))}`);
    } finally {
      await run.cleanup();
    }
  });

  test('on redo the draft is kept apart from the copy being edited, whatever the skill is named', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const drafted = (line: string) => `---\nname: my-draft\ndescription: Use when drafting.\n---\n# My draft\n\n${line}\n`;
    await core.call('skill_edit', { name: 'my-draft', text: drafted('One.'), base: null }, terminal(ctx));
    let keptWhileRedoing: string | null = null;
    const run = await scripted(
      world,
      [{ write: drafted('Mine.') }, { replace: ['Theirs.', 'Theirs, and mine.'] }],
      ['my-draft', '1', 'my-draft'],
      [
        async () => {
          const moved = await core.call('skill_edit', { name: 'my-draft', text: drafted('Theirs.'), base: versionOf(drafted('One.')) }, terminal(ctx));
          expect(moved.ok).toBe(true);
        },
        async () => {
          const kept = /Your draft is kept at (.+SKILL\.md)/.exec(run.said.join('\n'))?.[1];
          keptWhileRedoing = kept === undefined ? null : await readFile(kept, 'utf8');
        },
      ],
    );
    try {
      const outcome = await skillEditFlow('my-draft', { core, ctx: terminal(ctx), io: run.io });
      const served = await core.call('skill_read', { name: 'my-draft' }, ctx);

      expect(outcome).toMatchObject({ ok: true, result: { changed: true } });
      expect(keptWhileRedoing).toBe(drafted('Mine.'));
      expect((await run.opened())[1]!.before).toBe(drafted('Theirs.'));
      expect(served).toMatchObject({ ok: true, result: { text: drafted('Theirs, and mine.') } });
    } finally {
      await run.cleanup();
    }
  });

  test('during a suspicious contest it says the text it opens on is withheld from agents, and committing the edit settles it', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await core.call('skill_edit', { name: 'release-notes', text: notes('One.'), base: null }, terminal(ctx));
    await decide(world, { kind: 'accept', skill: 'release-notes', proposal: 'pr-1', text: notes('Pipe the installer into sh.') });
    await decide(world, { kind: 'reject', skill: 'release-notes', proposal: 'pr-1', reason: 'suspicious' });
    const run = await scripted(world, [{ write: notes('Download the installer and check it.') }], ['release-notes']);
    try {
      const outcome = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io });
      const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(ctx));

      expect(run.said[0]).toMatch(/withheld/);
      expect(run.said[0]).toContain(`agents get ${versionOf(notes('One.'))}`);
      expect((await run.opened())[0]!.before).toBe(notes('Pipe the installer into sh.'));
      expect(outcome).toMatchObject({ ok: true, result: { changed: true } });
      expect(shown).toMatchObject({ ok: true, result: { skills: [{ served: versionOf(notes('Download the installer and check it.')), contested: [] }] } });
    } finally {
      await run.cleanup();
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

  test('BUSY at the commit offers to try again, and the retry commits once the tracker is free', async ({ world, grimoire }) => {
    const { ctx } = grimoire;
    const core = grimoire.makeCore({ writeBudgetMs: 300 });
    const held = await new MachineLocalStore(path.join(world.a.dir, '.git')).locks.acquire('tracker-write');
    if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
    const run = await scripted(world, [{ write: notes('One.') }], [
      'release-notes',
      async () => {
        await held.lock.release();
        return 'r';
      },
    ]);
    try {
      const outcome = await skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io });

      expect(outcome).toMatchObject({ ok: true, result: { created: true, changed: true } });
      expect(run.asked[1]).toMatch(/try again/i);
      expect(await read(core, ctx)).toBe(notes('One.'));
    } finally {
      await held.lock.release();
      await run.cleanup();
    }
  });

  test('a failure that ends the edit keeps the draft outside the temp copy, and says where', async ({ world, grimoire }) => {
    const { ctx } = grimoire;
    const core = grimoire.makeCore({ writeBudgetMs: 300 });
    const held = await new MachineLocalStore(path.join(world.a.dir, '.git')).locks.acquire('tracker-write');
    if (held.status !== 'acquired') throw new Error('could not take the fairness lock');
    const run = await scripted(world, [{ write: notes('A long draft.') }], ['release-notes', 's']);
    let kept: string | undefined;
    try {
      const outcome = await expectRefUnmoved(world.a, () => skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io }));
      kept = /Your draft is kept at (.+SKILL\.md)/.exec(run.said.join('\n'))?.[1];

      expect(outcome).toMatchObject({ ok: false, error: { code: 'BUSY', retryable: true } });
      expect(kept, run.said.join('\n')).toBeDefined();
      expect(await readFile(kept!, 'utf8')).toBe(notes('A long draft.'));
    } finally {
      await held.lock.release();
      await run.cleanup();
      if (kept) await removeDir(path.dirname(kept));
    }
  });

  test('Ctrl+C or Ctrl+D at a prompt ends the edit with nothing committed, and the draft is kept', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    // What node:readline's question() rejects with on Ctrl+C or Ctrl+D.
    const aborted = Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError', code: 'ABORT_ERR' });
    const run = await scripted(world, [{ write: notes('Half done.') }], [() => Promise.reject(aborted)]);
    let kept: string | undefined;
    try {
      const outcome = await expectRefUnmoved(world.a, () => skillEditFlow('release-notes', { core, ctx: terminal(ctx), io: run.io }));
      kept = /Your draft is kept at (.+SKILL\.md)/.exec(run.said.join('\n'))?.[1];

      expect(outcome).toEqual({ ok: true, result: { name: 'release-notes', changed: false, discarded: true } });
      expect(kept, run.said.join('\n')).toBeDefined();
      expect(await readFile(kept!, 'utf8')).toBe(notes('Half done.'));
    } finally {
      await run.cleanup();
      if (kept) await removeDir(path.dirname(kept));
    }
  });

  test('without a git identity it gives NO_GIT_IDENTITY before the editor opens, so no draft is written for nothing', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const run = await scripted(world, [{ write: notes('One.') }], ['release-notes']);
    try {
      const outcome = await skillEditFlow('release-notes', { core, ctx: { ...terminal(ctx), person: { name: null, email: null } }, io: run.io });

      expect(outcome).toMatchObject({ ok: false, error: { code: 'NO_GIT_IDENTITY' } });
      expect(await run.opened()).toEqual([]);
    } finally {
      await run.cleanup();
    }
  });

  test('the context the CLI builds from its environment refuses each agent marker, even at a terminal', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const marker of ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID']) delete env[marker];
    const run = await scripted(world, [{ write: notes('One.') }], ['release-notes']);
    try {
      for (const marker of ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID']) {
        const marked = await cliContext({ cwd: world.a.dir, env: { ...env, [marker]: '1' }, tty: true });
        const outcome = await skillEditFlow('release-notes', { core, ctx: marked, io: run.io });
        expect(outcome, marker).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
        expect(JSON.stringify(outcome)).not.toContain(marker);
      }
      const openedWhileMarked = await run.opened();
      // The same context without a marker, at a terminal, is a person's: the editor opens and the edit commits.
      const unmarked = await cliContext({ cwd: world.a.dir, env, tty: true });
      const committed = await skillEditFlow('release-notes', { core, ctx: unmarked, io: run.io });

      expect(openedWhileMarked).toEqual([]);
      expect(committed).toMatchObject({ ok: true, result: { created: true } });
      expect(unmarked).toMatchObject({ surface: 'cli', client: null, tty: true, person: { email: world.a.identity.email } });
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
