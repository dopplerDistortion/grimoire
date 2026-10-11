// `grimoire skill edit <name>` (spec §15 Human editing, §7 the human-only
// gate, §10): the interactive half of `skill_edit`. It opens the user's git
// editor on a temp copy outside every worktree, shows the diff, takes the typed
// name as confirmation, and commits through the core, which checks the base and
// secret-scans the text. On a moved base it offers "Redo my edit on the current
// text", "Replace with my draft" (confirmed, and only over the version shown)
// or "Discard"; on BUSY it offers to try again. A draft the human neither
// committed nor discarded (a failure, Ctrl+C) is kept in a file and named.
//
// Prompts go to stderr; stdout carries only the one JSON result (spec §10).
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { CallContext, Core, ErrorBody, Outcome, SkillEditResult } from '../../core';
import { checkSurface, writer } from '../../core/op';
import { GrimoireError } from '../../errors';
import { cleanGitEnv, runGit } from '../../git/run';
import { normalizeSkillText, skillNameProblem } from '../../knowledge';
import { cliContext } from './context';

/** The terminal and the editor, as the flow uses them. */
export interface SkillEditIo {
  /** Opens the user's git editor on `file` and waits until it closes. */
  edit(file: string): Promise<void>;
  /** Asks one question on the terminal and returns the answer line. */
  ask(question: string): Promise<string>;
  /** Tells the person something on the terminal. */
  say(text: string): void;
}

export interface SkillEditDeps {
  readonly core: Pick<Core, 'call'>;
  readonly ctx: CallContext;
  readonly io: SkillEditIo;
}

/** What the flow ends with when nothing was committed. */
export interface SkillEditDiscarded {
  name: string;
  changed: false;
  discarded: true;
}

/**
 * Launches the user's git editor on a file the way git itself does, through
 * `git config --edit --file`: git resolves GIT_EDITOR, core.editor, VISUAL and
 * EDITOR, and runs the command line as it would for a commit message.
 */
export function gitEditor(root: string, env: NodeJS.ProcessEnv = process.env): (file: string) => Promise<void> {
  const editorEnv = cleanGitEnv(env);
  if (env.GIT_EDITOR !== undefined) editorEnv.GIT_EDITOR = env.GIT_EDITOR;
  return (file) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', ['config', '--edit', '--file', file], { cwd: root, env: editorEnv, stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`the editor exited with code ${code}`))));
    });
}

function failure(error: unknown): { ok: false; error: ErrorBody } {
  if (error instanceof GrimoireError) return { ok: false, error: error.toBody() };
  throw error;
}

/** Whether `dir` lies inside any worktree of the clone at `root`. */
async function insideAWorktree(root: string, dir: string): Promise<boolean> {
  const run = await runGit(root, ['worktree', 'list', '--porcelain']);
  const worktrees = [root];
  for (const line of run.stdout.toString('utf8').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) worktrees.push(line.slice('worktree '.length));
  }
  const real = await realpath(dir);
  for (const worktree of worktrees) {
    const relative = path.relative(await realpath(worktree).catch(() => path.resolve(worktree)), real);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  }
  return false;
}

function template(name: string): string {
  return `---\nname: ${name}\ndescription: \n---\n# ${name}\n\n`;
}

/** The skill's current version and text, from `skill_show` (null: it has none). */
async function currentOf(deps: SkillEditDeps, name: string): Promise<{ base: string | null; text: string | null; blocked: boolean; withheld: string | null }> {
  const shown = await deps.core.call('skill_show', { name }, deps.ctx);
  if (!shown.ok) {
    if (shown.error.code === 'NOT_FOUND') return { base: null, text: null, blocked: false, withheld: null };
    throw new GrimoireError(shown.error.code, shown.error.message, shown.error.details);
  }
  const [skill] = shown.result.skills;
  const base = skill?.current ?? null;
  // A suspicious contested decision withholds the current version from agents: the human should know before editing it.
  const contest = skill?.contested.find((c) => c.withheld && base !== null && c.accepted.includes(base));
  const withheld =
    contest && skill?.served !== base
      ? `${name} is contested: its current version ${base} was accepted from proposal ${contest.proposal}, and that proposal was also rejected as suspicious, so it is withheld and agents get ${skill?.served ?? 'no version of it'} instead. The editor opens on the withheld text; committing an edit settles the contest.`
      : null;
  return { base, text: skill?.text ?? null, blocked: skill?.blocked ?? false, withheld };
}

/** The unified diff of two texts, as `git diff --no-index` prints it. */
async function diff(dir: string, before: string, after: string): Promise<string> {
  await mkdir(path.join(dir, 'current'), { recursive: true });
  await mkdir(path.join(dir, 'draft'), { recursive: true });
  await writeFile(path.join(dir, 'current', 'SKILL.md'), before);
  await writeFile(path.join(dir, 'draft', 'SKILL.md'), after);
  const run = await runGit(dir, ['diff', '--no-index', '--no-color', '--no-prefix', '--', 'current/SKILL.md', 'draft/SKILL.md']);
  return run.stdout.toString('utf8');
}

async function choose(io: SkillEditIo, question: string, choices: readonly string[]): Promise<string> {
  for (;;) {
    const answer = (await io.ask(question)).trim().toLowerCase();
    if (choices.includes(answer)) return answer;
    io.say(`Please answer ${choices.join(', ')}.`);
  }
}

/** Saves a draft nothing committed where the temp copy's cleanup won't reach, and tells the human where. */
async function keepDraft(io: SkillEditIo, name: string, draft: string): Promise<void> {
  try {
    const kept = path.join(await mkdtemp(path.join(os.tmpdir(), `grimoire-draft-${name}-`)), 'SKILL.md');
    await writeFile(kept, draft);
    io.say(`Nothing was committed. Your draft is kept at ${kept}`);
  } catch {
    io.say(`Nothing was committed, and your draft could not be saved to a file; here it is:\n${draft}`);
  }
}

/** The three choices on a moved base (spec §15). Replacing takes the typed name; a mistyped one offers the choices again. */
async function movedChoice(io: SkillEditIo, name: string): Promise<'redo' | 'replace' | 'discard'> {
  for (;;) {
    const choice = await choose(io, `1) Redo my edit on the current text\n2) Replace with my draft\n3) Discard\nChoose 1, 2 or 3: `, ['1', '2', '3']);
    if (choice === '1') return 'redo';
    if (choice === '3') return 'discard';
    const sure = await io.ask(`Type ${name} to replace the current version of ${name} with your draft: `);
    if (sure.trim() === name) return 'replace';
    io.say('Not replaced.');
  }
}

/**
 * Runs the whole edit: from the current text (or a template) through the
 * editor, the diff and the typed name to one commit, or to nothing.
 */
export async function skillEditFlow(name: string, deps: SkillEditDeps): Promise<Outcome<SkillEditResult | SkillEditDiscarded>> {
  const { core, ctx, io } = deps;
  const discarded = { ok: true as const, result: { name, changed: false as const, discarded: true as const } };
  let dir: string | null = null;
  /** The human's latest draft, until it is committed or they discard it: anything else that ends the edit keeps it. */
  let unsaved: string | null = null;
  const discard = () => {
    unsaved = null;
    return discarded;
  };
  try {
    // Refuse before any editor opens.
    checkSurface({ name: 'skill edit', policy: 'human-only' }, ctx);
    // The commit will need the person's identity: say so now, not after the human wrote a draft.
    writer(ctx);
    const problem = skillNameProblem(name);
    if (problem) throw new GrimoireError('INVALID', `invalid input (name: ${problem})`, { fields: { name: problem } });
    let { base, text: opened, blocked, withheld } = await currentOf(deps, name);
    if (blocked) {
      const why = `${name} was deleted or ejected, and its name stays blocked until a human lifts the block (grimoire skill unblock ${name})`;
      throw new GrimoireError('INVALID', why, { fields: { name: why } });
    }
    if (withheld) io.say(withheld);
    dir = await mkdtemp(path.join(os.tmpdir(), 'grimoire-skill-'));
    if (await insideAWorktree(ctx.repo.root, dir)) {
      throw new GrimoireError('INVALID', `the temp directory ${dir} is inside a worktree; set TMPDIR (TEMP on Windows) to a folder outside the repo`);
    }
    const file = path.join(dir, name, 'SKILL.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, opened ?? template(name));
    edits: for (;;) {
      await io.edit(file);
      const draft = await readFile(file, 'utf8');
      const before = opened ?? template(name);
      if (normalizeSkillText(draft) === normalizeSkillText(before)) {
        io.say('No changes; nothing committed.');
        return discarded;
      }
      unsaved = draft;
      io.say(await diff(path.join(dir, '.diff'), opened ?? '', normalizeSkillText(draft)));
      const typed = await io.ask(`Type ${name} to commit this as the new version of ${name}: `);
      if (typed.trim() !== name) {
        if ((await choose(io, 'Not committed. Edit again (e) or discard (d)? ', ['e', 'd'])) === 'e') continue;
        return discard();
      }
      /** Once the human chose "Replace with my draft": the version they were shown and confirmed replacing. */
      let replacing: { version: string | null } | null = null;
      for (;;) {
        const input = { name, text: draft, base, ...(replacing ? { replace: replacing.version } : {}) };
        const outcome = await core.call('skill_edit', input, ctx);
        if (outcome.ok) {
          unsaved = null;
          io.say(`Committed ${name} at ${outcome.result.version}.`);
          return outcome;
        }
        const { error } = outcome;
        if (error.code === 'INVALID') {
          const fields = (error.details.fields ?? {}) as Record<string, string>;
          io.say(`Not committed: ${Object.values(fields).join('; ') || error.message}`);
          if ((await choose(io, 'Edit again (e) or discard (d)? ', ['e', 'd'])) === 'e') continue edits;
          return discard();
        }
        if (error.code === 'BUSY') {
          io.say(`Not committed: ${error.message}`);
          if ((await choose(io, 'Try again (r) or stop (s)? ', ['r', 's'])) === 'r') continue;
          return outcome;
        }
        if (error.code !== 'BASE_MOVED') return outcome;
        const now = await currentOf(deps, name);
        io.say(`${name} changed since you opened it: it is now at ${now.base ?? 'no version'}.`);
        io.say(await diff(path.join(dir, '.diff'), opened ?? '', now.text ?? ''));
        const choice = await movedChoice(io, name);
        if (choice === 'discard') return discard();
        if (choice === 'replace') {
          replacing = { version: now.base };
          continue;
        }
        // Redo: the editor reopens on the current text; the draft stays beside it, where no skill name reaches (names never start with a dot).
        const kept = path.join(dir, '.my-draft', 'SKILL.md');
        await mkdir(path.dirname(kept), { recursive: true });
        await writeFile(kept, draft);
        io.say(`Your draft is kept at ${kept} while you redo the edit.`);
        base = now.base;
        opened = now.text;
        await writeFile(file, opened ?? template(name));
        continue edits;
      }
    }
  } catch (error) {
    // Ctrl+C or Ctrl+D at a prompt (node:readline rejects with an AbortError): the human left, so nothing is committed.
    if (error instanceof Error && error.name === 'AbortError') return discarded;
    return failure(error);
  } finally {
    if (unsaved !== null) await keepDraft(io, name, unsaved);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const USAGE = 'grimoire skill edit <name>';

/** The CLI verb: `grimoire skill edit <name>`, or `--help`. Returns the exit code (spec §10). */
export async function runSkillEdit(argv: readonly string[], options: { readonly bin: string }): Promise<number> {
  const { createCore, spawnedAutoSync } = await import('../../core');
  if (argv.length === 1 && argv[0] === '--help') {
    // Every verb's --help (spec §10): the op's input schema, as the one JSON object (the wiki verbs' shape).
    const op = createCore({ autoSync: 'off' }).ops.find((descriptor) => descriptor.name === 'skill_edit')!;
    const help = {
      verb: 'skill edit',
      op: op.name,
      description: op.description,
      kind: op.kind,
      policy: op.policy,
      usage: USAGE,
      positionals: ['name'],
      input_schema: op.inputSchema,
      interactive: 'opens your git editor at an interactive terminal, with no agent marker set; you type the name to confirm',
    };
    process.stdout.write(`${JSON.stringify(help)}\n`);
    return 0;
  }
  const name = argv[0];
  if (name === undefined || argv.length > 1 || name.startsWith('-')) {
    process.stderr.write(`usage: ${USAGE}\n`);
    return 2;
  }
  // A CLI write leaves the sync to a detached `grimoire sync --background` (spec §4).
  const core = createCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: [options.bin, 'sync', '--background'] }) });
  try {
    const ctx = await cliContext({ cwd: process.cwd(), env: process.env, tty: process.stdin.isTTY === true && process.stdout.isTTY === true });
    const io: SkillEditIo = {
      edit: gitEditor(ctx.repo.root),
      async ask(question) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      },
      say: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    };
    const outcome = await skillEditFlow(name, { core, ctx, io });
    process.stdout.write(`${JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error })}\n`);
    return outcome.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: errorBody(error) })}\n`);
    return 1;
  } finally {
    await core.close();
  }
}

/** grimoire's errors as they are; anything else (a bug) as INTERNAL, with its stack on stderr (ADR 0012). */
function errorBody(error: unknown): ErrorBody {
  if (error instanceof GrimoireError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grimoire skill edit: ${error instanceof Error && error.stack ? error.stack : message}\n`);
  return {
    code: 'INTERNAL',
    message: `grimoire failed unexpectedly (${message}); grimoire skill show tells whether the edit was committed`,
    retryable: false,
    details: {},
  };
}
