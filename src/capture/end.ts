// Capture at attempt end (spec §14 Cut at attempt end, Pending session
// records, Roots, Statuses): the ending call cuts every bound context that ran
// on this machine, within a hard budget, before its one tracker commit; the
// commit then seals one session record per bound context. Capture problems
// become statuses, never errors.
import os from 'node:os';
import path from 'node:path';
import type { Actor, ReservedHint } from '../core/context';
import type { MachineLocalStore } from '../machine-local';
import type { SecretScanner } from '../scanner';
import type { AttemptRecord, TrackerDraft, TrackerView } from '../tracker';
import { boundContexts, readBindings, type Binding } from './bindings';
import { CLAUDE_CODE_READER_VERSION, cutClaudeCode, readClaudeCodeTranscript } from './claude-code';
import { defaultClaudeConfigDir, findClaudeTranscript } from './claude-code/roots';
import { CODEX_READER_VERSION, cutCodex, readCodexTranscript } from './codex';
import { defaultCodexHome, findCodexTranscript } from './codex/roots';
import {
  callSpans,
  creationsInSpans,
  observedCommits,
  referencedCommits,
  reflogCreations,
  transcriptCommitLines,
  type CommitFact,
  type ReferencedCommit,
  type SeenCommit,
} from './commit-facts';
import { CHORES_AGENT, emptyCut, isChoresContext, type BindingCall, type Cut, type CutEvidence } from './cut';
import type { EvidenceSource } from './evidence';
import { pathRewriter, type PathSpellings } from './paths';
import { clientFamily, contextOf, seenHereRows, sessionKey, type SeenHereRow } from './seen-here';
import {
  parseSessionRecord,
  replaces,
  serializeSessionRecord,
  type FactsStatus,
  type RecordExcerptStatus,
  type RecordNote,
  type SessionRecord,
  withoutText,
} from './session-record';
import { isCall, type Step, type Transcript, type TranscriptStamp } from './steps';
import { eventSkillReads, skillVersionTexts, transcriptSkillReads, type SkillRead, type SkillVersionTexts } from './skill-facts';
import { revealedRoot, revealedRoots } from './transcript-roots';

/** The excerpt mode (spec §14 The setting): `excerpts`, `facts` or `none`. */
export type CaptureMode = 'excerpts' | 'facts' | 'none';

/** The cut's hard budget (spec §14: 10 s). */
export const CUT_BUDGET_MS = 10_000;
/** How long the calling context waits for its ending call to reach its transcript (spec §14: 2 s). */
export const FLUSH_WAIT_MS = 2_000;
const FLUSH_POLL_MS = 100;

const READER_VERSION = { 'claude-code': CLAUDE_CODE_READER_VERSION, codex: CODEX_READER_VERSION } as const;

/** Where capture looks, and how long it may take. Defaults: the clients' own folders, the spec's budgets. */
export interface CaptureOptions {
  /** `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  readonly claudeConfigDir?: string;
  /** `$CODEX_HOME` or `~/.codex`, when no hook revealed the session's home. */
  readonly codexHome?: string;
  /** The home folder, rewritten to `~` in excerpts and roots. */
  readonly home?: string;
  readonly budgetMs?: number;
  readonly flushWaitMs?: number;
}

/** The call ending the attempt, as the process handling it observed it. */
export interface EndingCall {
  /** `close`, `release`, `reassign`, `reopen`: the cut finds a CLI ending call by it. */
  readonly op: string;
  readonly actor: Actor;
  readonly source: EvidenceSource | null;
  readonly pendingHint: ReservedHint | null;
  /** A Claude subagent's `agent_type`, from a validated hint: a `grimoire-chores` subagent is never captured. */
  readonly agentType?: string;
  /** Whether it binds (an abandoned release and a reopen's supersede don't): its context is then cut too. */
  readonly binds: boolean;
  /** When it ends the attempt (ISO 8601): the window's end. */
  readonly at: string;
}

/** A `skill_read` event as the machine-local store keeps it (spec §6, §8: `{skill, version, at, actor, nonce}`). */
export interface SkillReadEvent {
  readonly skill?: unknown;
  readonly version?: unknown;
  readonly at: string;
  readonly actor: Readonly<Record<string, unknown>>;
}

export interface EndCaptureInput {
  /** Where git runs to read the binding trailers. */
  readonly repoRoot: string;
  /** The worktree the ending call came from: rewritten to `<repo>` for its own context, and for a context with no row saying where it worked. */
  readonly worktree: string;
  readonly store: MachineLocalStore;
  /** The view the call validated against. */
  readonly view: TrackerView;
  readonly issue: string;
  /** The attempt being ended; null for an unclaimed close, whose instant attempt opens in the ending commit. */
  readonly attempt: AttemptRecord | null;
  readonly call: EndingCall;
  readonly mode: CaptureMode;
  /** Whether this machine's `capture.excerpts_max` lowered the store's mode to `mode`. */
  readonly capped: boolean;
  readonly skillReads: readonly SkillReadEvent[];
  readonly scanner: SecretScanner;
  readonly options?: CaptureOptions;
  /** When the budget runs out (epoch ms), when one ending cuts several attempts: they share one budget. Default: now plus the budget. */
  readonly deadline?: number;
  /** A sweep, not an ending: only these contexts are cut, while the attempt stays open. */
  readonly sweep?: SweepScope;
}

/**
 * What a sweep cuts (spec §14 Sweeps): the contexts it picked, by session key,
 * each with a seen-here row here. Their windows end at the transcript's end at
 * cut time; contexts it didn't pick get no placeholder. Once `signal` aborts
 * (an attempt-ending call in this process), no further context is cut.
 */
export interface SweepScope {
  readonly only: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  /** Called after each context's cut, before the next (a test's pause point). */
  readonly afterCut?: () => Promise<void> | void;
}

/** One bound context's fresh capture, for the ending commit to seal. */
export interface ContextCapture {
  /** Its session key: the record's name. */
  readonly key: string;
  readonly record: SessionRecord;
  /** False for a context this machine has no seen-here row for: the seal keeps its pending record, else writes this placeholder. */
  readonly cut: boolean;
  /** The row the reach is noted on after the commit, when there is one. */
  readonly row: boolean;
  /** The transcript the record was cut from, as it stood before the read: a sweep doesn't read it again until it moves. */
  readonly stamp?: TranscriptStamp;
}

/** One bound context as the cut sees it: identity, binding calls and what this machine knows of it. */
interface Target {
  readonly key: string;
  readonly client: string;
  readonly session: string | null;
  readonly context: string | null;
  readonly bindingCalls: readonly BindingCall[];
  readonly writeOnly: boolean;
  readonly source: EvidenceSource | null;
  /** Hints its calls carried with no `_meta` to check them against: the row's, then the ending call's. */
  readonly pendingHints: readonly ReservedHint[];
  readonly spawnEnv: string | null;
  readonly path: string | null;
  /** The worktree it worked in, rewritten to `<repo>`: its row's, else the ending call's. */
  readonly worktree: string;
  readonly row: boolean;
  readonly calling: boolean;
}

/**
 * Cuts the attempt's bound contexts (spec §14, step 2): the calling context
 * first, then the contexts with no pending record, then the rest; only
 * contexts with a seen-here row here, and the calling context, are cut. The
 * whole cut, finding the bound contexts included, stays within the budget: a
 * context it can't reach in time gets `budget`. Contexts whose record a human
 * purged, and `grimoire-chores` contexts, are skipped. Only a calling context
 * with evidence naming its transcript waits for its ending call to flush.
 */
export async function captureAtEnd(input: EndCaptureInput): Promise<ContextCapture[]> {
  const started = Date.now();
  const deadline = input.deadline ?? started + (input.options?.budgetMs ?? CUT_BUDGET_MS);
  const handle = input.attempt?.id ?? null;
  // Finding the bound contexts, their pending records and purges is inside the budget too. Past it, a
  // purge is still honoured at the seal, and a pending record only changes the order.
  const { sweep } = input;
  const found = await targetsOf(input, deadline);
  const targets = sweep ? found.filter((target) => target.row && sweep.only.has(target.key)) : found;
  const pending = new Set<string>();
  const purged = handle === null ? new Set<string>() : await beforeDeadline(input.view.purgedSessions(handle), deadline, new Set<string>());
  if (handle !== null) {
    for (const target of targets) {
      if ((await beforeDeadline(input.view.sessionRecord(handle, target.key), deadline, null)) !== null) pending.add(target.key);
    }
  }
  const rank = (t: Target) => (t.calling ? 0 : pending.has(t.key) ? 2 : 1);
  // A sweep names its contexts longest uncut first: within a rank, that order holds.
  const picked = sweep ? [...sweep.only] : [];
  const position = (t: Target) => picked.indexOf(t.key);
  const ordered = [...targets].sort((a, b) => rank(a) - rank(b) || position(a) - position(b));
  // What transcript reads are matched against: every version the ledger records; null when they couldn't be read
  // in time, which leaves every transcript scan's facts partial. `none` mode opens no transcript.
  const versions: SkillVersionTexts | null =
    input.mode === 'none' ? new Map() : await beforeDeadline(skillVersionTexts(input.view, input.scanner), deadline, null);
  const bound = new Set(found.flatMap((target) => (target.context !== null ? [target.context] : [])));

  const captures: ContextCapture[] = [];
  const claimed: string[] = [];
  const cutAt = input.call.at;
  const claudeDirs = await revealedClaudeDirs(input).catch(() => []);
  for (const target of ordered) {
    if (sweep?.signal?.aborted) break;
    if (purged.has(target.key)) continue;
    if (!target.calling && !target.row) {
      captures.push({ key: target.key, record: placeholder(target, cutAt), cut: false, row: false });
      continue;
    }
    const cut = new ContextCut(input, target, deadline, claimed, versions, bound, claudeDirs);
    const record = Date.now() >= deadline ? null : await beforeDeadline(target.calling && traceable(target) ? cut.waitingForFlush(started) : cut.once(), deadline, null);
    await sweep?.afterCut?.();
    // A chores context's transcript is excluded from excerpts and fact scans (spec §14): it gets no record.
    if (cut.chores) continue;
    // A cut the deadline overtook keeps the last record it finished: the calling context's earlier cut.
    const captured = record ?? cut.latest ?? budgetRecord(target, cutAt);
    if (cut.callIds) claimed.push(...cut.callIds);
    const stamp = captured === cut.latest ? cut.stamp : null;
    captures.push({ key: target.key, record: captured, cut: true, row: target.row, ...(stamp ? { stamp } : {}) });
  }
  return captures;
}

/**
 * The attempt's referenced commits (spec §14 Facts: Commits), for its seal:
 * commits on any branch of the clone whose `Refs:` trailer names the issue,
 * committed from the attempt's opening to the ending call, snapshotted.
 * Within the ending's budget; past it, or when git fails, none. An unclaimed
 * close's instant attempt has no span to commit in.
 */
export async function referencedAtEnd(input: {
  readonly repoRoot: string;
  readonly issue: string;
  readonly attempt: AttemptRecord | null;
  /** The ending call's time (ISO 8601). */
  readonly at: string;
  readonly deadline: number;
}): Promise<ReferencedCommit[]> {
  if (input.attempt === null) return [];
  const stallMs = () => Math.max(100, input.deadline - Date.now());
  const work = referencedCommits(input.repoRoot, input.issue, Date.parse(input.attempt.start.at), Date.parse(input.at), { stallMs });
  return beforeDeadline(work, input.deadline, []);
}

/**
 * The Claude Code config folders hooks revealed on this machine (spec §14
 * Roots, §6), other than the one capture looks in: a transcript not found
 * there is searched for in these too. A revealed root is a `projects/<slug>/`
 * folder; its config folder is two levels up.
 */
async function revealedClaudeDirs(input: EndCaptureInput): Promise<string[]> {
  const own = path.resolve(input.options?.claudeConfigDir ?? defaultClaudeConfigDir());
  const dirs = new Set<string>();
  for (const root of await revealedRoots(input.store)) {
    if (root.client !== 'claude-code') continue;
    const dir = path.resolve(path.dirname(path.dirname(root.root)));
    if (dir.toLowerCase() !== own.toLowerCase()) dirs.add(dir);
  }
  return [...dirs].sort();
}

/**
 * The bound contexts, and the calling context when its ending call binds. A
 * person's own writes at a terminal or in the dashboard name the handle too,
 * but a person is no agent session's context: nothing of theirs is cut. When
 * git can't read the binding trailers within the budget, the agent contexts
 * seen here stand in for them: past the deadline, each gets `budget`. When no
 * agent can have bound the attempt, the trailers aren't read at all.
 */
async function targetsOf(input: EndCaptureInput, deadline: number): Promise<Target[]> {
  const { call } = input;
  const rows: SeenHereRow[] = input.attempt ? await seenHereRows(input.store, { handle: input.attempt.id }).catch(() => []) : [];
  const bindings =
    input.attempt && agentMayHaveBound(input.attempt, rows)
      ? await beforeDeadline(
          readBindings(input.repoRoot, input.attempt, input.view.parents).catch(() => []),
          deadline,
          null,
        )
      : [];
  const targets: Target[] = bindings === null ? rows.filter(agentRow).map(rowTarget) : boundTargets(bindings, rows, input.worktree);
  if (!call.binds || call.actor.kind === 'human') return targets;

  // The ending call's own binding write isn't committed yet: the cut looks for it from what this process saw.
  const actor = call.actor;
  const key = sessionKey(actor);
  if (call.agentType === CHORES_AGENT) return targets.filter((target) => target.key !== key);
  const endingCall: BindingCall =
    actor.call !== undefined ? { id: actor.call, at: call.at } : { grimoire: call.op, printed: input.attempt ? [input.attempt.id] : [], at: call.at };
  const revealed = actor.session !== undefined ? await revealedRoot(input.store, actor.session).catch(() => undefined) : undefined;
  const index = targets.findIndex((target) => target.key === key);
  const known = index >= 0 ? targets[index]! : null;
  const calling: Target = {
    key,
    client: actor.client ?? known?.client ?? 'unknown',
    session: actor.session ?? known?.session ?? null,
    context: contextOf(actor) ?? known?.context ?? null,
    bindingCalls: [...(known?.bindingCalls ?? []), endingCall],
    writeOnly: false,
    source: call.source ?? known?.source ?? null,
    pendingHints: [...(known?.pendingHints ?? []), ...(call.pendingHint ? [call.pendingHint] : [])],
    spawnEnv: actor.spawn_env ?? known?.spawnEnv ?? null,
    path: revealed?.transcript_path ?? known?.path ?? null,
    worktree: input.worktree,
    row: known?.row ?? false,
    calling: true,
  };
  if (index >= 0) targets.splice(index, 1);
  return [calling, ...targets];
}

/**
 * Whether anything names the context's transcript (spec §14 Identity, Roots):
 * for Claude Code a session, a hint, a tool-use id or the spawn-env session;
 * for Codex its thread. Without any, there is no transcript for an ending call
 * to reach, so the calling context waits for no flush.
 */
function traceable(target: Target): boolean {
  switch (clientFamily(target.client)) {
    case 'claude-code':
      return target.session !== null || target.spawnEnv !== null || target.pendingHints.length > 0 || target.bindingCalls.some((call) => call.id !== undefined);
    case 'codex':
      return target.context !== null;
    default:
      return false;
  }
}

/** The agent contexts the binding writes name, with this machine's rows. */
function boundTargets(bindings: readonly Binding[], rows: readonly SeenHereRow[], worktree: string): Target[] {
  const agents = boundContexts(bindings, rows).filter((context) => context.bindings.some((binding) => binding.actor.kind !== 'human'));
  return agents.map((context) => {
    const latest = context.bindings.at(-1)!.actor;
    return {
      key: context.key,
      client: context.row?.client ?? context.client ?? 'unknown',
      session: context.session,
      context: context.context,
      bindingCalls: context.bindingCalls,
      writeOnly: context.writeOnly,
      source: context.row?.source ?? null,
      pendingHints: context.row?.pending_hint ? [context.row.pending_hint] : [],
      spawnEnv: context.row?.spawn_env ?? latest.spawn_env ?? null,
      path: context.row?.path ?? null,
      worktree: context.row?.worktree ?? worktree,
      row: context.row !== null,
      calling: false,
    };
  });
}

/**
 * Whether an agent may have bound `attempt`, by what the view and this
 * machine's rows already hold: an agent opened it, a write naming its handle
 * was an agent's (each such write leaves an activity entry naming the handle),
 * it has a session record, or an agent's binding write left a row here. When
 * none holds, every binding is a person's, and a person is no agent context:
 * the ending reads no trailers, so a person's ending at a terminal, a bare
 * shell or the dashboard waits on no git. Anything unreadable counts as an
 * agent's.
 */
function agentMayHaveBound(attempt: AttemptRecord, rows: readonly SeenHereRow[]): boolean {
  if (attempt.start.actor.kind !== 'human' || attempt.sessions.size > 0 || rows.some(agentRow)) return true;
  return attempt.activity.some(({ detail }) => detail === null || (detail.attempt === attempt.id && detail.actor.kind !== 'human'));
}

/** A row an agent's binding write left: a person's, at a terminal or in the dashboard, names no session or context. */
function agentRow(row: SeenHereRow): boolean {
  if (row.session !== null || row.context !== null || row.spawn_env !== null) return true;
  return row.client !== 'cli' && row.client !== 'dashboard';
}

/** A context known only by its row. */
function rowTarget(row: SeenHereRow): Target {
  return {
    key: sessionKey({
      client: row.client,
      nonce: row.nonce,
      ...(row.session !== null ? { session: row.session } : {}),
      ...(row.context !== null ? { context: row.context } : {}),
    }),
    client: row.client,
    session: row.session,
    context: row.context,
    bindingCalls: [],
    writeOnly: false,
    source: row.source,
    pendingHints: row.pending_hint ? [row.pending_hint] : [],
    spawnEnv: row.spawn_env,
    path: row.path,
    worktree: row.worktree,
    row: true,
    calling: false,
  };
}

/**
 * What `work` gives if it settles before the deadline, else `fallback`: the
 * hard budget, whatever a filesystem or a git process does. A failure is
 * `fallback` too: capture problems are statuses, never errors.
 */
async function beforeDeadline<T, F>(work: Promise<T>, deadline: number, fallback: F): Promise<T | F> {
  work.catch(() => {});
  const left = deadline - Date.now();
  if (left <= 0) return fallback;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), left);
  });
  try {
    return await Promise.race([work.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads the own transcript of a subagent launched in a context's window, by its id; null when it can't be found. */
type SubagentReader = (agentId: string) => Promise<Transcript | null>;

/** A context's cut, where it was looked for, and how to reach the subagents its window launched. */
interface CutFound {
  readonly cut: Cut;
  readonly roots: string[];
  readonly source: EvidenceSource | null;
  readonly subagents?: SubagentReader;
}

/** A context's skill reads (spec §14 Facts: Read) and observed commits (Facts: Commits), and whether every transcript the scan covers was read. */
interface SkillFacts {
  readonly reads: SkillRead[];
  readonly commits: CommitFact[];
  readonly complete: boolean;
  /** The subagents launched in the window, by id: their own `skill_read` events count for the context too. */
  readonly launched: ReadonlySet<string>;
}

/** The subagents a window launched, by id, other than `grimoire-chores` ones (whose transcripts are never scanned). */
function launchedSubagents(steps: readonly Step[]): string[] {
  const chores = new Set(steps.flatMap((step) => (step.kind === 'subagent_launch' && step.agentType === CHORES_AGENT ? [step.id] : [])));
  return steps.flatMap((step) => (step.kind === 'subagent_result' && step.agentId !== null && !chores.has(step.id) ? [step.agentId] : []));
}

/** Cutting one context: locating its transcript, the cut, and the record it gives. */
class ContextCut {
  /** The call ids its window holds, once cut: no later excerpt of the trace may hold them. */
  callIds: readonly string[] | null = null;
  /** The record of its last finished cut, for when the deadline overtakes the next one. */
  latest: SessionRecord | null = null;
  /** The transcript `latest` was cut from, as it stood before the read. */
  stamp: TranscriptStamp | null = null;
  /** Whether its transcript names it a `grimoire-chores` context, which is never captured. */
  chores = false;
  private readonly rewrite: (text: string) => string;
  private readonly paths: PathSpellings;

  constructor(
    private readonly input: EndCaptureInput,
    private readonly target: Target,
    private readonly deadline: number,
    private readonly claimed: readonly string[],
    /** Null when the ledger's versions couldn't be read: reads are then of an unknown version, and the facts partial. */
    private readonly versions: SkillVersionTexts | null,
    /** The contexts bound to the attempt: a subagent among them is scanned for its own record, never again for its launcher's. */
    private readonly bound: ReadonlySet<string>,
    /** Other Claude Code config folders hooks revealed: searched when the transcript isn't in the default one. */
    private readonly claudeDirs: readonly string[] = [],
  ) {
    const home = input.options?.home ?? os.homedir();
    this.paths = { home, repo: target.worktree, ...(process.platform === 'win32' ? { tmp: os.tmpdir() } : {}) };
    this.rewrite = pathRewriter(this.paths);
  }

  /**
   * The calling context: cut again until its ending call reached the
   * transcript, for up to the flush wait. Until it has, a context known only
   * by that call (its tool-use id, a pending hint naming it, its spawn-env
   * session holding it) has no transcript yet, or none that holds the call:
   * `not_found` and `unmatched` wait too. The budget bounds the wait: a cut
   * the deadline overtakes leaves `latest`, the one before it. Only for a
   * context `traceable` names a transcript for.
   */
  async waitingForFlush(started: number): Promise<SessionRecord> {
    const until = Math.min(started + (this.input.options?.flushWaitMs ?? FLUSH_WAIT_MS), this.deadline);
    const unflushed = (record: SessionRecord) =>
      record.excerpt_notes.includes('tail_unflushed') || record.excerpt === 'not_found' || record.excerpt === 'unmatched';
    let record = await this.once();
    while (!this.chores && unflushed(record) && Date.now() < until) {
      await sleep(Math.min(FLUSH_POLL_MS, until - Date.now()));
      record = await this.once();
    }
    return record;
  }

  async once(): Promise<SessionRecord> {
    const { record, callIds, stamp } = await this.cutOnce();
    this.latest = record;
    this.callIds = callIds;
    this.stamp = stamp ?? null;
    return record;
  }

  private async cutOnce(): Promise<{ record: SessionRecord; callIds: readonly string[] | null; stamp?: TranscriptStamp }> {
    const { input, target } = this;
    const family = clientFamily(target.client);
    if (input.mode === 'none') return { record: this.factsOnly('off'), callIds: null };
    if (family !== 'claude-code' && family !== 'codex') return { record: this.factsOnly('no_transcript'), callIds: null };
    try {
      const { cut, roots, source, subagents } = family === 'claude-code' ? await this.cutClaude() : await this.cutCodex();
      if (isChoresContext(cut)) this.chores = true;
      const facts = cut.window === null || this.chores ? null : await beforeDeadline(this.scanFacts(cut, subagents), this.deadline, null);
      return { record: this.fromCut(cut, source, roots, facts), callIds: cut.callIds, ...(cut.stamp ? { stamp: cut.stamp } : {}) };
    } catch {
      // A reader that throws is one grimoire can't trust on this transcript.
      const identity = { client: { name: family, version: null }, reader: { version: READER_VERSION[family] }, session: target.session ?? '', context: target.context ?? '' };
      return { record: this.fromCut(emptyCut(identity, 'unreadable'), target.source, []), callIds: null };
    }
  }

  private evidence(extra: readonly BindingCall[] = []): CutEvidence {
    const { input, target } = this;
    return {
      issue: input.issue,
      attemptOpenedAt: input.attempt?.start.at ?? input.call.at,
      // A sweep's window ends at the transcript's end at cut time.
      ...(input.sweep ? {} : { attemptEndedAt: input.call.at }),
      bindingCalls: [...target.bindingCalls, ...extra],
      writeOnly: target.writeOnly,
      claimedCallIds: this.claimed,
    };
  }

  /**
   * A Claude Code context (spec §14 Identity, Roots): a session the evidence
   * names; else a pending hint, counted once its session's transcript holds
   * its tool-use id; else the transcript holding the context's tool-use ids;
   * else the spawn-env session, trusted only if its transcript holds the call.
   */
  private async cutClaude(): Promise<CutFound> {
    const { input, target } = this;
    const configDir = input.options?.claudeConfigDir ?? defaultClaudeConfigDir();
    const projects = path.join(configDir, 'projects');
    const revealed = async (session: string) => {
      const paths = target.path ? [target.path] : [];
      const root = await revealedRoot(input.store, session).catch(() => undefined);
      return root ? [...paths, root.transcript_path] : paths;
    };
    const base = { configDir, deadline: this.deadline, ...(target.spawnEnv ? { spawnEnv: target.spawnEnv } : {}) };
    const extra: BindingCall[] = [];
    let session = target.session;
    let agentId = target.context !== null && target.context !== 'main' ? target.context : undefined;
    let source = target.source;
    let location: Awaited<ReturnType<typeof findClaudeTranscript>> | null = null;

    for (const hint of session === null ? target.pendingHints : []) {
      const hinted = await this.findClaude({ ...base, session: hint.session_id, revealed: await revealed(hint.session_id) });
      if (hinted.status !== 'found') continue;
      const read = await readClaudeCodeTranscript(hinted.transcript, hint.agent_id !== undefined ? { agentId: hint.agent_id } : {});
      if (read.found && read.transcript.steps.some((step) => isCall(step) && step.id === hint.tool_use_id)) {
        session = hint.session_id;
        agentId = hint.agent_id;
        source = 'hint';
        location = hinted;
        extra.push({ id: hint.tool_use_id, at: latestAt(target.bindingCalls) ?? input.call.at });
        break;
      }
    }
    if (location === null) {
      const ids = target.bindingCalls.flatMap((call) => (call.id !== undefined ? [call.id] : []));
      if (session !== null) {
        location = await this.findClaude({ ...base, session, revealed: await revealed(session) });
      } else if (ids.length > 0) {
        location = await this.findClaude({ ...base, callIds: ids, ...(earliestAt(target.bindingCalls) ? { calledAt: earliestAt(target.bindingCalls)! } : {}) });
        if (location.status === 'found') {
          session = location.session;
          agentId = location.agentId;
          source ??= 'tool-use-id';
        }
      } else if (target.spawnEnv !== null) {
        session = target.spawnEnv;
        source = 'spawn-env';
        location = await this.findClaude({ ...base, session, revealed: await revealed(session) });
      }
    }
    const identity = {
      client: { name: 'claude-code', version: null },
      reader: { version: CLAUDE_CODE_READER_VERSION },
      session: session ?? '',
      context: agentId ?? (session !== null ? 'main' : (target.context ?? '')),
    };
    if (location?.status === 'budget') return { cut: emptyCut(identity, 'budget'), roots: [projects], source };
    if (location === null || location.status === 'not_found') {
      return { cut: emptyCut(identity, 'not_found'), roots: [...(target.path ? [target.path] : []), projects], source };
    }
    const cut = await cutClaudeCode({
      transcript: location.transcript,
      ...(agentId !== undefined ? { agentId } : {}),
      evidence: this.evidence(extra),
      paths: this.paths,
      scanner: input.scanner,
    });
    // The spawn-env session counts only if its transcript holds the call: one past its flushed end doesn't.
    if (source === 'spawn-env' && cut.status === 'cut' && cut.window === null) return { cut: emptyCut(cut, 'unmatched'), roots: [], source };
    const transcript = location.transcript;
    const subagents: SubagentReader = async (agentId) => {
      const read = await readClaudeCodeTranscript(transcript, { agentId });
      return read.found ? read.transcript : null;
    };
    return { cut, roots: cut.status === 'not_found' ? [location.transcript] : [], source, subagents };
  }

  /** Finds a transcript in the config folder capture looks in, then in each one hooks revealed (spec §14 Roots). */
  private async findClaude(options: Parameters<typeof findClaudeTranscript>[0]): ReturnType<typeof findClaudeTranscript> {
    let found = await findClaudeTranscript(options);
    for (const configDir of this.claudeDirs) {
      if (found.status !== 'not_found') break;
      found = await findClaudeTranscript({ ...options, configDir });
    }
    return found;
  }

  /** A Codex context: its thread's own transcript, searched by thread id in the hook-revealed home, else the default one. */
  private async cutCodex(): Promise<CutFound> {
    const { input, target } = this;
    const revealed = target.session !== null ? await revealedRoot(input.store, target.session).catch(() => undefined) : undefined;
    const codexHome = (revealed?.client === 'codex' ? revealed.root : undefined) ?? input.options?.codexHome ?? defaultCodexHome();
    if (target.context === null) {
      const identity = { client: { name: 'codex', version: null }, reader: { version: CODEX_READER_VERSION }, session: target.session ?? '', context: '' };
      return { cut: emptyCut(identity, 'not_found'), roots: [codexHome], source: target.source };
    }
    const transcript = target.path ?? (revealed?.client === 'codex' ? revealed.transcript_path : undefined);
    const cut = await cutCodex({
      context: target.context,
      ...(target.session !== null ? { session: target.session } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      codexHome,
      deadline: this.deadline,
      evidence: this.evidence(),
      paths: this.paths,
      scanner: input.scanner,
    });
    const deadline = this.deadline;
    const subagents: SubagentReader = async (thread) => {
      const found = await findCodexTranscript({ codexHome, context: thread, deadline });
      if (found.status !== 'found') return null;
      const read = await readCodexTranscript(found.file);
      return read.found ? read.transcript : null;
    };
    return { cut, roots: cut.status === 'not_found' ? [codexHome] : [], source: target.source, subagents };
  }

  /**
   * The skill reads of a cut context (spec §14 Facts: Read): its whole
   * window, before the excerpt's cut, and the transcripts of the subagents
   * launched in it, found by id, recursively, skipping `grimoire-chores`
   * ones. A subagent transcript that can't be read, or ledger versions that
   * couldn't be read to match reads against, leave the facts incomplete.
   */
  private async scanFacts(cut: Cut, subagents: SubagentReader | undefined): Promise<SkillFacts> {
    const versions = this.versions ?? new Map();
    const reads = transcriptSkillReads(cut, cut.steps, versions);
    const seen: SeenCommit[] = transcriptCommitLines(cut, cut.steps);
    const queue = launchedSubagents(cut.steps);
    const launched = new Set<string>();
    let complete = this.versions !== null;
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (launched.has(id) || this.bound.has(id)) continue;
      launched.add(id);
      const transcript = subagents ? await subagents(id).catch(() => null) : null;
      if (transcript === null) {
        complete = false;
        continue;
      }
      if (transcript.agentType === CHORES_AGENT) continue;
      const steps = transcript.steps.slice(transcript.copiedSteps);
      reads.push(...transcriptSkillReads(transcript, steps, versions));
      seen.push(...transcriptCommitLines(transcript, steps));
      queue.push(...launchedSubagents(steps));
    }
    return { reads, commits: await this.observed(cut, seen), complete, launched };
  }

  /**
   * The context's observed commits (spec §14 Facts: Commits): the creation
   * lines its window and launched subagents showed, then the creating entries
   * of its worktree's HEAD reflog timed inside one of its calls, each
   * snapshotted. Git that can't answer before the deadline leaves them bare,
   * or out.
   */
  private async observed(cut: Cut, seen: readonly SeenCommit[]): Promise<CommitFact[]> {
    const stallMs = () => Math.max(100, this.deadline - Date.now());
    const reflog = await reflogCreations(this.target.worktree, { stallMs }).catch(() => []);
    const inside = creationsInSpans(reflog, callSpans(cut.steps));
    const who = { session: cut.session === '' ? null : cut.session, context: cut.context === '' ? null : cut.context };
    return observedCommits(this.input.repoRoot, seen, inside, who, { stallMs }).catch(() => seen.map(({ hash, session, context }) => ({ hash, via: 'observed' as const, session, context })));
  }

  /**
   * This context's `skill_read` events from `since` (epoch ms) to the ending
   * call, and those of the subagents its window launched: each credited to
   * the context that made it.
   */
  private eventReads(since: number, launched: ReadonlySet<string>, own: { session: string | null; context: string | null }): SkillRead[] {
    const { input, target } = this;
    const ended = Date.parse(input.call.at);
    return input.skillReads.flatMap((event) => {
      const at = Date.parse(event.at);
      if (!(at >= since && at <= ended)) return [];
      const actor = event.actor as Actor;
      if (sessionKey(actor) === target.key) return eventSkillReads([event], own);
      const context = contextOf(actor);
      const fromSubagent = own.session !== null && actor.session === own.session && context !== null && launched.has(context);
      return fromSubagent ? eventSkillReads([event], { session: own.session, context }) : [];
    });
  }

  /** Where this context's `skill_read` events start counting when no window was found. */
  private eventsSince(): number {
    return eventFloor(this.input, this.target.key);
  }

  private fromCut(cut: Cut, source: EvidenceSource | null, roots: readonly string[], scanned: SkillFacts | null = null): SessionRecord {
    const { input } = this;
    const windowFound = cut.window !== null;
    const failed = cut.status === 'not_found' || cut.status === 'unreadable' || cut.status === 'unmatched' || cut.status === 'budget';
    const excerpt: RecordExcerptStatus = failed || input.mode === 'excerpts' ? cut.status : 'off';
    const notes: RecordNote[] = [...cut.notes];
    if (excerpt === 'off' && input.capped) notes.push('capped');
    // No window (every binding call past the flushed end): nothing was scanned, and nothing to show yet. A scan the
    // budget overtook, or one that couldn't read a subagent launched in the window, is partial.
    const facts: FactsStatus = failed ? (cut.status as FactsStatus) : windowFound && scanned?.complete === true ? 'scanned' : 'partial';
    const own = { session: cut.session === '' ? null : cut.session, context: cut.context === '' ? null : cut.context };
    // Events count over the span the transcript scan covers: the window, from the prompt opening its first turn.
    const since = windowFound ? Date.parse(cut.window!.start.at) : this.eventsSince();
    const reads = [...(scanned?.reads ?? []), ...this.eventReads(since, scanned?.launched ?? new Set(), own)];
    const text = excerpt === 'cut' && windowFound ? cut.excerpt : null;
    return {
      client: cut.client.name,
      client_version: cut.client.version,
      reader_version: failed && cut.lines.read === 0 ? null : cut.reader.version,
      session: cut.session === '' ? null : cut.session,
      context: cut.context === '' ? null : cut.context,
      source,
      window_start: windowFound ? cut.window!.start : null,
      window_end: windowFound ? cut.window!.end : null,
      steps: cut.counts.stepsInWindow,
      steps_kept: text === null ? 0 : cut.counts.stepsKept,
      characters: text === null ? 0 : cut.counts.characters,
      excerpt,
      excerpt_notes: notes,
      facts,
      skills_read: byTime(reads),
      commits: scanned?.commits ?? [],
      reach: cut.reach,
      cut_at: input.call.at,
      roots: roots.map(this.rewrite),
      text,
      extra: {},
    };
  }

  /**
   * A record with no transcript read (spec §14: generic clients, `none`
   * mode): facts from this context's `skill_read` events only, reaching the
   * latest event's time plus the event count.
   */
  private factsOnly(excerpt: 'off' | 'no_transcript'): SessionRecord {
    const { input, target } = this;
    const since = this.eventsSince();
    const ended = Date.parse(input.call.at);
    const events = input.skillReads.filter((event) => {
      const at = Date.parse(event.at);
      return at >= since && at <= ended && sessionKey(event.actor as Actor) === target.key;
    });
    const latest = events.reduce<string | null>((last, event) => (last === null || Date.parse(event.at) > Date.parse(last) ? event.at : last), null);
    return {
      ...emptyRecord(target, input.call.at),
      excerpt,
      excerpt_notes: excerpt === 'off' && input.capped ? ['capped'] : [],
      facts: 'events_only',
      skills_read: byTime(this.eventReads(since, new Set(), { session: target.session, context: target.context })),
      reach: latest === null ? null : { at: latest, ref: String(events.length) },
    };
  }
}

/**
 * Where a context's `skill_read` events start counting when no window says
 * which turn its work began in (epoch ms): when the attempt opened, for a
 * context bound later. The context that opened it may have read a skill in
 * the turn before its claim, and an unclaimed close's attempt opens only at
 * the close: theirs count from the context's previous ending, the issue's
 * previous attempt's end, or the issue's creation, whichever came last.
 */
function eventFloor(input: EndCaptureInput, key: string): number {
  const { attempt, view } = input;
  const ended = Date.parse(input.call.at);
  if (attempt !== null && sessionKey(attempt.start.actor as Actor) !== key) return Date.parse(attempt.start.at);
  let floor = Date.parse(view.issue(input.issue)?.created_at ?? '');
  if (!Number.isFinite(floor)) floor = -Infinity;
  for (const other of view.allAttempts()) {
    if (other.end === null || other.id === attempt?.id) continue;
    if (other.issue !== input.issue && !other.sessions.has(key)) continue;
    const at = Date.parse(other.end.at);
    if (at > floor && at <= ended) floor = at;
  }
  return attempt === null ? floor : Math.min(floor, Date.parse(attempt.start.at));
}

function emptyRecord(target: Target, cutAt: string): SessionRecord {
  return {
    client: clientFamily(target.client),
    client_version: null,
    reader_version: null,
    session: target.session,
    context: target.context,
    source: target.source,
    window_start: null,
    window_end: null,
    steps: 0,
    steps_kept: 0,
    characters: 0,
    excerpt: 'not_found',
    excerpt_notes: [],
    facts: 'not_found',
    skills_read: [],
    commits: [],
    reach: null,
    cut_at: cutAt,
    roots: [],
    text: null,
    extra: {},
  };
}

/** A context this machine has no row for, so didn't cut: kept only when no pending record holds it. */
function placeholder(target: Target, cutAt: string): SessionRecord {
  return emptyRecord(target, cutAt);
}

/** A context the cut couldn't reach within its budget. */
function budgetRecord(target: Target, cutAt: string): SessionRecord {
  return { ...emptyRecord(target, cutAt), excerpt: 'budget', facts: 'budget' };
}

function latestAt(calls: readonly BindingCall[]): string | undefined {
  let best: string | undefined;
  for (const { at } of calls) if (best === undefined || Date.parse(at) > Date.parse(best)) best = at;
  return best;
}

function earliestAt(calls: readonly BindingCall[]): string | undefined {
  let best: string | undefined;
  for (const { at } of calls) if (best === undefined || Date.parse(at) < Date.parse(best)) best = at;
  return best;
}

/**
 * Seals the fresh captures into the ending commit (spec §14 At the seal), in
 * the compare-and-set round, while the attempt is still open: per context, the
 * further-reaching of the fresh cut and the pending record; with neither, the
 * fresh placeholder naming why. A fresh cut replaces a pending record only if
 * it succeeded and reaches strictly further; a pending record kept over this
 * machine's cut is noted `source: pending`. A purged record is never written,
 * and in a mode that commits no text none is written. Returns the session keys
 * written.
 */
export async function sealSessionRecords(
  draft: TrackerDraft,
  handle: string,
  captures: readonly ContextCapture[],
  mode: CaptureMode,
): Promise<string[]> {
  if (draft.attempt(handle)?.end !== null) return [];
  const written: string[] = [];
  const put = (key: string, record: SessionRecord) => {
    draft.putSessionRecord(handle, key, serializeSessionRecord(mode === 'excerpts' ? record : withoutText(record)));
    written.push(key);
  };
  const purged = await draft.purgedSessions(handle);
  for (const capture of captures) {
    if (purged.has(capture.key)) continue;
    const stored = await draft.sessionRecord(handle, capture.key);
    const pending = stored === null ? null : parseSessionRecord(stored);
    if (pending === null) put(capture.key, capture.record);
    else if (!capture.cut) continue;
    else if (replaces(capture.record, pending)) put(capture.key, capture.record);
    // The pending record reaches further than this cut, or this cut failed: the seal keeps it, noted.
    else if (!pending.excerpt_notes.includes('source: pending')) {
      put(capture.key, { ...pending, excerpt_notes: [...pending.excerpt_notes, 'source: pending'] });
    }
  }
  return written;
}

/** Reads in the order they were made; reads made at the same instant keep their order. */
function byTime(reads: readonly SkillRead[]): SkillRead[] {
  return [...reads].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
