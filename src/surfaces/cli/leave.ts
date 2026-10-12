// The `leave` verb (spec §21 Leave, §7 the human-only gate, §10 CLI): argv,
// the gate, the person's terminal, and the one JSON object on stdout. The
// work is the installer's (../../installer/leave.ts).
//
// The gate, before anything is read or asked: agent markers refuse it
// (HUMAN_ONLY, never naming the markers); it needs an interactive terminal
// (stdin, stdout and stderr), and it never takes --yes. The typed
// confirmation comes after the preflight's plan and offers. Prompts and the
// plan go to stderr, so stdout stays one JSON object: the report, or
// {"error": …}. Run as `npx @goksening/grimoire leave`, it runs as the
// version invoked, never the pinned one (../delegate.ts).
import path from 'node:path';
import { findHostRoot } from '../../core/host';
import { GrimoireError, type ErrorBody } from '../../errors';
import { LEAVE_CONFIRMATION, runLeave, type LeaveReport } from '../../installer/leave';
import { errorBodyOf } from '../internal';
import { UsageError } from './args';
import { cliContext } from './context';
import type { CliIo } from './run';
import { agentMarkersIn } from './shell';
import { terminalOn } from './wiki';

interface LeaveCommand {
  readonly help: boolean;
  readonly from: string | null;
}

export function parseLeaveArgs(argv: readonly string[]): LeaveCommand {
  let help = false;
  let from: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help') help = true;
    else if (arg === '--yes' || arg === '-y') throw new UsageError('leave never takes --yes: a person runs it at a terminal and types the confirmation', 'leave');
    else if (arg === '--from' || arg.startsWith('--from=')) {
      const value = arg === '--from' ? argv[++i] : arg.slice('--from='.length);
      if (value === undefined || value === '') throw new UsageError('--from needs a value', 'leave');
      from = value;
    } else throw new UsageError(`leave doesn't take ${arg}`, 'leave');
  }
  return { help, from };
}

function leaveHelp(): Record<string, unknown> {
  return {
    verb: 'leave',
    usage: 'npx @goksening/grimoire leave',
    description:
      'Removes grimoire from this clone on this machine: the generated skill copies and stubs in every registered worktree, the machine-local store with its version copies and launcher, the clone’s grimoire.* git config keys, the control channel’s files, and the local tracker ref once the remote holds its tip. It first offers to release your open attempts held here, cut uncut contexts, record stray edits and push. It never changes the host repo, its tracker branch, the remote-tracking ref or user-level client files.',
    gate: `a person runs it at an interactive terminal, with no agent marker set, and types \`${LEAVE_CONFIRMATION}\` to confirm; it never takes --yes`,
    flags: { '--from': 'a checkout of the clone to leave (default: the current directory)' },
    output: 'one JSON object: the report (what was removed, what was kept and why, warnings), or {"error": …}',
  };
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

/** The lines a person reads after leave: what stayed, and what to do next. */
function closingLines(report: LeaveReport): string[] {
  const lines: string[] = [];
  // A stop before the removal: the plan's lines said why, except for what went wrong (a process started meanwhile).
  if (!report.left) return report.problems.map((problem) => `Problem: ${problem}`);
  if (report.kept.tracker_ref) {
    lines.push(`The local tracker ref stays (${report.kept.tracker_ref.why}). Delete it once you don’t need it: ${report.kept.tracker_ref.command}`);
  }
  for (const entry of report.kept.generated) lines.push(`Left ${entry.path} in ${entry.worktree}: ${entry.why}`);
  for (const problem of report.problems) lines.push(`Problem: ${problem}`);
  lines.push(...report.warnings);
  return lines;
}

/** Runs `leave` and returns the exit code. */
export async function runLeaveVerb(argv: readonly string[], options: { io?: CliIo } = {}): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  io.stdout.on('error', () => {});
  try {
    const command = parseLeaveArgs(argv);
    if (command.help) {
      printJson(io, leaveHelp());
      return 0;
    }
    if (agentMarkersIn(io.env).length > 0) {
      throw new GrimoireError('HUMAN_ONLY', 'leave is for a person: it removes grimoire from this clone, so it never runs from an agent’s shell', {});
    }
    const tty = io.stdin.isTTY === true && io.stdout.isTTY === true && io.stderr.isTTY === true;
    if (!tty) throw new GrimoireError('HUMAN_ONLY', 'leave runs only at an interactive terminal, where you type the confirmation; nothing changed', {});
    const start = command.from === null ? io.cwd : path.resolve(io.cwd, command.from);
    const root = await findHostRoot(start);
    const ctx = await cliContext({ cwd: root, env: io.env, tty });
    const terminal = terminalOn(io);
    const report = await runLeave({
      root,
      ctx,
      prompter: { ask: (question) => terminal.ask(question) },
      say: (text) => terminal.say(text),
      env: io.env,
    });
    for (const line of closingLines(report)) terminal.say(line);
    io.stdin.pause();
    printJson(io, report);
    return 0;
  } catch (error) {
    io.stdin.pause();
    if (error instanceof UsageError) {
      printJson(io, { usage_error: { message: error.message, help: 'grimoire leave --help' } });
      io.stderr.write(`grimoire: ${error.message} (see grimoire leave --help)\n`);
      return 2;
    }
    const body: ErrorBody = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    printJson(io, { error: body });
    return 1;
  }
}
