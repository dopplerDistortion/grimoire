// The `grimoire` CLI's verbs (spec §10): every core op, with exactly the core's
// JSON shapes. The agents' fallback channel when no MCP tools are listed, and
// the humans' terminal surface. Thin: argv and stdin in, one JSON object out,
// the exit code, and the gating a terminal adds (the human-only gate's typed
// confirmation, NOT_WRITABLE before any effect). `skill edit` and `wiki edit`
// run their editor sessions (./skill-edit.ts, ./wiki.ts) instead of calling
// the core once.
//
// Exit codes: 0 success; 1 stdout carries an `error` object; 2 usage error.
// 3 (grimoire isn't set up on this machine for the pin) never comes from here:
// the launcher, the shell shim or the bin's delegation (../delegate.ts) says
// it before any of this loads.
import path from 'node:path';
import { createCore, runBackgroundSync, spawnedAutoSync, type CallContext, type Core, type Outcome } from '../../core';
import { humanSurface } from '../../core/context';
import { checkSurface } from '../../core/op';
import { GrimoireError, type ErrorBody } from '../../errors';
import { errorBodyOf } from '../internal';
import { EDITOR_VERBS, globalHelp, mergeInput, parseCommand, UsageError, verbHelp, type Command } from './args';
import { cliContext } from './context';
import { openGitEditor } from './editor';
import { confirmationFor, confirmTyped, mayConfirm } from './gate';
import { inCodexShell } from './shell';
import { skillEditFlow } from './skill-edit';
import { terminalOn, wikiEditSession } from './wiki';
import { checkWritable, refusedWrite, withCodexHint } from './writable';

export interface CliIo {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface CliOptions {
  /** The path of the running `grimoire.mjs`: the detached sync child runs it. */
  readonly bin: string;
  readonly io?: CliIo;
  /**
   * Where the host repo search starts when the command names no `--from`
   * (default: the cwd). Through the shell shim it is the shim's own checkout.
   */
  readonly startDir?: string;
}

/** stdout: one JSON object, indented for a person's terminal. */
function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** The op's input: the JSON object on stdin (with `--input -`) plus the command line's fields. */
async function inputOf(command: Command, io: CliIo): Promise<Record<string, unknown>> {
  if (!command.stdinInput) return mergeInput(command, undefined);
  if (io.stdin.isTTY && mayConfirm(command.op)) {
    throw new UsageError(
      `${command.verb} asks for a typed confirmation at this terminal, so its input can't come from stdin here; give its fields as arguments and flags (JSON on the flag of a field that isn't a plain value)`,
      command.verb,
    );
  }
  // Windows tools (PowerShell 5.1's UTF-8, files it saved) lead with a byte order mark.
  const text = (await readStdin(io.stdin)).replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('stdin must hold one JSON object (the op’s input); it isn’t valid JSON', command.verb);
  }
  return mergeInput(command, parsed);
}

/** The call context of a CLI call (spec §7): the host repo from the start directory, the person, and what the shell shows. */
function contextOf(command: Command, io: CliIo, startDir: string | undefined): Promise<CallContext> {
  return cliContext({
    cwd: command.from === null ? (startDir ?? io.cwd) : path.resolve(io.cwd, command.from),
    env: io.env,
    tty: io.stdin.isTTY === true && io.stdout.isTTY === true,
  });
}

interface SessionDeps {
  readonly core: Core;
  readonly ctx: CallContext;
  readonly io: CliIo;
}

/** A prompt the person closed (Ctrl-C, Ctrl-D), the way node:readline reports it: the skill edit session discards. */
function closedPrompt(): Error {
  return Object.assign(new Error('the prompt was closed'), { name: 'AbortError' });
}

/**
 * The editor sessions of the human-only edit verbs: each opens the person's
 * git editor, shows the diff, takes its own typed confirmation and calls the
 * core itself.
 */
const SESSIONS: Readonly<Record<string, (subject: string, deps: SessionDeps) => Promise<Outcome<unknown>>>> = {
  skill_edit: (name, { core, ctx, io }) => {
    const terminal = terminalOn(io);
    return skillEditFlow(name, {
      core,
      ctx,
      io: {
        edit: (file) => openGitEditor(file, ctx.repo.root, io.env),
        ask: async (question) => {
          const answer = await terminal.ask(question);
          if (answer === null) throw closedPrompt();
          return answer;
        },
        say: (text) => terminal.say(text),
      },
    });
  },
  wiki_edit: (slug, { core, ctx, io }) =>
    wikiEditSession(slug, { core, ctx, terminal: terminalOn(io), edit: (file) => openGitEditor(file, ctx.repo.root, io.env) }),
};

/** Runs one op call: the gate, the writable check, then the core. Returns what stdout prints. */
async function call(command: Command, input: Record<string, unknown>, ctx: CallContext, core: Core, io: CliIo): Promise<
  { ok: true; result: unknown } | { ok: false; error: ErrorBody }
> {
  const { op } = command;
  // HUMAN_ONLY (agent markers, no terminal) before anything is asked or probed.
  checkSurface(op, ctx);
  const session = SESSIONS[op.name];
  if (humanSurface(ctx) && !session) {
    const asked = await confirmationFor(op, command.verb, input, ctx, core);
    const shown: { subject: string | null; notice?: string; input?: Record<string, unknown> } =
      typeof asked === 'string' || asked === null ? { subject: asked } : asked;
    const subject = shown.subject;
    // What the person is shown before typing, on stderr (stdout stays one JSON object).
    if (shown.notice !== undefined) io.stderr.write(`${shown.notice}\n`);
    Object.assign(input, shown.input ?? {});
    if (subject !== null && !(await confirmTyped(io, command.verb, subject))) {
      throw new GrimoireError('INVALID', `${command.verb} was not confirmed: type ${subject} exactly to run it; nothing changed`, {
        fields: { confirmation: `must be ${subject}` },
      });
    }
  }
  if (op.kind !== 'write') return core.call(op.name, input, ctx);
  // Before any effect, and before the person writes a draft in their editor.
  await checkWritable(ctx.repo.root);
  try {
    return await (session ? session(String(input[EDITOR_VERBS[op.name]!]), { core, ctx, io }) : core.call(op.name, input, ctx));
  } catch (error) {
    // The probe passed, but a write below the probed directories was refused
    // all the same: the tracker's compare-and-set publishes last and
    // machine-local records are written whole (temp file, rename), so
    // nothing changed.
    if (!refusedWrite(error)) throw error;
    throw new GrimoireError('NOT_WRITABLE', `this process can't write grimoire's live store (${(error as NodeJS.ErrnoException).code})`, {});
  }
}

/** Prints the error object (a refused write in a Codex shell says why, spike F); exit 1. */
function failed(io: CliIo, body: ErrorBody, command: Command | null): number {
  const refused = body.code === 'NOT_WRITABLE' && command !== null && inCodexShell(io.env);
  const error = refused ? withCodexHint(body, command.op, command.verb) : body;
  printJson(io, { error });
  return 1;
}

function usage(io: CliIo, error: UsageError): number {
  const hint = error.verb ? `grimoire ${error.verb} --help` : 'grimoire --help';
  printJson(io, { usage_error: { message: error.message, help: hint } });
  io.stderr.write(`grimoire: ${error.message} (see ${hint})\n`);
  return 2;
}

/** Runs the verb `argv` names and returns the exit code. */
export async function runCli(argv: readonly string[], options: CliOptions): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  // A reader that stops early (`| head`) is no failure of the call.
  io.stdout.on('error', () => {});
  // A short-lived process can't sync after it answers: an attempt-ending write
  // spawns the detached sync child, after setting the sync-pending marker
  // that covers a child that dies (spec §4; spikes A, E, F).
  const core = createCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: [options.bin, 'sync', '--background'] }) });
  let command: Command | null = null;
  try {
    const parsed = parseCommand(argv, core.ops);
    if (parsed.kind === 'help') {
      printJson(io, parsed.op ? verbHelp(parsed.op) : globalHelp(core.ops));
      return 0;
    }
    command = parsed;
    const input = await inputOf(parsed, io);
    const ctx = await contextOf(parsed, io, options.startDir);
    if (parsed.background) {
      printJson(io, await runBackgroundSync(ctx));
      return 0;
    }
    const outcome = await call(parsed, input, ctx, core, io);
    if (outcome.ok) {
      printJson(io, outcome.result);
      return 0;
    }
    return failed(io, outcome.error, command);
  } catch (error) {
    if (error instanceof UsageError) return usage(io, error);
    const body = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    return failed(io, body, command);
  } finally {
    // Waits for the spawn of the sync child, then lets go of git processes.
    await core.close();
  }
}
