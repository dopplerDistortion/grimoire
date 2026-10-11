// Interim: the bin's entry for the `wiki` verbs and for `sync --background`
// until the CLI surface (GOK-141's `runCli`) is on the branch. When it lands,
// `wiki list` and `wiki show` are its `<noun> <verb>` aliases of wiki_list and
// wiki_show, `sync --background` is its own, and `wiki edit` is the verb it
// hands to the editor session (wikiEditSession in ./wiki.ts) instead of
// calling wiki_edit; this file and main.ts's `wiki` and `sync` branches go.
// Until then these verbs keep the CLI's contracts (spec §10): stdout is
// exactly one JSON object; exit 0 on success, 1 with an `error` object, 2 for
// a usage error; `--help` prints the op's input schema; `--input -` takes the
// op's input as a JSON object on stdin.
import { randomBytes } from 'node:crypto';
import type { CallContext, OpDescriptor, Outcome } from '../../core';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';
import { GrimoireError, type ErrorBody } from '../../errors';
import { openGitEditor } from './editor';
import { terminalOn, wikiEditSession } from './wiki';

/** The variables whose presence makes a CLI call an agent's (spec §7). */
const AGENT_MARKERS = ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID'] as const;

/** The call context of a CLI call (spec §7): the host repo from the cwd, the person, and what the shell shows. */
async function contextOf(): Promise<CallContext> {
  const root = await findHostRoot(process.cwd());
  const [config, person] = await Promise.all([readCheckoutConfig(root), readPerson(root)]);
  const agentMarkers = AGENT_MARKERS.filter((name) => (process.env[name] ?? '').trim() !== '');
  return {
    surface: 'cli',
    repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
    person,
    client: null,
    evidence: agentMarkers.length > 0 ? { agentMarkers } : {},
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    nonce: randomBytes(8).toString('hex'),
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : undefined)}\n`);
}

/** A malformed command line: one JSON object naming the fix, exit 2. */
function usage(message: string, verb?: string): number {
  const help = `grimoire ${verb ?? 'wiki <list | show | edit>'} --help`;
  print({ usage_error: { message, help } });
  process.stderr.write(`grimoire: ${message} (see ${help})\n`);
  return 2;
}

/** The envelope for a failure outside the core's own outcomes: grimoire's errors as they are, anything else as INTERNAL (ADR 0012). */
function errorBodyOf(error: unknown): ErrorBody {
  if (error instanceof GrimoireError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grimoire: ${error instanceof Error && error.stack ? error.stack : message}\n`);
  return {
    code: 'INTERNAL',
    message: `grimoire failed unexpectedly (${message}); re-read the page before retrying, and tell the user if it keeps happening`,
    retryable: false,
    details: {},
  };
}

/** The verbs, their ops and their positional arguments. */
const WIKI_VERBS = {
  list: { op: 'wiki_list', positionals: [] },
  show: { op: 'wiki_show', positionals: ['slug'] },
  edit: { op: 'wiki_edit', positionals: ['slug'] },
} as const satisfies Record<string, { op: string; positionals: readonly string[] }>;
type WikiVerb = keyof typeof WIKI_VERBS;

function verbHelp(verb: WikiVerb, op: OpDescriptor): Record<string, unknown> {
  const { positionals } = WIKI_VERBS[verb];
  return {
    verb: `wiki ${verb}`,
    op: op.name,
    description: op.description,
    kind: op.kind,
    policy: op.policy,
    usage: [`grimoire wiki ${verb}`, ...positionals.map((p) => `<${p}>`), '[--input -]'].join(' '),
    positionals,
    input_schema: op.inputSchema,
    ...(verb === 'edit' ? { interactive: 'opens your git editor at an interactive terminal, with no agent marker set; you type the slug to confirm' } : {}),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** `grimoire wiki <list | show <slug> | edit <slug>> [--input -] [--help]`: prints one JSON object; returns the exit code. */
export async function runWiki(argv: readonly string[], options: { readonly bin: string }): Promise<number> {
  const [word, ...rest] = argv;
  const help = argv.includes('--help') || argv.includes('-h');
  const { createCore, spawnedAutoSync } = await import('../../core');
  // A CLI write hands its automatic sync to a detached `grimoire sync --background`
  // (spec §4); until that child finishes (or if it can't run), the sync-pending marker stands.
  const core = createCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: [options.bin, 'sync', '--background'] }) });
  try {
    if (word === undefined || !Object.hasOwn(WIKI_VERBS, word)) {
      return usage(word === undefined || word.startsWith('-') ? 'name a wiki verb: list, show or edit' : `there is no verb wiki ${word}`);
    }
    const verb = word as WikiVerb;
    const name = `wiki ${verb}`;
    if (help) {
      print(verbHelp(verb, core.ops.find((op) => op.name === WIKI_VERBS[verb].op)!));
      return 0;
    }
    const positionals: readonly string[] = WIKI_VERBS[verb].positionals;
    const words: string[] = [];
    let stdinInput = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === '--input=-' || (arg === '--input' && rest[i + 1] === '-')) {
        stdinInput = true;
        if (arg === '--input') i++;
      } else if (arg === '--input' || arg.startsWith('--input=')) {
        return usage('--input takes - (the JSON object comes on stdin)', name);
      } else if (arg.startsWith('-')) {
        return usage(`${name} has no flag ${arg}`, name);
      } else {
        words.push(arg);
      }
    }
    if (words.length > positionals.length) {
      return usage(`too many arguments: ${name} takes ${positionals.map((p) => `<${p}>`).join(' ') || 'none'}`, name);
    }
    let input: Record<string, unknown> = {};
    if (stdinInput) {
      if (verb === 'edit' && process.stdin.isTTY) return usage('wiki edit asks at this terminal, so give the slug as an argument, not on stdin', name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readStdin());
      } catch {
        return usage('stdin must hold one JSON object (the op’s input); it isn’t valid JSON', name);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return usage('stdin must hold one JSON object (the op’s input)', name);
      input = { ...(parsed as Record<string, unknown>) };
    }
    for (const [i, word] of words.entries()) {
      const field = positionals[i]!;
      if (Object.hasOwn(input, field)) return usage(`${field} is given twice (on stdin and on the command line)`, name);
      input[field] = word;
    }
    if (verb !== 'list' && input.slug === undefined) return usage(`${name} takes <slug>`, name);
    if (verb === 'edit' && Object.keys(input).some((field) => field !== 'slug')) {
      return usage('wiki edit takes only the slug: the page text comes from your editor', name);
    }

    let outcome: Outcome<unknown>;
    try {
      const ctx = await contextOf();
      outcome =
        verb === 'edit'
          ? await wikiEditSession(String(input.slug), {
              core,
              ctx,
              terminal: terminalOn({ stdin: process.stdin, stderr: process.stderr }),
              edit: (file) => openGitEditor(file, ctx.repo.root),
            })
          : await core.call(WIKI_VERBS[verb].op, input, ctx);
    } catch (error) {
      outcome = { ok: false, error: errorBodyOf(error) };
    }
    print(outcome.ok ? outcome.result : { error: outcome.error });
    return outcome.ok ? 0 : 1;
  } finally {
    // Waits for the spawn of the sync child, then lets go of git processes.
    await core.close();
  }
}

/** `grimoire sync --background`: the detached sync child a CLI write spawns (spec §4). */
export async function runSync(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] !== '--background') return usage('of sync, only the detached child (sync --background) is on the command line so far');
  const { runBackgroundSync } = await import('../../core');
  try {
    print(await runBackgroundSync(await contextOf()));
    return 0;
  } catch (error) {
    print({ error: errorBodyOf(error) });
    return 1;
  }
}
