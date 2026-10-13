// The `status` and `doctor` verbs (spec §10 Runtime, §12): argv, the one JSON
// object on stdout, and the human-readable report on stderr (none under
// `--json`). No gate: agents and people run both; `doctor --fix` makes only
// single-answer repairs. The work is the installer's (../../installer/status.ts,
// ../../installer/doctor.ts).
import path from 'node:path';
import { findHostRoot } from '../../core/host';
import type { ErrorBody } from '../../errors';
import { doctorText, runDoctor } from '../../installer/doctor';
import { readStatus } from '../../installer/status';
import { errorBodyOf } from '../internal';
import { UsageError } from './args';
import type { CliIo } from './run';

interface HealthCommand {
  readonly json: boolean;
  readonly fix: boolean;
  readonly readers: boolean;
  readonly help: boolean;
  readonly from: string | null;
}

const FLAGS: Readonly<Record<'status' | 'doctor', readonly string[]>> = {
  status: ['--json', '--help'],
  doctor: ['--json', '--fix', '--readers', '--help'],
};

function parse(verb: 'status' | 'doctor', argv: readonly string[]): HealthCommand {
  let from: string | null = null;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--from' || arg.startsWith('--from=')) {
      const value = arg === '--from' ? argv[++i] : arg.slice('--from='.length);
      if (!value) throw new UsageError('--from needs a value', verb);
      from = value;
    } else if (FLAGS[verb].includes(arg)) flags.add(arg);
    else throw new UsageError(`${verb} doesn't take ${arg}`, verb);
  }
  return { json: flags.has('--json'), fix: flags.has('--fix'), readers: flags.has('--readers'), help: flags.has('--help'), from };
}

const HELP: Readonly<Record<'status' | 'doctor', Record<string, unknown>>> = {
  status: {
    verb: 'status',
    usage: 'grimoire status [--json] [--from <dir>]',
    description:
      'What to know about this checkout now: sync state (with the failure class and the client that hit it), content pointer files upkeep refreshed (commit them), the Node and PATH source each client used, stale claims, an excerpt mode changed since this machine joined, and whether Codex runs grimoire’s hook. Writes nothing.',
    gate: 'none',
    flags: { '--json': 'only the JSON object, no human-readable report on stderr', '--from': 'the directory the host repo search starts from' },
    output: 'one JSON object: every fact by its key, or {"error": …}; the human-readable report goes to stderr',
  },
  doctor: {
    verb: 'doctor',
    usage: 'grimoire doctor [--fix] [--readers] [--json] [--from <dir>]',
    description:
      'A report on the store (records, ids, relations, conflicts, write-once files, purges, ref locks, sync, foreign commits, ref names) and the install (the pinned copy, the launcher, the shim, Node, pointer drift, hooks, .gitattributes, AGENTS.md, client config conflicts, stale locks, running servers, tracker docs, the Codex hook) and capture statistics (late-cut drops, unreadable and unmatched cuts; no transcript is opened). Reads only, unless --fix.',
    gate: 'none',
    flags: {
      '--fix': 'make the single-answer repairs only: content pointer files and stale locks; then report what is left',
      '--readers': 'also read this machine’s transcripts whose cwd is inside this repo and print the readers’ structure statistics only (lines, steps, versions; no text); skipped in none mode',
      '--json': 'only the JSON object, no human-readable report on stderr',
      '--from': 'the directory the host repo search starts from',
    },
    output: 'one JSON object: {version, root, pin, ok, counts, findings, checks, fix?}, or {"error": …}; the human-readable report goes to stderr',
  },
};

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

/**
 * Runs `status` or `doctor` and returns the exit code. The host repo search
 * starts at the command's `--from`, else at `startDir` (the shim's checkout),
 * else at the cwd.
 */
export async function runHealthVerb(verb: 'status' | 'doctor', argv: readonly string[], options: { io?: CliIo; startDir?: string } = {}): Promise<number> {
  const io: CliIo = options.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
  io.stdout.on('error', () => {});
  try {
    const command = parse(verb, argv);
    if (command.help) {
      printJson(io, HELP[verb]);
      return 0;
    }
    const root = await findHostRoot(path.resolve(io.cwd, command.from ?? options.startDir ?? '.'));
    if (verb === 'status') {
      const { report, lines } = await readStatus({ root, env: io.env });
      printJson(io, report);
      if (!command.json) io.stderr.write(`${lines.join('\n')}\n`);
      return 0;
    }
    const report = await runDoctor({ root, env: io.env, fix: command.fix, readers: command.readers });
    printJson(io, report);
    if (!command.json) io.stderr.write(`${doctorText(report).join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      printJson(io, { usage_error: { message: error.message, help: `grimoire ${verb} --help` } });
      io.stderr.write(`grimoire: ${error.message} (see grimoire ${verb} --help)\n`);
      return 2;
    }
    const body: ErrorBody = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    printJson(io, { error: body });
    return 1;
  }
}
