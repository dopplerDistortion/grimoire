// The human-only gate at the terminal (spec §7). The core refuses a human-only
// op under agent markers or without an interactive terminal (HUMAN_ONLY,
// checkSurface); the CLI adds the third condition, a typed confirmation: the
// person types the id (the name, for skills) before the op runs. Later slices
// register their human-only verbs here: a human-only op needs nothing more
// unless its subject isn't one of the usual fields, or, like `release
// --abandoned`, only some of its calls are human-only.
import { createInterface } from 'node:readline';
import type { CallContext, Core, OpDescriptor } from '../../core';

/** Decides what a call's person must type, or null when the call needs no confirmation. */
export type Confirmation = (input: Record<string, unknown>, ctx: CallContext, core: Pick<Core, 'call'>) => Promise<string | null>;

/** The fields that name a human-only op's subject, in the order they are looked for. */
const SUBJECT_FIELDS = ['id', 'name', 'key', 'attempt'] as const;

/** What a human-only op's person types: its id, its name (skills), its key (settings) or its handle (outcomes). */
function subjectOf(input: Record<string, unknown>): string | null {
  for (const field of SUBJECT_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * `release` with `abandoned: true` is human-only only for another person's
 * attempt (spec §7): the core lets a human surface end it, so the person
 * confirms with the issue id. Their own dead claim needs no confirmation.
 */
const releaseAbandoned: Confirmation = async (input, ctx, core) => {
  const { abandoned, id, attempt } = input;
  if (abandoned !== true || typeof id !== 'string' || typeof attempt !== 'string') return null;
  const shown = await core.call('show', { ref: id, comments: 'none' }, ctx);
  if (!shown.ok) return null;
  const open = (shown.result as { open_attempts?: { attempt: string; held_by_you: boolean }[] }).open_attempts ?? [];
  const named = open.find((held) => held.attempt === attempt.trim());
  return named && !named.held_by_you ? id.trim() : null;
};

/** Ops whose confirmation isn't the human-only default. */
const CONFIRMATIONS = new Map<string, Confirmation>([['release', releaseAbandoned]]);

/** Registers how a later slice's verb confirms. */
export function registerConfirmation(op: string, confirmation: Confirmation): void {
  CONFIRMATIONS.set(op, confirmation);
}

/** What the person must type before `op` runs with `input`, or null when nothing. */
export async function confirmationFor(
  op: OpDescriptor,
  input: Record<string, unknown>,
  ctx: CallContext,
  core: Pick<Core, 'call'>,
): Promise<string | null> {
  const custom = CONFIRMATIONS.get(op.name);
  if (custom) return custom(input, ctx, core);
  // A missing subject is the core's INVALID to give, before anything runs.
  return op.policy === 'human-only' ? subjectOf(input) : null;
}

/** Whether `op` may ask for a typed confirmation (so its input can't come from a terminal's stdin). */
export function mayConfirm(op: OpDescriptor): boolean {
  return op.policy === 'human-only' || CONFIRMATIONS.has(op.name);
}

/**
 * Asks at the terminal for `subject` to be typed (the prompt on stderr, so
 * stdout stays one JSON object). True only for an exact match; end of input
 * or anything else is a refusal.
 */
export function confirmTyped(
  io: { stdin: NodeJS.ReadableStream; stderr: NodeJS.WritableStream },
  verb: string,
  subject: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: false });
    let answered = false;
    const finish = (line: string | null) => {
      if (answered) return;
      answered = true;
      rl.close();
      // A paused terminal stream keeps no handle open, so the process can exit.
      io.stdin.pause();
      resolve(line !== null && line.trim() === subject);
    };
    io.stderr.write(`grimoire ${verb} is a human-only operation. Type ${subject} to confirm (anything else cancels): `);
    rl.once('line', (line) => finish(line));
    rl.once('close', () => finish(null));
  });
}
