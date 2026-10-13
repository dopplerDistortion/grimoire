// The verbs every way into grimoire runs (spec §10): `--version`, `mcp`,
// `hook <event>` and the CLI's verbs. Shared by the `grimoire` bin
// (./cli/main.ts) and a version copy's launcher entry (./launch.ts). Each
// verb's code is a dynamic import, so it loads only for that verb.
import { VERSION } from '../version';
import { hookFailed } from './hooks/debug';
import { lateWork } from './hooks/late';

export interface EntryOptions {
  /** The path of `grimoire.mjs`: the detached sync child runs it. */
  readonly bin: string;
  /** Where the CLI's host repo search starts when the command names no `--from` (default: the cwd). */
  readonly startDir?: string;
}

/**
 * Runs the verb `argv` names. A leading `--from <dir>` (the hook entries')
 * names where the host repo search starts. Returns the exit code, or null for
 * `mcp`, which runs until the client closes stdin.
 */
export async function runEntry(argv: readonly string[], options: EntryOptions): Promise<number | null> {
  const from = argv[0] === '--from' ? argv[1] : undefined;
  const rest = from === undefined ? argv : argv.slice(2);
  const withFrom = (args: readonly string[]) => (from === undefined ? [...args] : [...args, '--from', from]);
  if (rest.length === 1 && rest[0] === '--version') {
    process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    return 0;
  }
  if (rest[0] === 'mcp') {
    // Runs until the client closes stdin; the process then exits on its own.
    const { runMcp } = await import('./mcp/serve');
    await runMcp(withFrom(rest.slice(1)));
    return null;
  }
  if (rest[0] === 'hook') {
    try {
      const { runHook } = await import('./hooks/run-hook');
      return await runHook(rest[1], from ?? process.cwd());
    } catch (error) {
      hookFailed(error);
      return 0;
    }
  }
  if (rest[0] === 'init') {
    const { runInitVerb } = await import('./cli/init');
    return runInitVerb(withFrom(rest.slice(1)), { bin: options.bin });
  }
  if (rest[0] === 'leave') {
    const { runLeaveVerb } = await import('./cli/leave');
    return runLeaveVerb(withFrom(rest.slice(1)));
  }
  if (rest[0] === 'status' || rest[0] === 'doctor') {
    const { runHealthVerb } = await import('./cli/health');
    // Through the shell shim the repo is the shim's own checkout, whatever the cwd, unless the command names a --from.
    const start = from ?? options.startDir;
    return runHealthVerb(rest[0], rest.slice(1), start === undefined ? {} : { startDir: start });
  }
  if (rest[0] === 'start' || rest[0] === 'open') {
    const { runOpenVerb, runStartVerb } = await import('./start/run');
    const run = rest[0] === 'start' ? runStartVerb : runOpenVerb;
    return run(withFrom(rest.slice(1)), { bin: options.bin, ...(options.startDir === undefined ? {} : { startDir: options.startDir }) });
  }
  if (rest[0] === 'runner' || (rest[0] === 'chore' && rest[1] === 'run')) {
    const { runRunnerVerb } = await import('./cli/runner');
    return runRunnerVerb(withFrom(rest), { bin: options.bin, ...(options.startDir === undefined ? {} : { startDir: options.startDir }) });
  }
  const { runCli } = await import('./cli/run');
  return runCli(withFrom(rest), { bin: options.bin, ...(options.startDir === undefined ? {} : { startDir: options.startDir }) });
}

/**
 * Ends the process with `code` once everything settles; a handle left open by
 * mistake can't keep it alive. A hook that left work running past its budget
 * has said all it will (its output is flushed): the process ends at once, so
 * that work can't run it into the clients' 10 s hook timeout.
 */
export function exitWith(code: number | null): void {
  if (code === null) return;
  process.exitCode = code;
  setTimeout(() => process.exit(), lateWork() > 0 ? 0 : 5_000).unref();
}
