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
import { GrimoireError } from '../../errors';
import { terminalOn } from './wiki';

/**
 * A confirmation that shows the person something first: `notice` goes to
 * stderr before the prompt, and `input` adds fields to the call (what the
 * person was shown, such as the version a restore checks its base against).
 */
export interface ShownConfirmation {
  readonly subject: string;
  readonly notice?: string;
  readonly input?: Record<string, unknown>;
}

/** Decides what a call's person must type, or null when the call needs no confirmation. */
export type Confirmation = (input: Record<string, unknown>, ctx: CallContext, core: Pick<Core, 'call'>) => Promise<string | ShownConfirmation | null>;

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

/** Quarantine names a page or a trace: the person types the slug, or the attempt handle. */
const quarantineTarget: Confirmation = async (input) => {
  const subject = typeof input.trace === 'string' ? input.trace : input.page;
  return typeof subject === 'string' && subject.trim() !== '' ? subject.trim() : 'quarantine';
};
const QUARANTINE_HELP = 'a person runs it at an interactive terminal, with no agent marker set, and types the page’s slug (or the trace’s attempt handle) to confirm';

/**
 * Stray edits (spec §15) are a skill's: the person types the skill's name
 * (`all` to discard every one). A stray edit this lookup can't find asks for
 * its id instead; the core then refuses it.
 */
const strayEditSkill: Confirmation = async (input, ctx, core) => {
  if (input.all === true) return 'all';
  if (typeof input.skill === 'string' && input.skill.trim() !== '') return input.skill.trim();
  if (typeof input.stray !== 'string' || input.stray.trim() === '') return 'stray edit';
  const id = input.stray.trim();
  const listed = await core.call('skill_strays', {}, ctx);
  const edits = listed.ok ? ((listed.result as { stray_edits?: { id: string; skill: string }[] }).stray_edits ?? []) : [];
  return edits.find((edit) => edit.id === id)?.skill ?? id;
};
const STRAY_HELP = 'a person runs it at an interactive terminal, with no agent marker set, and types the skill’s name to confirm (`all` with all: true)';

/** Only a diff's changed lines, indented: what a confirmation lists. */
function changedLines(diff: readonly string[], indent: string): string[] {
  const changed = diff.filter((line) => line.startsWith('+ ') || line.startsWith('- '));
  return changed.length === 0 ? [`${indent}(no change)`] : changed.map((line) => `${indent}${line}`);
}

/**
 * A restore (spec §18) lists and diffs what it undoes and drops before the
 * person confirms with the skill's name, and commits only while the version
 * they were shown is still current. A restore that can't be made is refused
 * before anything is asked.
 */
const skillRestore: Confirmation = async (input, ctx, core) => {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || typeof input.version !== 'string') return name === '' ? 'skill restore' : name;
  const shown = await core.call('skill_show', { name, restore: input.version }, ctx);
  if (!shown.ok) throw new GrimoireError(shown.error.code, shown.error.message, shown.error.details);
  const plan = shown.result.restore!;
  const short = (version: string | null) => (version === null ? 'none' : version.slice(0, 12));
  const lines = [`grimoire skill restore: ${name} goes from ${short(plan.current)} back to ${short(plan.version)}.`];
  if (plan.undone) lines.push(`Undone, which counts as negative evidence: the ${plan.undone.kind} to ${short(plan.undone.version)} (${plan.undone.by}, ${plan.undone.at}).`);
  if (plan.dropped.length > 0) {
    lines.push('Dropped along the way, which is no negative evidence and may be proposed again:');
    for (const dropped of plan.dropped) {
      lines.push(`  the ${dropped.kind} to ${short(dropped.version)} (${dropped.by}, ${dropped.at}), against the restored text:`);
      lines.push(...changedLines(dropped.diff, '    '));
    }
  }
  lines.push('The current text against the restored one:', ...changedLines(plan.diff, '  '));
  if (plan.lifts_block) lines.push(`This lifts the block on the name ${name}, and counts against the cap like a create (${plan.active} of ${plan.cap} active).`);
  lines.push('Pending proposals on the skill go stale.');
  return { subject: name, notice: lines.join('\n'), ...(input.base === undefined ? { input: { base: plan.current } } : {}) };
};

/** Ops whose confirmation isn't the human-only default. */
const CONFIRMATIONS = new Map<string, CustomConfirmation>([
  [
    'release',
    {
      confirm: releaseAbandoned,
      help: 'with abandoned: true for another person’s attempt, a person runs it at an interactive terminal, with no agent marker set, and types the issue id to confirm',
    },
  ],
  ['quarantine', { confirm: quarantineTarget, help: QUARANTINE_HELP }],
  ['unquarantine', { confirm: quarantineTarget, help: QUARANTINE_HELP }],
  ['skill_record', { confirm: strayEditSkill, help: STRAY_HELP }],
  ['skill_discard', { confirm: strayEditSkill, help: STRAY_HELP }],
  [
    'skill_restore',
    {
      confirm: skillRestore,
      help: 'a person runs it at an interactive terminal, with no agent marker set, sees what the restore undoes and drops (each diffed), and types the skill’s name to confirm',
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
): Promise<string | ShownConfirmation | null> {
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
