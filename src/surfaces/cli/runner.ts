// The runner's verbs (spec §10 Runtime, §16 The runner): `runner enable
// claude|codex [--allow-api-billing]`, `runner disable`, and the triggers
// `chore run --due` (for OS schedulers) and `chore run <kind>`. Thin: argv,
// the gate, the person's terminal, and one JSON object on stdout; the work is
// the runner module's (../../runner).
//
// The gate: `runner enable` and `runner disable` are human-only (no agent
// marker, an interactive terminal, a typed confirmation); `chore run` refuses
// agent markers but needs no terminal, so a scheduler can run it. Prompts and
// warnings go to stderr.
import path from 'node:path';
import { createCore, spawnedAutoSync } from '../../core';
import { findHostRoot } from '../../core/host';
import { GrimoireError, type ErrorBody } from '../../errors';
import { disableRunner, enableRunner, enableWarnings, isRunnerKind, readRunnerConfig, runChores, RUNNER_KINDS, storeAt, type RunnerKind } from '../../runner';
import { CHORE_KINDS, type ChoreKind } from '../../tracker';
import { errorBodyOf } from '../internal';
import { UsageError } from './args';
import type { CliIo } from './run';
import { agentMarkersIn } from './shell';
import { terminalOn } from './wiki';

type Verb = 'runner enable' | 'runner disable' | 'chore run';

interface RunnerCommand {
  readonly verb: Verb;
  readonly help: boolean;
  readonly from: string | null;
  readonly kind: RunnerKind | null;
  readonly allowApiBilling: boolean;
  readonly model: string | null;
  readonly binary: string | null;
  readonly due: boolean;
  readonly chore: ChoreKind | null;
}

const HELP: Readonly<Record<Verb, Record<string, unknown>>> = {
  'runner enable': {
    verb: 'runner enable',
    usage: 'grimoire runner enable claude|codex [--allow-api-billing] [--model <model>] [--binary <path>] [--from <dir>]',
    description:
      'Lets grimoire start your own `claude -p` or `codex exec` to do due knowledge chores unattended, on your login, on this machine. Prints the warnings, runs the preflight (the billing guard), then stores the machine-local config.',
    gate: 'human-only: a person runs it at an interactive terminal, with no agent marker set, and types the client’s name (claude or codex) to confirm',
    flags: {
      '--allow-api-billing': 'let runs bill an API key, a token or a cloud provider instead of your plan (otherwise those are refused)',
      '--model': 'the model each run asks for (default: the client’s own)',
      '--binary': 'the client’s platform binary (the .exe on Windows); default: found on PATH',
      '--from': 'the directory the host repo search starts from',
    },
    output: 'one JSON object: {runner, warnings, mcp_servers?}, or {"error": …}',
  },
  'runner disable': {
    verb: 'runner disable',
    usage: 'grimoire runner disable [--from <dir>]',
    description: 'Turns the runner off on this machine.',
    gate: 'human-only: a person runs it at an interactive terminal, with no agent marker set, and types the client’s name to confirm',
    flags: { '--from': 'the directory the host repo search starts from' },
    output: 'one JSON object: {disabled, was}, or {"error": …}',
  },
  'chore run': {
    verb: 'chore run',
    usage: 'grimoire chore run --due | grimoire chore run wiki-maintainer|skill-proposer [--from <dir>]',
    description:
      'Runs knowledge chores with this machine’s runner: --due runs each due chore in turn (for OS schedulers; nothing due is no error), a kind runs that chore now, thresholds waived. At most 6 runs a day, and a 6 h pause after 2 failed runs in a row. Without a runner, ask an agent to run the grimoire-chores skill.',
    gate: 'refuses agent markers; needs no terminal',
    flags: { '--due': 'run whatever is due', '--from': 'the directory the host repo search starts from' },
    output: 'one JSON object: {runner, runs, summary, caps, why?}, or {"error": …}',
  },
};

function parse(argv: readonly string[]): RunnerCommand {
  const verb: Verb | null = argv[0] === 'runner' && (argv[1] === 'enable' || argv[1] === 'disable') ? (`runner ${argv[1]}` as Verb) : argv[0] === 'chore' && argv[1] === 'run' ? 'chore run' : null;
  if (verb === null) throw new UsageError(`${argv.slice(0, 2).join(' ')} isn't a runner verb: use runner enable, runner disable or chore run`, argv[0] === 'runner' ? 'runner enable' : 'chore run');
  let help = false;
  let from: string | null = null;
  let allowApiBilling = false;
  let model: string | null = null;
  let binary: string | null = null;
  let due = false;
  const positional: string[] = [];
  const rest = argv.slice(2);
  const value = (flag: string, i: number): string => {
    const found = rest[i];
    if (found === undefined || found === '') throw new UsageError(`${flag} needs a value`, verb);
    return found;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const takeValue = () => (inline !== undefined ? inline : value(flag, ++i));
    if (flag === '--help' && inline === undefined) help = true;
    else if (flag === '--from') from = takeValue();
    else if (flag === '--allow-api-billing' && inline === undefined && verb === 'runner enable') allowApiBilling = true;
    else if (flag === '--model' && verb === 'runner enable') model = takeValue();
    else if (flag === '--binary' && verb === 'runner enable') binary = takeValue();
    else if (flag === '--due' && inline === undefined && verb === 'chore run') due = true;
    else if (!arg.startsWith('-')) positional.push(arg);
    else throw new UsageError(`${verb} doesn't take ${arg}`, verb);
  }
  let kind: RunnerKind | null = null;
  let chore: ChoreKind | null = null;
  if (!help) {
    if (verb === 'runner enable') {
      if (positional.length !== 1 || !isRunnerKind(positional[0])) throw new UsageError(`runner enable takes one of ${RUNNER_KINDS.join(', ')}`, verb);
      kind = positional[0];
    } else if (verb === 'runner disable') {
      if (positional.length > 0) throw new UsageError(`runner disable doesn't take ${positional[0]}`, verb);
    } else {
      const named = positional[0];
      if (positional.length > 1 || (due && named !== undefined) || (!due && named === undefined)) {
        throw new UsageError(`chore run takes --due, or one chore: ${CHORE_KINDS.join(', ')}`, verb);
      }
      if (named !== undefined) {
        if (!(CHORE_KINDS as readonly string[]).includes(named)) throw new UsageError(`chore run takes one of ${CHORE_KINDS.join(', ')}, or --due`, verb);
        chore = named as ChoreKind;
      }
    }
  }
  return { verb, help, from, kind, allowApiBilling, model, binary, due, chore };
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

/** HUMAN_ONLY under agent markers (never naming them), and for a human-only verb without a terminal. */
function gate(command: RunnerCommand, io: CliIo): void {
  const marked = agentMarkersIn(io.env).length > 0;
  if (command.verb === 'chore run') {
    if (marked) throw new GrimoireError('HUMAN_ONLY', 'chore run is for a person or their OS scheduler: an agent runs chores with the grimoire-chores skill instead');
    return;
  }
  const tty = io.stdin.isTTY === true && io.stdout.isTTY === true;
  if (marked || !tty) {
    throw new GrimoireError('HUMAN_ONLY', `${command.verb} is a human-only operation: a person runs it from their own terminal`);
  }
}

async function confirm(io: CliIo, verb: string, subject: string): Promise<boolean> {
  const answer = await terminalOn(io).ask(`grimoire ${verb} is a human-only operation. Type ${subject} to confirm (anything else cancels): `);
  return answer !== null && answer.trim() === subject;
}

function notConfirmed(verb: string, subject: string): GrimoireError {
  return new GrimoireError('INVALID', `${verb} was not confirmed: type ${subject} exactly to run it; nothing changed`, { fields: { confirmation: `must be ${subject}` } });
}

async function enable(command: RunnerCommand & { kind: RunnerKind }, root: string, io: CliIo): Promise<unknown> {
  const terminal = terminalOn(io);
  terminal.say(enableWarnings(command.kind).map((line) => `grimoire: ${line}`).join('\n'));
  return enableRunner({
    root,
    kind: command.kind,
    allowApiBilling: command.allowApiBilling,
    model: command.model,
    ...(command.binary !== null ? { binary: path.resolve(io.cwd, command.binary) } : {}),
    env: io.env,
    allowBilling: async (why) => {
      terminal.say(`grimoire: ${why}`);
      const answer = await terminal.ask('Allow runs to bill outside your plan? Type allow to allow it (anything else refuses): ');
      return answer !== null && answer.trim() === 'allow';
    },
    confirm: () => confirm(io, command.verb, command.kind),
  });
}

async function disable(root: string, io: CliIo): Promise<unknown> {
  const current = await readRunnerConfig(await storeAt(root));
  if (current === null) return { disabled: false, was: null };
  if (!(await confirm(io, 'runner disable', current.kind))) throw notConfirmed('runner disable', current.kind);
  return disableRunner(root);
}

/** Runs a runner verb (`argv` starts with `runner` or `chore run`) and returns the exit code. */
export async function runRunnerVerb(argv: readonly string[], options: { bin: string; io?: CliIo; startDir?: string }): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  io.stdout.on('error', () => {});
  let verb: Verb = argv[0] === 'runner' ? 'runner enable' : 'chore run';
  try {
    const command = parse(argv);
    verb = command.verb;
    if (command.help) {
      printJson(io, HELP[command.verb]);
      return 0;
    }
    gate(command, io);
    const root = await findHostRoot(path.resolve(io.cwd, command.from ?? options.startDir ?? '.'));
    if (command.verb === 'runner enable') {
      printJson(io, await enable(command as RunnerCommand & { kind: RunnerKind }, root, io));
      return 0;
    }
    if (command.verb === 'runner disable') {
      printJson(io, await disable(root, io));
      return 0;
    }
    // The chore-submit sync runs as the detached sync child, as for any CLI write (spec §4).
    const core = createCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: [options.bin, 'sync', '--background'] }) });
    try {
      const report = await runChores({ root, core, env: io.env, ...(command.due ? { due: true } : { kind: command.chore! }) });
      printJson(io, report);
      io.stderr.write(`${report.summary}\n`);
      return 0;
    } finally {
      await core.close();
    }
  } catch (error) {
    if (error instanceof UsageError) {
      const help = `grimoire ${error.verb ?? verb} --help`;
      printJson(io, { usage_error: { message: error.message, help } });
      io.stderr.write(`grimoire: ${error.message} (see ${help})\n`);
      return 2;
    }
    const body: ErrorBody = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    printJson(io, { error: body });
    return 1;
  }
}
