// The `init` verb (spec §10 Runtime, §12 step 1): argv, the gate, the person's
// terminal, and the one JSON object on stdout. The work is the installer's
// (../../installer/init.ts).
//
// The gate: agent markers refuse it (HUMAN_ONLY); without an interactive
// terminal it needs --yes; --new-tracker is interactive only, never with --yes.
// `--json` alone is the plan only: it asks nothing and writes nothing, so it
// needs no terminal; `--json --yes` runs it with only the JSON report.
// Prompts and the human-readable plan go to stderr (none under --json), so
// stdout stays one JSON object: the report, or {"error": …}.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { findHostRoot, readPerson } from '../../core/host';
import { EXCERPT_MODES, isExcerptMode } from '../../core/settings';
import { GrimoireError, type ErrorBody } from '../../errors';
import { runInit, type InitFlags } from '../../installer/init';
import { CLIENTS, type ClientName } from '../../installer/manifest';
import { runningPackage } from '../../installer/source';
import { VERSION } from '../../version';
import { errorBodyOf } from '../internal';
import { UsageError } from './args';
import type { CliIo } from './run';
import { agentMarkersIn } from './shell';
import { terminalOn } from './wiki';

const BOOLEAN_FLAGS = new Set(['--yes', '--json', '--new-tracker', '--adapter', '--upgrade', '--help']);
const VALUE_FLAGS = new Set(['--clients', '--excerpts', '--from']);

interface InitCommand {
  readonly flags: InitFlags;
  readonly json: boolean;
  readonly help: boolean;
  readonly from: string | null;
}

function parseClients(value: string): ClientName[] {
  const names = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const aliases: Record<string, ClientName> = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex' };
  const clients = names.map((name) => aliases[name.toLowerCase()]);
  if (names.length === 0 || clients.some((client) => client === undefined)) {
    throw new UsageError(`--clients takes a comma-separated list of ${CLIENTS.join(', ')}`, 'init');
  }
  return [...new Set(clients as ClientName[])];
}

export function parseInitArgs(argv: readonly string[]): InitCommand {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOLEAN_FLAGS.has(name) && name === arg) booleans.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const value = name === arg ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new UsageError(`${name} needs a value`, 'init');
      values.set(name, value);
    } else throw new UsageError(`init doesn't take ${arg}`, 'init');
  }
  const excerpts = values.get('--excerpts') ?? null;
  if (excerpts !== null && !isExcerptMode(excerpts)) throw new UsageError(`--excerpts takes one of ${EXCERPT_MODES.join(', ')}`, 'init');
  const flags: InitFlags = {
    yes: booleans.has('--yes'),
    clients: values.has('--clients') ? parseClients(values.get('--clients')!) : null,
    excerpts: excerpts as InitFlags['excerpts'],
    newTracker: booleans.has('--new-tracker'),
    adapter: booleans.has('--adapter'),
    upgrade: booleans.has('--upgrade'),
  };
  if (flags.newTracker && flags.upgrade) throw new UsageError('init --upgrade moves the pin and never mints a tracker: run --new-tracker on its own', 'init');
  if (flags.newTracker && flags.yes) throw new UsageError('init --new-tracker is interactive only: it never runs with --yes', 'init');
  return { flags, json: booleans.has('--json'), help: booleans.has('--help'), from: values.get('--from') ?? null };
}

function initHelp(): Record<string, unknown> {
  return {
    verb: 'init',
    usage: 'npx @goksening/grimoire@<version> init [--yes] [--upgrade] [--clients claude-code,codex] [--excerpts excerpts|facts|none] [--new-tracker] [--adapter] [--json]',
    description:
      'Installs grimoire into this host repo, or joins this clone to the version its checkout pins: the tracker, this machine’s version copy and launcher, and the pointer files agent clients read. Shows the plan, the grants and the excerpt disclosure, then asks once.',
    gate: 'a person runs it with no agent marker set; without an interactive terminal it needs --yes (safe defaults: excerpt mode facts, adapter declined, changed permission entries never restored); --new-tracker is interactive and asks for a typed confirmation',
    flags: {
      '--yes': 'take the safe defaults and ask nothing',
      '--clients': 'configure only these agent clients (default: Claude Code and Codex)',
      '--excerpts': 'the excerpt mode a new tracker starts with (asked otherwise; facts under --yes)',
      '--new-tracker': 'mint a new tracker root instead of adopting the one this repo has',
      '--upgrade': 'move this checkout to <version> (an upgrade or a downgrade): writes only this worktree’s files, never commits, and is finished by running it again; --yes never raises compat',
      '--adapter': 'ask again about making grimoire the tracker in docs/agents/issue-tracker.md after a decline',
      '--json': 'alone: print the plan as JSON and write nothing (no terminal needed); with --yes: run, printing only the JSON report',
    },
    output: 'one JSON object: the report (plan, what was written, next steps), or {"error": …}',
  };
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

/** Runs `init` and returns the exit code. */
export async function runInitVerb(argv: readonly string[], options: { bin: string; io?: CliIo }): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  io.stdout.on('error', () => {});
  const fail = (body: ErrorBody) => {
    printJson(io, { error: body });
    return 1;
  };
  try {
    const command = parseInitArgs(argv);
    if (command.help) {
      printJson(io, initHelp());
      return 0;
    }
    // The gate, before anything is read or asked.
    if (agentMarkersIn(io.env).length > 0) {
      throw new GrimoireError('HUMAN_ONLY', 'init is for a person: it grants agent clients their permissions, so it never runs from an agent’s shell', {});
    }
    const interactive = io.stdin.isTTY === true && io.stderr.isTTY === true;
    const dryRun = command.json && !command.flags.yes;
    if (command.flags.newTracker && (!interactive || dryRun)) {
      throw new GrimoireError('HUMAN_ONLY', 'init --new-tracker runs only at an interactive terminal, with a typed confirmation', {});
    }
    if (!interactive && !command.flags.yes && !dryRun) {
      throw new GrimoireError('HUMAN_ONLY', 'init needs an interactive terminal to ask before it writes; without one, run it with --yes to take the safe defaults', {});
    }
    const root = await findHostRoot(command.from === null ? io.cwd : path.resolve(io.cwd, command.from));
    const terminal = terminalOn(io);
    const prompter = command.flags.yes || dryRun ? null : { ask: (question: string) => terminal.ask(question) };
    const report = await runInit({
      root,
      flags: command.flags,
      source: await runningPackage(options.bin),
      version: VERSION,
      person: await readPerson(root),
      nonce: randomBytes(8).toString('hex'),
      prompter,
      say: command.json ? () => {} : (text) => terminal.say(text),
      dryRun,
    });
    // A paused terminal stream keeps no handle open, so the process can exit.
    io.stdin.pause();
    printJson(io, report);
    return report.error ? 1 : 0;
  } catch (error) {
    io.stdin.pause();
    if (error instanceof UsageError) {
      printJson(io, { usage_error: { message: error.message, help: 'grimoire init --help' } });
      io.stderr.write(`grimoire: ${error.message} (see grimoire init --help)\n`);
      return 2;
    }
    return fail(errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`)));
  }
}
