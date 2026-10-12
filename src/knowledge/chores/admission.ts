// Chore admission (spec §16 Admission; ADR 0006; spikes C (C1) and F (P5)):
// `chore_start` admits only a caller grimoire can tell holds no open attempt,
// and a context that is itself bound to an open attempt is always refused.
//
// | Caller                                              | Admitted when                                   | Exposure        |
// | Claude, validated hint, agent_type grimoire-chores  | always                                          | none            |
// | Claude, main context or another subagent            | never (NOT_ISOLATED)                            |                 |
// | Codex subagent thread (threadId ≠ sessionId)        | always                                          | none            |
// | Codex root thread                                   | its session is tied to no open attempt          | session marked  |
// | Unidentified (generic client, hooks off)            | the person holds no open attempt on this machine| process marked  |
// | CLI in a Claude Code shell                          | never (NOT_ISOLATED)                            |                 |
// | CLI in a Codex shell (a session id in its env)      | the root-thread rule, keyed on that session     | session marked  |
// | CLI with no session id in its env                   | never (NOT_ISOLATED)                            |                 |
// | Runner child                                        | by construction                                 | none            |
//
// Spike C (C1): only `agent_type === "grimoire-chores"` on a validated hint
// admits a Claude caller; other subagents carry an `agent_id` too. Spike F:
// a Codex chore role isn't visible to the server, so any subagent thread is
// admitted; the role's instructions and this check are the guard.
import { MAIN_CONTEXT, observedEvidence } from '../../capture/evidence';
import { seenHereRows } from '../../capture/seen-here';
import type { CallContext } from '../../core/context';
import { GrimoireError } from '../../errors';
import type { MachineLocalStore } from '../../machine-local';
import type { AttemptRecord, TrackerView } from '../../tracker';
import type { Isolation } from './runs';

/** The Claude Code subagent type the chore skill forks into (spike C, C1). */
export const CHORE_AGENT_TYPE = 'grimoire-chores';

/** A caller admission can place, before anything is read. */
export interface ChoreCaller {
  readonly isolation: Isolation;
  /** The chore-context key: the context that will hold the run. */
  readonly key: string;
  /** The session and context to check against open attempts' bindings, when known. */
  readonly session?: string;
  readonly context?: string;
  /** The root-thread rule: this session must be tied to no open attempt, and is marked. */
  readonly rootSession?: string;
  /** The unidentified rule: the person must hold no open attempt on this machine; the process is marked. */
  readonly process?: string;
}

const USE_THE_SKILL = 'run the grimoire-chores skill: it does the chore in an isolated subagent';

function notIsolated(message: string, hint: string): GrimoireError {
  return new GrimoireError('NOT_ISOLATED', message, { hint });
}

/**
 * The context a call comes from, as chore runs key it: the Claude subagent
 * (session and agent id), the Codex thread, the runner, or the server process
 * of a caller nothing identifies. Null for a caller that can never hold a run
 * (a Claude main context or shell, a CLI call with no session, the dashboard).
 */
export function choreContextKey(ctx: CallContext): string | null {
  const evidence = observedEvidence(ctx);
  switch (ctx.surface) {
    case 'runner':
      return `runner/${ctx.nonce}`;
    case 'mcp':
      if (evidence.source === 'hint') return `claude/${evidence.session}/${evidence.context ?? MAIN_CONTEXT}`;
      if (evidence.source === 'meta') {
        const thread = evidence.context ?? evidence.session;
        return thread === undefined ? null : `codex/${thread}`;
      }
      // A Claude call whose hint didn't validate (or that has none) is never a chore context.
      if (evidence.source === 'tool-use-id' || evidence.pendingHint !== null) return null;
      return `process/${ctx.nonce}`;
    case 'cli': {
      if (ctx.client?.name === 'claude-code' || evidence.session === undefined) return null;
      return `codex/${evidence.context ?? evidence.session}`;
    }
    default:
      return null;
  }
}

/** Places the caller in the admission table, or NOT_ISOLATED for a row that never admits. */
export function classifyCaller(ctx: CallContext): ChoreCaller {
  const evidence = observedEvidence(ctx);
  if (ctx.surface === 'runner') return { isolation: 'runner', key: `runner/${ctx.nonce}` };
  if (ctx.surface === 'mcp') {
    if (evidence.source === 'hint') {
      const { session, context } = evidence;
      if (evidence.agentType === CHORE_AGENT_TYPE && context !== undefined && context !== MAIN_CONTEXT) {
        return { isolation: 'claude-chore-agent', key: `claude/${session}/${context}`, session: session!, context };
      }
      throw notIsolated(
        context === undefined || context === MAIN_CONTEXT
          ? 'chores never run in a main context: it may hold an open attempt'
          : 'chores run only in the grimoire-chores subagent',
        USE_THE_SKILL,
      );
    }
    if (evidence.source === 'tool-use-id' || evidence.pendingHint !== null) {
      // Claude Code, with no hint its own _meta validates: nothing says this is the chore subagent.
      throw notIsolated('this call carries no hint grimoire could validate, so its context is unknown', USE_THE_SKILL);
    }
    if (evidence.source === 'meta') {
      const { session, context } = evidence;
      if (session !== undefined && context !== undefined && context !== session) {
        return { isolation: 'codex-subagent', key: `codex/${context}`, session, context };
      }
      const root = (session ?? context)!;
      return { isolation: 'codex-root', key: `codex/${root}`, session: root, context: root, rootSession: root };
    }
    return { isolation: 'unidentified', key: `process/${ctx.nonce}`, process: ctx.nonce };
  }
  if (ctx.surface === 'cli') {
    if (ctx.client?.name === 'claude-code') {
      throw notIsolated('a Claude Code shell is never the chore subagent', USE_THE_SKILL);
    }
    if (evidence.session === undefined) {
      throw notIsolated('this shell names no agent session, so there is nothing to mark', 'ask an agent to run the grimoire-chores skill, or use `grimoire chore run`');
    }
    const thread = evidence.context ?? evidence.session;
    return { isolation: 'codex-root', key: `codex/${thread}`, session: evidence.session, context: thread, rootSession: evidence.session };
  }
  throw notIsolated(`chores aren't run from the ${ctx.surface}`, 'ask an agent to run the grimoire-chores skill, or use `grimoire chore run`');
}

/** The binding actors of an open attempt: its opening, and every write that named its handle. */
function bindingActors(record: AttemptRecord): Readonly<Record<string, unknown>>[] {
  return [record.start.actor, ...record.activity.flatMap((entry) => (entry.detail?.attempt === record.id ? [entry.detail.actor] : []))];
}

const openAttempts = (view: TrackerView) => view.allAttempts().filter((record) => record.end === null);

/**
 * Refuses a caller the tracker or this machine ties to an open attempt (spec
 * §16): a context bound to one, always; a root thread whose session is; an
 * unidentified caller whose person holds one in this host repo on this machine.
 */
export async function checkAttemptFree(caller: ChoreCaller, view: TrackerView, store: MachineLocalStore, person: string | null): Promise<void> {
  const open = openAttempts(view);
  for (const record of open) {
    for (const actor of bindingActors(record)) {
      if (caller.process !== undefined && actor.nonce === caller.process) {
        throw notIsolated(`this server process is bound to the open attempt ${record.id} on ${record.issue}`, 'finish that attempt first');
      }
      const session = typeof actor.session === 'string' ? actor.session : undefined;
      if (session === undefined || caller.session === undefined || session !== caller.session) continue;
      const context = typeof actor.context === 'string' ? actor.context : undefined;
      if (caller.rootSession !== undefined) {
        throw notIsolated(`this session is tied to the open attempt ${record.id} on ${record.issue}`, 'finish that attempt first, or run the chore in a subagent');
      }
      if (context === caller.context) {
        throw notIsolated(`this context is bound to the open attempt ${record.id} on ${record.issue}`, 'finish that attempt first');
      }
    }
  }
  if (caller.process !== undefined) {
    const here = new Set((await seenHereRows(store).catch(() => [])).map((row) => row.handle));
    const held = open.find((record) => record.start.assignee === person && here.has(record.id));
    if (held) {
      throw notIsolated(
        `grimoire can't tell this context apart, and you hold the open attempt ${held.id} on ${held.issue} on this machine`,
        'finish your open attempts first, or use a client grimoire can identify',
      );
    }
  }
}
