// Capture at attempt end (spec §14 Cut at attempt end, Pending session
// records, Roots, Statuses): the ending call cuts every bound context that ran
// on this machine, within a hard budget, before its one tracker commit; the
// commit then seals one session record per bound context. Capture problems
// become statuses, never errors.
import os from 'node:os';
import type { Actor, ReservedHint } from '../core/context';
import type { MachineLocalStore } from '../machine-local';
import type { SecretScanner } from '../scanner';
import type { AttemptRecord, TrackerDraft, TrackerView } from '../tracker';
import type { Reach } from '../tracker/fold-records';
import { boundContexts, readBindings } from './bindings';
import { cutClaudeCode, readClaudeCodeTranscript } from './claude-code';
import { defaultClaudeConfigDir, findClaudeTranscript } from './claude-code/roots';
import { cutCodex } from './codex';
import { defaultCodexHome } from './codex/roots';
import { emptyCut, type BindingCall, type Cut, type CutEvidence } from './cut';
import type { EvidenceSource } from './evidence';
import { pathRewriter, type PathSpellings } from './paths';
import { clientFamily, contextOf, seenHereRows, sessionKey, type SeenHereRow } from './seen-here';
import {
  cutSucceeded,
  parseSessionRecord,
  replaces,
  serializeSessionRecord,
  type FactsStatus,
  type RecordExcerptStatus,
  type RecordNote,
  type SessionRecord,
} from './session-record';
import { isCall } from './steps';
import { revealedRoot } from './transcript-roots';

/** The excerpt mode (spec §14 The setting): `excerpts`, `facts` or `none`. */
export type CaptureMode = 'excerpts' | 'facts' | 'none';

/** The cut's hard budget (spec §14: 10 s). */
export const CUT_BUDGET_MS = 10_000;
/** How long the calling context waits for its ending call to reach its transcript (spec §14: 2 s). */
export const FLUSH_WAIT_MS = 2_000;
const FLUSH_POLL_MS = 100;

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
  /** Whether it binds (an abandoned release and a reopen's supersede don't): its context is then cut too. */
  readonly binds: boolean;
  /** When it ends the attempt (ISO 8601): the window's end. */
  readonly at: string;
}

/** A `skill_read` event as the machine-local store keeps it (spec §6). */
export interface SkillReadEvent {
  readonly at: string;
  readonly actor: Readonly<Record<string, unknown>>;
}

export interface EndCaptureInput {
  /** Where git runs to read the binding trailers. */
  readonly repoRoot: string;
  /** The worktree the ending call came from: rewritten to `<repo>`. */
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
  readonly row: boolean;
  readonly calling: boolean;
}

/**
 * Cuts the attempt's bound contexts (spec §14, step 2): the calling context
 * first, then the contexts with no pending record, then the rest; only
 * contexts with a seen-here row here, and the calling context, are cut. The
 * whole cut stays within the budget: a context it can't reach in time gets
 * `budget`. Contexts whose record a human purged are skipped.
 */
export async function captureAtEnd(input: EndCaptureInput): Promise<ContextCapture[]> {
  const started = Date.now();
  const deadline = started + (input.options?.budgetMs ?? CUT_BUDGET_MS);
  const handle = input.attempt?.id ?? null;
  // Which contexts are bound, and which hold a pending record or a purge, is read in full: the budget bounds the cuts.
  const targets = await targetsOf(input);
  const pending = new Set<string>();
  const purged = handle === null ? new Set<string>() : await input.view.purgedSessions(handle).catch(() => new Set<string>());
  if (handle !== null) {
    for (const target of targets) {
      if ((await input.view.sessionRecord(handle, target.key).catch(() => null)) !== null) pending.add(target.key);
    }
  }
  const rank = (t: Target) => (t.calling ? 0 : pending.has(t.key) ? 2 : 1);
  const ordered = [...targets].sort((a, b) => rank(a) - rank(b));

  const captures: ContextCapture[] = [];
  const claimed: string[] = [];
  const cutAt = input.call.at;
  for (const target of ordered) {
    if (purged.has(target.key)) continue;
    if (!target.calling && !target.row) {
      captures.push({ key: target.key, record: placeholder(target, cutAt), cut: false, row: false });
      continue;
    }
    const cut = new ContextCut(input, target, deadline, claimed);
    const record = Date.now() >= deadline ? null : await beforeDeadline(target.calling ? cut.waitingForFlush(started) : cut.once(), deadline, null);
    const captured = record ?? budgetRecord(target, cutAt);
    if (cut.callIds) claimed.push(...cut.callIds);
    captures.push({ key: target.key, record: captured, cut: true, row: target.row });
  }
  return captures;
}

/** The bound contexts, and the calling context when its ending call binds. */
async function targetsOf(input: EndCaptureInput): Promise<Target[]> {
  const { call } = input;
  const rows: SeenHereRow[] = input.attempt ? await seenHereRows(input.store, { handle: input.attempt.id }).catch(() => []) : [];
  const bindings = input.attempt ? await readBindings(input.repoRoot, input.attempt, [input.view.tip]).catch(() => []) : [];
  const targets: Target[] = boundContexts(bindings, rows).map((context) => {
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
      row: context.row !== null,
      calling: false,
    };
  });
  if (!call.binds) return targets;

  // The ending call's own binding write isn't committed yet: the cut looks for it from what this process saw.
  const actor = call.actor;
  const key = sessionKey(actor);
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
    row: known?.row ?? false,
    calling: true,
  };
  if (index >= 0) targets.splice(index, 1);
  return [calling, ...targets];
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

/** Cutting one context: locating its transcript, the cut, and the record it gives. */
class ContextCut {
  /** The call ids its window holds, once cut: no later excerpt of the trace may hold them. */
  callIds: readonly string[] | null = null;
  private readonly rewrite: (text: string) => string;
  private readonly paths: PathSpellings;

  constructor(
    private readonly input: EndCaptureInput,
    private readonly target: Target,
    private readonly deadline: number,
    private readonly claimed: readonly string[],
  ) {
    const home = input.options?.home ?? os.homedir();
    this.paths = { home, repo: input.worktree, ...(process.platform === 'win32' ? { tmp: os.tmpdir() } : {}) };
    this.rewrite = pathRewriter(this.paths);
  }

  /** The calling context: cut again until its ending call reached the transcript, for up to the flush wait. */
  async waitingForFlush(started: number): Promise<SessionRecord> {
    const until = Math.min(started + (this.input.options?.flushWaitMs ?? FLUSH_WAIT_MS), this.deadline);
    let record = await this.once();
    while (record.excerpt_notes.includes('tail_unflushed') && Date.now() + FLUSH_POLL_MS <= until) {
      await sleep(FLUSH_POLL_MS);
      record = await this.once();
    }
    return record;
  }

  async once(): Promise<SessionRecord> {
    const { input, target } = this;
    const family = clientFamily(target.client);
    if (input.mode === 'none') return this.factsOnly('off');
    if (family !== 'claude-code' && family !== 'codex') return this.factsOnly('no_transcript');
    try {
      const { cut, roots, source } = family === 'claude-code' ? await this.cutClaude() : await this.cutCodex();
      this.callIds = cut.callIds;
      return this.fromCut(cut, source, roots);
    } catch {
      return this.fromCut(
        emptyCut({ client: { name: family, version: null }, reader: { version: 0 }, session: target.session ?? '', context: target.context ?? '' }, 'unreadable'),
        target.source,
        [],
      );
    }
  }

  private evidence(extra: readonly BindingCall[] = []): CutEvidence {
    const { input, target } = this;
    return {
      issue: input.issue,
      attemptOpenedAt: input.attempt?.start.at ?? input.call.at,
      attemptEndedAt: input.call.at,
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
  private async cutClaude(): Promise<{ cut: Cut; roots: string[]; source: EvidenceSource | null }> {
    const { input, target } = this;
    const configDir = input.options?.claudeConfigDir ?? defaultClaudeConfigDir();
    const projects = `${configDir.replace(/[\\/]+$/, '')}${configDir.includes('\\') ? '\\' : '/'}projects`;
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
      const hinted = await findClaudeTranscript({ ...base, session: hint.session_id, revealed: await revealed(hint.session_id) });
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
        location = await findClaudeTranscript({ ...base, session, revealed: await revealed(session) });
      } else if (ids.length > 0) {
        location = await findClaudeTranscript({ ...base, callIds: ids, ...(earliestAt(target.bindingCalls) ? { calledAt: earliestAt(target.bindingCalls)! } : {}) });
        if (location.status === 'found') {
          session = location.session;
          agentId = location.agentId;
          source ??= 'tool-use-id';
        }
      } else if (target.spawnEnv !== null) {
        session = target.spawnEnv;
        source = 'spawn-env';
        location = await findClaudeTranscript({ ...base, session, revealed: await revealed(session) });
      }
    }
    const identity = {
      client: { name: 'claude-code', version: null },
      reader: { version: 1 },
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
    return { cut, roots: cut.status === 'not_found' ? [location.transcript] : [], source };
  }

  /** A Codex context: its thread's own transcript, searched by thread id in the hook-revealed home, else the default one. */
  private async cutCodex(): Promise<{ cut: Cut; roots: string[]; source: EvidenceSource | null }> {
    const { input, target } = this;
    const revealed = target.session !== null ? await revealedRoot(input.store, target.session).catch(() => undefined) : undefined;
    const codexHome = (revealed?.client === 'codex' ? revealed.root : undefined) ?? input.options?.codexHome ?? defaultCodexHome();
    if (target.context === null) {
      const identity = { client: { name: 'codex', version: null }, reader: { version: 1 }, session: target.session ?? '', context: '' };
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
    return { cut, roots: cut.status === 'not_found' ? [codexHome] : [], source: target.source };
  }

  private fromCut(cut: Cut, source: EvidenceSource | null, roots: readonly string[]): SessionRecord {
    const { input } = this;
    const windowFound = cut.window !== null;
    const failed = cut.status === 'not_found' || cut.status === 'unreadable' || cut.status === 'unmatched' || cut.status === 'budget';
    const excerpt: RecordExcerptStatus = failed || input.mode === 'excerpts' ? cut.status : 'off';
    const notes: RecordNote[] = [...cut.notes];
    if (excerpt === 'off' && input.capped) notes.push('capped');
    const facts: FactsStatus = failed ? (cut.status as FactsStatus) : 'scanned';
    // No window (every binding call past the flushed end): nothing to show yet.
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
      skills_read: [],
      commits: [],
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
    const opened = Date.parse(input.attempt?.start.at ?? input.call.at);
    const ended = Date.parse(input.call.at);
    const events = input.skillReads.filter((event) => {
      const at = Date.parse(event.at);
      return at >= opened && at <= ended && sessionKey(event.actor as Actor) === target.key;
    });
    const latest = events.reduce<string | null>((last, event) => (last === null || Date.parse(event.at) > Date.parse(last) ? event.at : last), null);
    return {
      ...emptyRecord(target, input.call.at),
      excerpt,
      excerpt_notes: excerpt === 'off' && input.capped ? ['capped'] : [],
      facts: 'events_only',
      reach: latest === null ? null : { at: latest, ref: String(events.length) },
    };
  }
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
 * it succeeded and reaches strictly further. A purged record is never written,
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
    else if (!cutSucceeded(capture.record) && !pending.excerpt_notes.includes('source: pending')) {
      put(capture.key, { ...pending, excerpt_notes: [...pending.excerpt_notes, 'source: pending'] });
    }
  }
  return written;
}

/** A record as a mode that commits no excerpt text keeps it. */
function withoutText(record: SessionRecord): SessionRecord {
  if (record.text === null) return record;
  return { ...record, text: null, excerpt: 'off', steps_kept: 0, characters: 0 };
}

/** The reach a written record holds, for the row's last-cut note. */
export function reachOf(capture: ContextCapture): Reach | null {
  return cutSucceeded(capture.record) ? capture.record.reach : null;
}
