// Offering knowledge chores (spec §16 Offering, Carriers; §12 SessionStart hook
// output): the one shipped chore procedure every carrier is built from (the
// Claude Code skill and subagent, the Codex skill and role, the `chores` MCP
// prompt), and the session line that is the only nudge to run it.
//
// The procedure never tells the agent to edit files or seek approval. The
// line never carries wiki or proposal text: only that a chore is due, and how
// many proposals wait for a person.

/** The skill, the Claude Code subagent type and the Codex role chores run as. */
export const CHORES_NAME = 'grimoire-chores';

/** The neutral description of the chore skill, in both clients (spec §16). */
export const CHORES_SKILL_DESCRIPTION =
  "Run grimoire's due maintenance chores in an isolated subagent. Use when grimoire's session notice says one is due and the user agrees, or when the user asks.";

/** The four chore tools, as MCP names them. */
export const CHORE_TOOLS = ['chore_start', 'chore_read', 'chore_submit', 'chore_abandon'] as const;

/** The seven steps (spec §16 Carriers). */
const STEPS = [
  '1. Start: call `chore_start`. Pass `manual: true` only when the user explicitly asked for this run. It returns the run handle, the chore, why it is due, and the `output_schema` your result must match. If it answers NOT_DUE, return its message verbatim and stop.',
  '2. Page the inputs: call `chore_read` with the `run` until it returns no `cursor`. Pass `item` to read one served item again.',
  '3. Reason: work out the result from the served items alone. Cite only items `chore_read` served you.',
  '4. Submit: call `chore_submit` with the `run` and a `result` in the shape of `output_schema`.',
  '5. At most one fix-up: when the submit is refused with reason codes, fix what they name and submit once more. If you can’t, end the run with `chore_abandon` and a short reason.',
  '6. After a Wiki Maintainer submit, run the Skill Proposer if it became due: call `chore_start` with `kind: "skill-proposer"`, and do steps 2 to 5 for it. NOT_DUE means it isn’t due: you are done.',
  '7. Return the `summary` of the last `chore_submit` or `chore_abandon` result verbatim, and nothing else.',
];

const RULES = [
  'Rules:',
  '- Use only the chore tools. Never edit, create or delete files, never run commands, and never use `apply_patch` or `web_search`.',
  '- Never ask for approval or for input: grimoire checks every result itself, and a person reviews every skill proposal.',
];

/** The Skill Proposer's authoring rules (spec §16 Carriers). */
const PROPOSER_RULES = [
  'When you write a Skill Proposer result:',
  '- Write facts and procedures about this host repo: commands, conventions, pitfalls, where things live. Never model-specific workarounds.',
  '- Put the trigger words first in the description, which is at most 300 characters.',
  '- Keep the skill body self-contained: never refer to pattern pages or the wiki.',
];

/** The shipped chore procedure, as Markdown: the steps, the rules and the Skill Proposer's authoring rules. */
export const CHORE_PROCEDURE = [
  `Run grimoire's due maintenance chore with grimoire's chore tools only: ${CHORE_TOOLS.map((tool) => `\`${tool}\``).join(', ')}.`,
  '',
  ...STEPS,
  '',
  ...RULES,
  '',
  ...PROPOSER_RULES,
].join('\n');

/** The `chores` MCP prompt's description: the carrier for generic MCP clients. */
export const CHORES_PROMPT_DESCRIPTION = "Run grimoire's due maintenance chore: start it, page its inputs, submit the result, and return grimoire's summary.";

/**
 * The `chores` MCP prompt's text (spec §16 Carriers, generic MCP clients).
 * Such a client runs it in place: grimoire admits it while the person holds
 * no open attempt in this repo on this machine.
 */
export const CHORES_PROMPT_TEXT = `${CHORE_PROCEDURE}\n\nRun it in a fresh conversation that holds no claimed grimoire issue: grimoire refuses a chore while you hold one.\n`;

/** `knowledge.pickup`: how sessions on this machine pick up a due chore. */
export type Pickup = 'ask' | 'auto' | 'manual';

/** The fact a due chore's line starts with. */
const DUE = 'grimoire: a maintenance chore is due';

/** The SessionStart line for a due chore under `pickup` (spec §16 Offering). */
export function choreDueLine(pickup: Pickup): string {
  switch (pickup) {
    case 'auto':
      return `${DUE}. Run the grimoire-chores skill now; it works in the background.`;
    case 'manual':
      return `${DUE}.`;
    default:
      return `${DUE}. At a natural pause, offer to run the grimoire-chores skill; don't run it unasked.`;
  }
}

/** "1 skill proposal awaits review", the note a chore line gets when one is pending. */
function proposalsNote(pending: number): string {
  return pending === 1 ? '1 skill proposal awaits review' : `${pending} skill proposals await review`;
}

/** The line for pending proposals alone (spec §12, priority 4). */
export function proposalsLine(pending: number): string {
  return pending === 1 ? "1 skill proposal awaits human review in grimoire's dashboard" : `${pending} skill proposals await human review in grimoire's dashboard`;
}

/** What the session line is chosen from (spec §12 SessionStart hook output). */
export interface SessionFacts {
  /** 1. The not-joined notice. */
  readonly notJoined?: string | null;
  /** 2. The pin-mismatch notice. */
  readonly pinMismatch?: string | null;
  /** 3. A chore is due, picked up as this machine's `knowledge.pickup` says. */
  readonly choreDue?: Pickup | null;
  /** 3, 4. How many skill proposals are pending human review. */
  readonly proposalsPending?: number;
  /** 5. Stray edits and refreshed pointer files. */
  readonly last?: string | null;
}

/** The SessionStart line is at most this long (spec §12). */
export const SESSION_LINE_MAX = 200;

/**
 * The one line a session start says, by priority (spec §12): not joined, pin
 * mismatch, a due chore (with the pending proposals noted when it fits), the
 * pending proposals alone, then stray edits and refreshed pointer files. Null
 * when there is nothing to say.
 */
export function sessionLine(facts: SessionFacts): string | null {
  const pending = facts.proposalsPending ?? 0;
  if (facts.notJoined) return facts.notJoined;
  if (facts.pinMismatch) return facts.pinMismatch;
  if (facts.choreDue) {
    const line = choreDueLine(facts.choreDue);
    if (pending === 0) return line;
    const noted = `${line.replace(/\.$/, '')}; ${proposalsNote(pending)}`;
    return noted.length <= SESSION_LINE_MAX ? noted : line;
  }
  if (pending > 0) return proposalsLine(pending);
  return facts.last ?? null;
}
