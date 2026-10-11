// The human-only gate at the terminal (spec §7). The core refuses a human-only
// op under agent markers or without an interactive terminal (HUMAN_ONLY,
// checkSurface); the CLI adds the third condition, a typed confirmation: the
// person types the id (the name, for skills) before the op runs. Later slices
// register their human-only verbs here: a human-only op needs nothing more
// unless its subject isn't one of the usual fields, or, like `release
// --abandoned`, only some of its calls are human-only. The gate fails closed:
// a human-only call whose subject can't be found asks for the verb instead.
import type { CallContext, Core, OpDescriptor } from '../../core';
import { parseHandle } from '../../core/attempts';
import { terminalOn } from './wiki';

/** Decides what a call's person must type, or null when the call needs no confirmation. */
export type Confirmation = (input: Record<string, unknown>, ctx: CallContext, core: Pick<Core, 'call'>) => Promise<string | null>;

/** The fields that name a human-only op's subject, in the order they are looked for, with what a person calls each. */
const SUBJECT_FIELDS = [
  ['id', 'id'],
  ['name', 'name'],
  ['slug', 'slug'],
  ['page', 'page’s slug'],
  ['key', 'key'],
  ['attempt', 'attempt handle'],
] as const;

/** The input field a human-only op's person types: its id, its name (skills), its slug (wiki pages, quarantine), its key (settings) or its handle (outcomes). */
function subjectFieldOf(op: OpDescriptor): (typeof SUBJECT_FIELDS)[number] | null {
  const properties = (op.inputSchema.properties ?? {}) as Record<string, unknown>;
  return SUBJECT_FIELDS.find(([field]) => Object.hasOwn(properties, field)) ?? null;
}

/**
 * `release` with `abandoned: true` is human-only only for another person's
 * attempt (spec §7): the core lets a human surface end it, so the person
 * confirms with the issue id. Only the caller's own open attempt, found as
 * such, goes unconfirmed: the core matches more loosely than this lookup can
 * (a handle in capitals, a bare id that names both sides of a collision), so
 * anything else asks.
 */
const releaseAbandoned: Confirmation = async (input, ctx, core) => {
  const { abandoned, id, attempt } = input;
  if (abandoned !== true || typeof id !== 'string' || typeof attempt !== 'string') return null;
  let handle: string;
  try {
    handle = parseHandle(attempt);
  } catch {
    // Not a handle: the core refuses the call before anything runs.
    return null;
  }
  const shown = await core.call('show', { ref: id, comments: 'none' }, ctx);
  const open = shown.ok ? ((shown.result as { open_attempts?: { attempt: string; held_by_you: boolean }[] }).open_attempts ?? []) : [];
  return open.some((held) => held.attempt === handle && held.held_by_you) ? null : id.trim();
};

interface CustomConfirmation {
  readonly confirm: Confirmation;
  /** What `--help` says about it. */
  readonly help: string;
}

/** Ops whose confirmation isn't the human-only default. */
const CONFIRMATIONS = new Map<string, CustomConfirmation>([
  [
    'release',
    {
      confirm: releaseAbandoned,
      help: 'with abandoned: true for another person’s attempt, a person runs it at an interactive terminal, with no agent marker set, and types the issue id to confirm',
    },
  ],
]);

/** Registers how a later slice's verb confirms. */
export function registerConfirmation(op: string, confirm: Confirmation, help: string): void {
  CONFIRMATIONS.set(op, { confirm, help });
}

/** What the person must type before `op` (typed as `verb`) runs with `input`, or null when nothing. */
export async function confirmationFor(
  op: OpDescriptor,
  verb: string,
  input: Record<string, unknown>,
  ctx: CallContext,
  core: Pick<Core, 'call'>,
): Promise<string | null> {
  const custom = CONFIRMATIONS.get(op.name);
  if (custom) return custom.confirm(input, ctx, core);
  if (op.policy !== 'human-only') return null;
  const subject = subjectFieldOf(op);
  const value = subject ? input[subject[0]] : undefined;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : verb;
}

/** What `--help` says about `op`'s typed confirmation, or null when it never asks for one. */
export function confirmationHelp(op: OpDescriptor, verb: string): string | null {
  const custom = CONFIRMATIONS.get(op.name);
  if (custom) return custom.help;
  if (op.policy !== 'human-only') return null;
  const subject = subjectFieldOf(op);
  return `a person runs it at an interactive terminal, with no agent marker set, and types ${subject ? `the ${subject[1]}` : `\`${verb}\``} to confirm`;
}

/** Whether `op` may ask for a typed confirmation. */
export function mayConfirm(op: OpDescriptor): boolean {
  return op.policy === 'human-only' || CONFIRMATIONS.has(op.name);
}

/**
 * Asks at the terminal for `subject` to be typed (the prompt on stderr, so
 * stdout stays one JSON object). True only for an exact match; Ctrl-C, end of
 * input or anything else is a refusal.
 */
export async function confirmTyped(
  io: { stdin: NodeJS.ReadableStream; stderr: NodeJS.WritableStream },
  verb: string,
  subject: string,
): Promise<boolean> {
  const answer = await terminalOn(io).ask(`grimoire ${verb} is a human-only operation. Type ${subject} to confirm (anything else cancels): `);
  // A paused terminal stream keeps no handle open, so the process can exit.
  io.stdin.pause();
  return answer !== null && answer.trim() === subject;
}
