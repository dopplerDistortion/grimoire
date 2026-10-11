// `grimoire wiki edit <slug>` (spec §17, §10): the editor session around the
// human wiki edit. It edits a temp copy outside every worktree, checks the base
// with three choices, shows the diff, asks for the slug as a typed
// confirmation, and commits through the core. Driven here through its public
// function with a scripted terminal and an editor that writes the draft.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import type { CallContext } from '../../../src/core';
import { editWorkspace } from '../../../src/surfaces/cli/editor';
import { terminalOn, wikiEditSession, type Terminal } from '../../../src/surfaces/cli/wiki';
import {
  agentContext,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  fetchTrackerFrom,
  pushTracker,
  T0,
  TRACKER_REF,
  trackerTip,
} from '../../core/support';

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

/** A terminal whose answers are scripted (null: the person closed the prompt); it records what it was shown and asked. */
function scripted(...answers: (string | null)[]): Terminal & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    say: (text) => void said.push(text),
    ask: async (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
  };
}

/** An editor that records what it opened and replaces the text with each draft in turn. */
function editor(...drafts: ((opened: string) => string)[]) {
  const opened: { file: string; text: string }[] = [];
  return {
    opened,
    edit: async (file: string) => {
      const text = await readFile(file, 'utf8');
      opened.push({ file, text });
      const draft = drafts.shift();
      if (!draft) throw new Error('the editor opened once too often');
      await writeFile(file, draft(text));
    },
  };
}

const NEW_PAGE = [
  '---',
  'title: "Flaky port binding"',
  'kind: "failure"',
  'summary: "Tests fail when two servers race for one port."',
  '---',
  'Bind to port 0 and read the port back.',
  '',
].join('\n');

/** Replaces what sits above the scissors line, keeping the rest. */
const above = (text: string) => (opened: string) => text + opened.slice(opened.indexOf('# ------------------------ >8'));

describe('wiki edit in the editor', () => {
  test('creates a page from a temp copy outside every worktree, after the diff and the typed slug', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const screen = scripted('flaky-port-binding');
    const ed = editor(() => NEW_PAGE);

    const outcome = await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: screen, edit: ed.edit });

    expect(outcome).toEqual({ ok: true, result: { slug: 'flaky-port-binding', created: true, changed: true, base: expect.any(String), resolved: [] } });
    const file = ed.opened[0]!.file;
    for (const tree of [world.a.dir, world.b.dir, world.root]) {
      expect(path.relative(tree, file).startsWith('..') || path.isAbsolute(path.relative(tree, file))).toBe(true);
    }
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ed.opened[0]!.text).toMatch(/^---\ntitle: ""\nkind: "failure"\nsummary: ""\n---\n/);
    expect(screen.said.join('\n')).toContain('+Bind to port 0 and read the port back.');
    expect(screen.asked).toEqual([expect.stringContaining('flaky-port-binding')]);
    expect(await world.a.git(['status', '--porcelain', '--ignored', '--untracked-files=all'])).toBe('');
    const shown = await core.call('wiki_show', { slug: 'flaky-port-binding' }, terminal(ctx));
    expect(shown.ok && shown.result.body).toBe('Bind to port 0 and read the port back.\n');
  });

  test('an update opens the current page; a wrong typed slug discards the draft, writing nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted('flaky-port-binding'), edit: editor(() => NEW_PAGE).edit });
    const ed = editor((opened) => opened.replace('read the port back.', 'read the port back.\nNever hard-code 8080.'));

    const outcome = await expectRefUnmoved(world.a, () =>
      wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted('no'), edit: ed.edit }),
    );

    expect(ed.opened[0]!.text.startsWith(NEW_PAGE)).toBe(true);
    expect(outcome).toEqual({ ok: true, result: { slug: 'flaky-port-binding', changed: false, discarded: true } });
  });

  test('saving the text unchanged commits nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted('flaky-port-binding'), edit: editor(() => NEW_PAGE).edit });

    const outcome = await expectRefUnmoved(world.a, () =>
      wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted(), edit: editor((opened) => opened).edit }),
    );

    expect(outcome).toMatchObject({ ok: true, result: { changed: false } });
  });

  test('a moved base offers redo on the current text, replace with confirmation, or discard, by letter or by word', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const human = terminal(ctx);
    await wikiEditSession('flaky-port-binding', { core, ctx: human, terminal: scripted('flaky-port-binding'), edit: editor(() => NEW_PAGE).edit });
    /** Someone else's edit lands while the editor is open. */
    const meanwhile = (note: string) => async (opened: string) => {
      const shown = await core.call('wiki_show', { slug: 'flaky-port-binding' }, human);
      const base = shown.ok ? shown.result.base : '';
      await core.call('wiki_edit', { slug: 'flaky-port-binding', base, body: `${shown.ok ? shown.result.body : ''}${note}\n` }, human);
      return opened.replace('read the port back.', 'read the port back.\nMy line.');
    };
    const withRace = (note: string, ...rest: ((opened: string) => string)[]) => {
      const race = meanwhile(note);
      let raced = false;
      const plain = editor(...rest);
      return {
        opened: plain.opened,
        edit: async (file: string) => {
          if (raced) return plain.edit(file);
          raced = true;
          const text = await readFile(file, 'utf8');
          plain.opened.push({ file, text });
          await writeFile(file, await race(text));
        },
      };
    };

    const discarded = await (async () => {
      const ed = withRace('Theirs one.');
      const before = await trackerTip(world.a);
      const outcome = await wikiEditSession('flaky-port-binding', { core, ctx: human, terminal: scripted('flaky-port-binding', 'discard'), edit: ed.edit });
      return { outcome, moved: (await trackerTip(world.a)) !== before };
    })();
    const redone = withRace('Theirs two.', (opened) => opened.replace('Theirs two.', 'Theirs two.\nMy line, redone.'));
    const redo = await wikiEditSession('flaky-port-binding', {
      core,
      ctx: human,
      terminal: scripted('flaky-port-binding', 'r', 'flaky-port-binding'),
      edit: redone.edit,
    });
    const replaced = await wikiEditSession('flaky-port-binding', {
      core,
      ctx: human,
      terminal: scripted('flaky-port-binding', 'x', 'replace', 'flaky-port-binding'),
      edit: withRace('Theirs three.').edit,
    });

    expect(discarded.outcome).toEqual({ ok: true, result: { slug: 'flaky-port-binding', changed: false, discarded: true } });
    expect(discarded.moved).toBe(true); // only the other edit landed
    expect(redo).toMatchObject({ ok: true, result: { changed: true } });
    expect(redone.opened[1]!.text).toContain('Theirs two.');
    expect(redone.opened[1]!.text.slice(redone.opened[1]!.text.indexOf('>8'))).toContain('My line.');
    expect(replaced).toMatchObject({ ok: true, result: { changed: true } });
    const shown = await core.call('wiki_show', { slug: 'flaky-port-binding' }, human);
    // The replace wrote the draft over the other edit: their third line is gone.
    expect(shown.ok && shown.result.body).toBe('Bind to port 0 and read the port back.\nMy line.\nTheirs one.\nTheirs two.\nMy line, redone.\n');
  });

  test('a refused draft can be edited again: a secret is reported without quoting it, then the fixed draft commits', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const token = ['ghp', 'R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u'].join('_');
    const screen = scripted('flaky-port-binding', 'e', 'flaky-port-binding');
    const ed = editor(
      () => NEW_PAGE.replace('read the port back.', `read the port back. Token: ${token}`),
      (opened) => opened.replace(` Token: ${token}`, ''),
    );

    const outcome = await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: screen, edit: ed.edit });

    expect(outcome).toMatchObject({ ok: true, result: { created: true } });
    expect(ed.opened[1]!.text).toContain(token); // the draft comes back to fix
    const shownToPerson = screen.said.join('\n');
    expect(shownToPerson).toContain('github-pat');
  });

  test('a conflicted page opens with every set-aside side below the scissors, and saving reconciles them', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const human = terminal(ctx);
    await wikiEditSession('flaky-port-binding', { core, ctx: human, terminal: scripted('flaky-port-binding'), edit: editor(() => NEW_PAGE).edit });
    // Fold a concurrent edit from clone b in: overlapping hunks set one side aside.
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const base = await core.call('wiki_show', { slug: 'flaky-port-binding' }, human);
    const later = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 60_000) });
    const baseVersion = base.ok ? base.result.base : '';
    const written = await Promise.all([
      core.call('wiki_edit', { slug: 'flaky-port-binding', base: baseVersion, body: 'Bind to port 0 and read the port back (alice).\n' }, human),
      later.call('wiki_edit', { slug: 'flaky-port-binding', base: baseVersion, body: 'Bind to port 0 and read the port back (bob).\n' }, terminal(agentContext(world.b))),
    ]);
    expect(written.map((result) => result.ok)).toEqual([true, true]);
    await fetchTrackerFrom(world.a, world.b);
    const ed = editor(above(NEW_PAGE.replace('read the port back.', 'read the port back (alice and bob).')));

    const outcome = await wikiEditSession('flaky-port-binding', { core, ctx: human, terminal: scripted('flaky-port-binding'), edit: ed.edit });

    const opened = ed.opened[0]!.text;
    expect(opened.indexOf('read the port back (bob).')).toBeLessThan(opened.indexOf('>8'));
    expect(opened.indexOf('read the port back (alice).')).toBeGreaterThan(opened.indexOf('>8'));
    expect(outcome).toMatchObject({ ok: true, result: { changed: true, resolved: [expect.any(String)] } });
    const shown = await core.call('wiki_show', { slug: 'flaky-port-binding' }, human);
    expect(shown.ok && [shown.result.conflicted, shown.result.body]).toEqual([false, 'Bind to port 0 and read the port back (alice and bob).\n']);
  });

  test('a prompt closed with Ctrl-C or Ctrl-D discards the draft, writing nothing, and removes the temp copy', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const atConfirmation = editor(() => NEW_PAGE);
    const atRetry = editor(() => 'no header at all\n');

    const outcomes = await expectRefUnmoved(world.a, async () => [
      await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted(null), edit: atConfirmation.edit }),
      await wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted(null), edit: atRetry.edit }),
    ]);

    expect(outcomes).toEqual([
      { ok: true, result: { slug: 'flaky-port-binding', changed: false, discarded: true } },
      { ok: true, result: { slug: 'flaky-port-binding', changed: false, discarded: true } },
    ]);
    for (const opened of [atConfirmation.opened[0]!, atRetry.opened[0]!]) {
      await expect(stat(path.dirname(opened.file))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('a temp copy that can’t be removed is reported, and never turns the commit into an error', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const screen = scripted('flaky-port-binding');
    let left = '';
    /** A workspace whose removal fails the way a Windows file lock makes it fail. */
    const locked = async (root: string) => {
      const real = await editWorkspace(root);
      left = real.dir;
      return {
        dir: real.dir,
        remove: async () => {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${real.dir}'`), { code: 'EBUSY' });
        },
      };
    };
    try {
      const outcome = await wikiEditSession('flaky-port-binding', {
        core,
        ctx: terminal(ctx),
        terminal: screen,
        edit: editor(() => NEW_PAGE).edit,
        workspace: locked,
      });

      expect(outcome).toMatchObject({ ok: true, result: { slug: 'flaky-port-binding', created: true, changed: true } });
      expect(left).toMatch(/grimoire-edit-/);
      expect(screen.said.at(-1)).toContain(left);
    } finally {
      await removeDir(left);
    }
  });

  test('a temp directory inside a worktree (the checkout or a linked one) is refused before any editor opens, leaving nothing behind', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const linked = path.join(await makeTempDir('grimoire-linked-'), 'tree');
    await world.a.git(['worktree', 'add', '--quiet', '--detach', linked]);
    const temps = [path.join(world.a.dir, 'scratch'), path.join(linked, 'scratch')];
    const ed = editor();
    try {
      const outcomes = [];
      for (const temp of temps) {
        await mkdir(temp);
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, temp);
        outcomes.push(
          await expectRefUnmoved(world.a, () =>
            wikiEditSession('flaky-port-binding', { core, ctx: terminal(ctx), terminal: scripted(), edit: ed.edit }),
          ),
        );
      }

      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ ok: false, error: { code: 'INVALID', message: expect.stringMatching(/inside a worktree.*TMPDIR/) } });
      }
      expect(ed.opened).toEqual([]);
      for (const temp of temps) expect(await readdir(temp)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await removeDir(path.dirname(linked));
      await world.a.git(['worktree', 'prune']);
    }
  });

  test('from an agent surface it is refused before any editor opens', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const ed = editor();

    const outcome = await expectRefUnmoved(world.a, () =>
      wikiEditSession('flaky-port-binding', { core, ctx: { ...terminal(ctx), evidence: { agentMarkers: ['AI_AGENT'] } }, terminal: scripted(), edit: ed.edit }),
    );

    expect(outcome).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    expect(ed.opened).toEqual([]);
  });
});

describe('the console terminal', () => {
  test('answers a prompt with the line typed, and with null when the input closes (Ctrl-D) or the person presses Ctrl-C', async () => {
    const quiet = () => new PassThrough().resume();
    const typed = new PassThrough();
    const closed = new PassThrough();
    const interrupted = new PassThrough();

    const answers = [
      terminalOn({ stdin: typed, stderr: quiet(), terminal: false }).ask('Type it: '),
      terminalOn({ stdin: closed, stderr: quiet(), terminal: false }).ask('Type it: '),
      terminalOn({ stdin: interrupted, stderr: quiet(), terminal: true }).ask('Type it: '),
    ];
    typed.write('flaky-port-binding\n');
    closed.end();
    interrupted.write('\x03');

    expect(await Promise.all(answers)).toEqual(['flaky-port-binding', null, null]);
  });
});
