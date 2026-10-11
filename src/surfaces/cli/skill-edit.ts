// `grimoire skill edit <name>` (spec §15 Human editing, §7 the human-only
// gate, §10): the interactive half of `skill_edit`. It opens the user's git
// editor on a temp copy outside every worktree, shows the diff, takes the typed
// name as confirmation, and commits through the core, which checks the base and
// secret-scans the text. On a moved base it offers "Redo my edit on the current
// text", "Replace with my draft" (confirmed) or "Discard".
//
// Prompts go to stderr; stdout carries only the one JSON result (spec §10).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { CallContext, Core, ErrorBody, Outcome, SkillEditResult } from '../../core';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';
import { checkSurface } from '../../core/op';
import { GrimoireError } from '../../errors';
import { cleanGitEnv, runGit } from '../../git/run';
import { normalizeSkillText, skillNameProblem } from '../../knowledge';

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

/** The agent markers of spec §7: any one set makes a CLI call an agent's. */
export const AGENT_MARKERS = ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID'] as const;

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
async function currentOf(deps: SkillEditDeps, name: string): Promise<{ base: string | null; text: string | null; blocked: boolean }> {
  const shown = await deps.core.call('skill_show', { name }, deps.ctx);
  if (!shown.ok) {
    if (shown.error.code === 'NOT_FOUND') return { base: null, text: null, blocked: false };
    throw new GrimoireError(shown.error.code, shown.error.message, shown.error.details);
  }
  const [skill] = shown.result.skills;
  return { base: skill?.current ?? null, text: skill?.text ?? null, blocked: skill?.blocked ?? false };
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

/**
 * Runs the whole edit: from the current text (or a template) through the
 * editor, the diff and the typed name to one commit, or to nothing.
 */
export async function skillEditFlow(name: string, deps: SkillEditDeps): Promise<Outcome<SkillEditResult | SkillEditDiscarded>> {
  const { core, ctx, io } = deps;
  const discarded = { ok: true as const, result: { name, changed: false as const, discarded: true as const } };
  let dir: string | null = null;
  try {
    // Refuse before any editor opens.
    checkSurface({ name: 'skill edit', policy: 'human-only' }, ctx);
    const problem = skillNameProblem(name);
    if (problem) throw new GrimoireError('INVALID', `invalid input (name: ${problem})`, { fields: { name: problem } });
    let { base, text: opened, blocked } = await currentOf(deps, name);
    if (blocked) {
      const why = `${name} was deleted or ejected, and its name stays blocked until a human lifts the block (grimoire skill unblock ${name})`;
      throw new GrimoireError('INVALID', why, { fields: { name: why } });
    }
    dir = await mkdtemp(path.join(os.tmpdir(), 'grimoire-skill-'));
    if (await insideAWorktree(ctx.repo.root, dir)) {
      throw new GrimoireError('INVALID', `the temp directory ${dir} is inside a worktree; set TMPDIR (TEMP on Windows) to a folder outside the repo`);
    }
    const file = path.join(dir, name, 'SKILL.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, opened ?? template(name));
    for (;;) {
      await io.edit(file);
      const draft = await readFile(file, 'utf8');
      const before = opened ?? template(name);
      if (normalizeSkillText(draft) === normalizeSkillText(before)) {
        io.say('No changes; nothing committed.');
        return discarded;
      }
      io.say(await diff(path.join(dir, '.diff'), opened ?? '', normalizeSkillText(draft)));
      const typed = await io.ask(`Type ${name} to commit this as the new version of ${name}: `);
      if (typed.trim() !== name) {
        if ((await choose(io, 'Not committed. Edit again (e) or discard (d)? ', ['e', 'd'])) === 'e') continue;
        return discarded;
      }
      const outcome = await core.call('skill_edit', { name, text: draft, base }, ctx);
      if (outcome.ok) {
        io.say(`Committed ${name} at ${outcome.result.version}.`);
        return outcome;
      }
      const { error } = outcome;
      if (error.code === 'INVALID') {
        const fields = (error.details.fields ?? {}) as Record<string, string>;
        io.say(`Not committed: ${Object.values(fields).join('; ') || error.message}`);
        if ((await choose(io, 'Edit again (e) or discard (d)? ', ['e', 'd'])) === 'e') continue;
        return discarded;
      }
      if (error.code !== 'BASE_MOVED') return outcome;
      const now = await currentOf(deps, name);
      io.say(`${name} changed since you opened it: it is now at ${now.base ?? 'no version'}.`);
      io.say(await diff(path.join(dir, '.diff'), opened ?? '', now.text ?? ''));
      const choice = await choose(
        io,
        `1) Redo my edit on the current text\n2) Replace with my draft\n3) Discard\nChoose 1, 2 or 3: `,
        ['1', '2', '3'],
      );
      if (choice === '3') return discarded;
      if (choice === '2') {
        const sure = await io.ask(`Type ${name} to replace the current version of ${name} with your draft: `);
        if (sure.trim() !== name) return discarded;
        const replaced = await core.call('skill_edit', { name, text: draft, base, replace: true }, ctx);
        if (replaced.ok) io.say(`Committed ${name} at ${replaced.result.version}.`);
        return replaced;
      }
      // Redo: the editor reopens on the current text; the draft stays beside it.
      const kept = path.join(dir, 'my-draft', 'SKILL.md');
      await mkdir(path.dirname(kept), { recursive: true });
      await writeFile(kept, draft);
      io.say(`Your draft is kept at ${kept} while you redo the edit.`);
      base = now.base;
      opened = now.text;
      await writeFile(file, opened ?? template(name));
    }
  } catch (error) {
    return failure(error);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The CLI verb: `grimoire skill edit <name>`. Returns the exit code (spec §10). */
export async function runSkillEdit(argv: readonly string[]): Promise<number> {
  const name = argv[0];
  if (name === undefined || argv.length > 1 || name.startsWith('-')) {
    process.stderr.write('usage: grimoire skill edit <name>\n');
    return 2;
  }
  const { createCore } = await import('../../core');
  const core = createCore();
  try {
    const root = await findHostRoot(process.cwd());
    const config = await readCheckoutConfig(root);
    const markers = AGENT_MARKERS.filter((marker) => (process.env[marker] ?? '') !== '');
    const ctx: CallContext = {
      surface: 'cli',
      repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
      person: await readPerson(root),
      client: null,
      evidence: markers.length > 0 ? { agentMarkers: markers } : {},
      tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
      nonce: randomBytes(8).toString('hex'),
    };
    const io: SkillEditIo = {
      edit: gitEditor(root),
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
    if (!(error instanceof GrimoireError)) throw error;
    process.stdout.write(`${JSON.stringify({ error: error.toBody() })}\n`);
    return 1;
  } finally {
    await core.close();
  }
}
