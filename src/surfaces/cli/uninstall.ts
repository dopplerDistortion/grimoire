// The `uninstall` verb (spec §21 Uninstall, §7 the human-only gate, §10 CLI):
// argv, the gate, the person's terminal, and the one JSON object on stdout.
// The work is the installer's (../../installer/uninstall.ts).
//
// The gate, before anything is read or asked: agent markers refuse it
// (HUMAN_ONLY, never naming the markers); it needs an interactive terminal
// (stdin, stdout and stderr), and it never takes --yes. The typed
// confirmation comes after the preflight's plan and offers. Prompts and the
// plan go to stderr, so stdout stays one JSON object: the report, or
// {"error": …}. It always runs as the version invoked, never the pinned one
// (../delegate.ts): removal reads only frozen lists.
import path from 'node:path';
import { findHostRoot } from '../../core/host';
import { GrimoireError, type ErrorBody } from '../../errors';
import { keptLine, runUninstall, UNINSTALL_CONFIRMATION, type UninstallReport } from '../../installer/uninstall';
import { errorBodyOf } from '../internal';
import { UsageError } from './args';
import { cliContext } from './context';
import type { CliIo } from './run';
import { agentMarkersIn } from './shell';
import { terminalOn } from './wiki';

interface UninstallCommand {
  readonly help: boolean;
  readonly from: string | null;
}

export function parseUninstallArgs(argv: readonly string[]): UninstallCommand {
  let help = false;
  let from: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help') help = true;
    else if (arg === '--yes' || arg === '-y') throw new UsageError('uninstall never takes --yes: a person runs it at a terminal and types the confirmation', 'uninstall');
    else if (arg === '--from' || arg.startsWith('--from=')) {
      const value = arg === '--from' ? argv[++i] : arg.slice('--from='.length);
      if (value === undefined || value === '') throw new UsageError('--from needs a value', 'uninstall');
      from = value;
    } else throw new UsageError(`uninstall doesn't take ${arg}`, 'uninstall');
  }
  return { help, from };
}

function uninstallHelp(): Record<string, unknown> {
  return {
    verb: 'uninstall',
    usage: 'npx @goksening/grimoire uninstall',
    description:
      'Removes grimoire from this repo through this checkout, for you to commit: exactly what .grimoire/manifest.yml says grimoire wrote (its own files, its entries in shared files such as AGENTS.md, .claude/settings.json and .codex/config.toml), then .grimoire/. Entries are removed even if edited; files you changed in ways git doesn’t have, a changed npm script or seed, and anything the manifest doesn’t record stay, reported. It first offers to eject evolved skills and to purge or push unpushed tracker commits. When no other worktree of this clone is still installed, it also leaves the clone (see grimoire leave --help). It never deletes the remote tracker: it prints the commands that delete it or keep it under a tag.',
    gate: `a person runs it at an interactive terminal, with no agent marker set and no git operation in progress, and types \`${UNINSTALL_CONFIRMATION}\` to confirm; it never takes --yes`,
    flags: { '--from': 'a directory in the checkout to uninstall from (default: the current directory)' },
    output: 'one JSON object: the report (what was removed, what was kept and why, the commit to make, the tracker commands), or {"error": …}',
  };
}

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

/** The lines a person reads after uninstall: what stayed, what to commit, and what to do next. */
function closingLines(report: UninstallReport): string[] {
  const lines: string[] = [];
  for (const item of report.checkout?.kept ?? []) lines.push(keptLine(item));
  if (report.leave?.kept.tracker_ref) {
    lines.push(`The local tracker ref stays (${report.leave.kept.tracker_ref.why}). Delete it once you don’t need it: ${report.leave.kept.tracker_ref.command}`);
  }
  for (const problem of report.problems) lines.push(`Problem: ${problem}`);
  if (report.stopped === 'checkout') lines.push('The removal stopped part way: fix what the problems name, then run grimoire uninstall again to finish it.');
  if (report.commit && report.commit.paths.length > 0) {
    lines.push(`Commit the removal: ${report.commit.command}`);
    lines.push('Its message and PR text (in the report) tell teammates to run `npx @goksening/grimoire leave`.');
  }
  if (report.codex.notice) lines.push(report.codex.notice);
  if (report.tracker.delete) {
    lines.push(`The remote tracker stays as an archive (a later install adopts it). To delete it: ${report.tracker.delete}`);
    lines.push(`Or keep it under a tag instead: ${report.tracker.archive}`);
  }
  lines.push(...report.warnings, ...(report.leave?.warnings ?? []));
  return lines;
}

/** Runs `uninstall` and returns the exit code. */
export async function runUninstallVerb(argv: readonly string[], options: { io?: CliIo } = {}): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  io.stdout.on('error', () => {});
  try {
    const command = parseUninstallArgs(argv);
    if (command.help) {
      printJson(io, uninstallHelp());
      return 0;
    }
    if (agentMarkersIn(io.env).length > 0) {
      throw new GrimoireError('HUMAN_ONLY', 'uninstall is for a person: it removes grimoire from this repo, so it never runs from an agent’s shell', {});
    }
    const tty = io.stdin.isTTY === true && io.stdout.isTTY === true && io.stderr.isTTY === true;
    if (!tty) throw new GrimoireError('HUMAN_ONLY', 'uninstall runs only at an interactive terminal, where you type the confirmation; nothing changed', {});
    const start = command.from === null ? io.cwd : path.resolve(io.cwd, command.from);
    const root = await findHostRoot(start);
    const ctx = await cliContext({ cwd: root, env: io.env, tty });
    const terminal = terminalOn(io);
    const report = await runUninstall({
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
      printJson(io, { usage_error: { message: error.message, help: 'grimoire uninstall --help' } });
      io.stderr.write(`grimoire: ${error.message} (see grimoire uninstall --help)\n`);
      return 2;
    }
    const body: ErrorBody = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    printJson(io, { error: body });
    return 1;
  }
}
