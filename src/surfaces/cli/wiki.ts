// `grimoire wiki edit <slug>` (human-only, spec §17 and §10): the one
// interactive wiki verb. Its editor session edits a temp copy of the page
// outside every worktree in the person's git editor, checks the base (redo on
// the current text, replace with confirmation, or discard), shows the diff,
// takes the slug as the typed confirmation, and commits through the core's
// `wiki_edit`, which secret-scans the text and applies the size limits.
// Prompts and the diff go to the terminal (stderr); the caller prints the one
// JSON result on stdout. The CLI's dispatcher runs the session for `wiki edit`
// at a terminal instead of calling `wiki_edit` itself:
//
//   wikiEditSession(slug, { core, ctx, terminal: terminalOn(io), edit: (file) => openGitEditor(file, ctx.repo.root) })
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CallContext, Core, ErrorBody, Outcome, WikiEditResult, WikiShowResult } from '../../core';
import { checkSurface } from '../../core/op';
import { GrimoireError } from '../../errors';
import { runGit } from '../../git/run';
import { editWorkspace, type EditWorkspace } from './editor';

/** Where the session talks to the person. */
export interface Terminal {
  /** Shows text (never on stdout, which carries the one JSON result). */
  say(text: string): void;
  /** Asks a question and returns the answer line, or null when the person closed the prompt (Ctrl-C, Ctrl-D). */
  ask(question: string): Promise<string | null>;
}

export interface WikiEditDeps {
  readonly core: Pick<Core, 'call'>;
  readonly ctx: CallContext;
  readonly terminal: Terminal;
  /** Opens the person's editor on `file`; resolves when they close it, rejects when the editor fails. */
  readonly edit: (file: string) => Promise<void>;
  /** Makes the temp directory the page is edited in (default: `editWorkspace`, outside every worktree). */
  readonly workspace?: (root: string) => Promise<EditWorkspace>;
}

/** What `wiki edit` ends with: the core's result, or a draft the person discarded. */
export type WikiEditSessionResult = WikiEditResult | { slug: string; changed: false; discarded: true };

/** The line below which the editable text is ignored (git's own scissors line). */
const SCISSORS = '# ------------------------ >8 ------------------------';

interface Draft {
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly body: string;
}

/** The page as the editable header and body (no notes). */
function pageText(page: Draft): string {
  return `---\ntitle: ${JSON.stringify(page.title)}\nkind: ${JSON.stringify(page.kind)}\nsummary: ${JSON.stringify(page.summary)}\n---\n${page.body}`;
}

const NEW_PAGE: Draft = { title: '', kind: 'failure', summary: '', body: '' };

/** The text the editor opens: the page above the scissors, notes and the other sides below it. */
function compose(slug: string, page: WikiShowResult | null, previous: string | null): string {
  const text = pageText(page ?? NEW_PAGE);
  const notes = [
    SCISSORS,
    '# Do not modify or remove the line above: everything below it is ignored.',
    page
      ? `# Editing the wiki page ${slug}. Change the title, kind (failure or strategy), summary (at most 200 characters) or body above.`
      : `# Creating the wiki page ${slug}: fill in a title, a kind (failure or strategy), a summary (at most 200 characters) and a body above.`,
  ];
  const sides = page?.sides ?? [];
  if (sides.length > 0) {
    notes.push(
      '#',
      `# This page is conflicted: a fold set ${sides.length === 1 ? 'another side' : `${sides.length} other sides`} of it aside, shown below.`,
      '# Above is the side the fold kept. Reconcile the sides above; saving resolves them.',
    );
    sides.forEach((side, i) => {
      const sources = side.sources.length > 0 ? `; sources ${side.sources.join(', ')}` : '';
      notes.push('#', `# === Set-aside side ${i + 1} of ${sides.length}: its ${side.fields.join(', ')}, written ${side.at}${sources} ===`);
      for (const field of ['title', 'kind', 'summary'] as const) if (side[field] !== undefined) notes.push(`${field}: ${JSON.stringify(side[field])}`);
      if (side.body !== undefined) notes.push(side.body.replace(/\n$/, ''));
    });
  }
  if (previous !== null) notes.push('#', '# === Your draft, made on an older version of the page ===', previous.replace(/\n$/, ''));
  return `${text}${text.endsWith('\n') ? '' : '\n'}${notes.join('\n')}\n`;
}

/** The part of a saved text above the scissors line. */
function aboveScissors(text: string): string {
  if (text.startsWith(SCISSORS)) return '';
  const at = text.indexOf(`\n${SCISSORS}`);
  return at < 0 ? text : text.slice(0, at + 1);
}

const EDITABLE = new Set(['title', 'kind', 'summary']);

/** The draft in a saved text, or why it can't be read. */
function parseDraft(saved: string, keepCr: boolean, original: Draft): Draft | { problem: string } {
  let text = saved.replace(/^﻿/, '');
  if (!keepCr) text = text.replace(/\r\n/g, '\n');
  const kept = aboveScissors(text);
  if (!kept.startsWith('---\n')) return { problem: 'the text must start with the --- header holding title, kind and summary' };
  const close = kept.indexOf('\n---\n', 3);
  if (close < 0) return { problem: 'the --- header is not closed by a --- line' };
  const values: Record<string, string> = {};
  for (const line of kept.slice(4, close).split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([^:]+):[ \t]?(.*)$/.exec(line);
    const key = match?.[1]?.trim();
    if (!match || !key || !EDITABLE.has(key)) return { problem: `the header may hold only title, kind and summary (found "${line.slice(0, 40)}")` };
    const raw = match[2]!.trim();
    let value = raw;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // Not JSON: the text as written.
    }
    values[key] = value;
  }
  let body = kept.slice(close + 5);
  // The scissors line needs a line of its own: a body without a final newline got one.
  if (!original.body.endsWith('\n') && body === `${original.body}\n`) body = original.body;
  return { title: values.title ?? '', kind: values.kind ?? '', summary: values.summary ?? '', body };
}

const sameDraft = (x: Draft, y: Draft) => x.title === y.title && x.kind === y.kind && x.summary === y.summary && x.body === y.body;

/** `git diff --no-index` of the page as it stands and the draft. */
async function diffOf(dir: string, current: string, draft: string): Promise<string> {
  await writeFile(path.join(dir, 'current.md'), current);
  await writeFile(path.join(dir, 'draft.md'), draft);
  const run = await runGit(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', 'current.md', 'draft.md']);
  return run.stdout.toString('utf8');
}

function errorOf(error: unknown): ErrorBody {
  if (error instanceof GrimoireError) return error.toBody();
  throw error;
}

const discarded = (slug: string): Outcome<WikiEditSessionResult> => ({ ok: true, result: { slug, changed: false, discarded: true } });

/**
 * One `wiki edit <slug>`: the editor session around the core's `wiki_edit`.
 * Refused from an agent surface before any editor opens.
 */
export async function wikiEditSession(slug: string, deps: WikiEditDeps): Promise<Outcome<WikiEditSessionResult>> {
  const { core, ctx, terminal } = deps;
  try {
    checkSurface({ name: 'wiki_edit', policy: 'human-only' }, ctx);
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
  /** The page as it stands, or null when it doesn't exist yet. */
  const load = async (): Promise<Outcome<WikiShowResult | null>> => {
    const shown = await core.call('wiki_show', { slug }, ctx);
    if (shown.ok) return shown;
    return shown.error.code === 'NOT_FOUND' ? { ok: true, result: null } : shown;
  };
  let loaded = await load();
  if (!loaded.ok) return loaded;
  let page = loaded.result;
  let workspace: EditWorkspace;
  try {
    workspace = await (deps.workspace ?? editWorkspace)(ctx.repo.root);
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
  try {
    const file = path.join(workspace.dir, `${slug}.md`);
    let opening = compose(slug, page, null);
    for (;;) {
      await writeFile(file, opening);
      try {
        await deps.edit(file);
      } catch {
        terminal.say('The editor exited with an error, so your draft is discarded.');
        return discarded(slug);
      }
      const saved = await readFile(file, 'utf8');
      const original = page ?? NEW_PAGE;
      const draft = parseDraft(saved, opening.includes('\r'), original);
      if ('problem' in draft) {
        terminal.say(`Grimoire can't read the draft: ${draft.problem}.`);
        if (!(await again(terminal))) return discarded(slug);
        opening = saved;
        continue;
      }
      const sides = page?.sides ?? [];
      if (sameDraft(draft, original) && sides.length === 0) {
        terminal.say(page ? 'You changed nothing, so nothing is committed.' : 'You wrote nothing, so no page is created.');
        return page ? { ok: true, result: { slug, created: false, changed: false, base: page.base, resolved: [] } } : discarded(slug);
      }
      terminal.say(await diffOf(workspace.dir, page ? pageText(page) : '', pageText(draft)));
      const resolving = sides.length > 0 ? ` and resolve ${sides.length} set-aside side${sides.length === 1 ? '' : 's'}` : '';
      if (!(await confirmed(terminal, slug, `to commit this edit${resolving}`))) return discarded(slug);

      let base = page?.base ?? null;
      let resolves = sides.map((side) => side.id);
      for (;;) {
        const result = await core.call('wiki_edit', { slug, base, ...draft, resolves }, ctx);
        if (result.ok) return result;
        const { code, message, details } = result.error;
        if (code === 'INVALID') {
          const fields = Object.entries((details.fields ?? {}) as Record<string, string>).map(([field, problem]) => `  ${field}: ${problem}`);
          terminal.say(['The wiki can’t take this draft:', ...(fields.length > 0 ? fields : [`  ${message}`])].join('\n'));
          if (!(await again(terminal))) return discarded(slug);
          opening = saved;
          break;
        }
        if (code !== 'BASE_MOVED') return result;
        loaded = await load();
        if (!loaded.ok) return loaded;
        const current = loaded.result;
        terminal.say(`The page ${slug} changed since you opened it.`);
        const choice = await choose(terminal, '[r] redo your edit on the current text, [p] replace the page with your draft, or [d] discard it? ', { r: 'redo', p: 'replace', d: 'discard' }, 'd');
        if (choice === 'd') return discarded(slug);
        if (choice === 'r') {
          page = current;
          opening = compose(slug, page, aboveScissors(saved));
          break;
        }
        terminal.say(await diffOf(workspace.dir, current ? pageText(current) : '', pageText(draft)));
        if (!(await confirmed(terminal, slug, 'to replace the page as it stands now with your draft'))) return discarded(slug);
        base = current?.base ?? null;
        resolves = resolves.filter((id) => current?.sides.some((side) => side.id === id));
      }
    }
  } finally {
    // Best effort: the outcome stands (a commit may have landed), whatever the cleanup meets.
    await workspace.remove().catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      terminal.say(`Grimoire couldn't remove the temp copy of the page at ${workspace.dir} (${why}); delete it yourself.`);
    });
  }
}

/** The typed confirmation: the slug, exactly. */
async function confirmed(terminal: Terminal, slug: string, what: string): Promise<boolean> {
  const answer = await terminal.ask(`Type "${slug}" ${what} (anything else discards it): `);
  if (answer?.trim() === slug) return true;
  terminal.say('Discarded: nothing was committed.');
  return false;
}

/**
 * Asks until one of `choices` is answered, by its letter or its whole word
 * (`r` or `redo`); a closed prompt (Ctrl-C, Ctrl-D) answers `closed`.
 */
async function choose<C extends string>(terminal: Terminal, question: string, choices: Readonly<Record<C, string>>, closed: NoInfer<C>): Promise<C> {
  for (;;) {
    const line = await terminal.ask(question);
    if (line === null) return closed;
    const answer = line.trim().toLowerCase();
    const choice = (Object.keys(choices) as C[]).find((letter) => answer === letter || answer === choices[letter]);
    if (choice) return choice;
  }
}

async function again(terminal: Terminal): Promise<boolean> {
  return (await choose(terminal, '[e] edit the draft again, or [d] discard it? ', { e: 'edit', d: 'discard' }, 'd')) === 'e';
}

// ---------------------------------------------------------------------------
// The terminal

export interface TerminalIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Line editing, with Ctrl-C read as a key (default: when both streams are TTYs). */
  readonly terminal?: boolean;
}

/**
 * The person's terminal: text and prompts on stderr, one line read from stdin
 * per question. Each question opens its own reader and closes it on the
 * answer, so stdin is the editor's alone while it runs. Ctrl-C, or the input
 * closing (Ctrl-D), answers null rather than leaving the question pending.
 */
export function terminalOn(io: TerminalIo): Terminal {
  const tty = io.terminal ?? ((io.stdin as { isTTY?: boolean }).isTTY === true && (io.stderr as { isTTY?: boolean }).isTTY === true);
  return {
    say: (text) => void io.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
    ask: (question) =>
      new Promise((resolve) => {
        const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: tty });
        let answered = false;
        const finish = (answer: string | null) => {
          if (answered) return;
          answered = true;
          rl.close();
          resolve(answer);
        };
        rl.once('SIGINT', () => {
          io.stderr.write('\n');
          finish(null);
        });
        rl.once('close', () => finish(null));
        rl.question(question, (answer) => finish(answer));
      }),
  };
}
