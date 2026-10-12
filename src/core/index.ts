// Core operations (spec §2.1): the single registry of every operation behind
// every surface. A call takes a call context and returns a result or an error
// envelope; an error means nothing changed.
import { GrimoireError, type ErrorBody } from '../errors';
import { openTracker, type TrackerStore } from '../tracker';
import { actorOf, type Actor, type CallContext } from './context';
import { observedEvidence } from '../capture/evidence';
import { recordSeenHere } from '../capture/seen-here';
import { MachineLocalStore } from '../machine-local/store';
import { create, labels, type OpDefinition, type OpResults, type SurfacePolicy } from './ops';
import { show } from './show';
import { comment } from './comment';
import { list } from './list';
import { update } from './update';
import { claim, close, release } from './attempts';
import { assign, deleteIssue, outcomeSet, reassign, reopen } from './human-ops';
import { resolve } from './resolve';
import { settingsGet, settingsSet } from './settings';
import { skillEdit, skillList, skillRead, skillShow } from './skills';
import { wikiEdit, wikiList, wikiShow } from './wiki';
import { quarantine, unquarantine } from './quarantine';
import { choreAbandon, choreRead, choreStart, exposedActor, refuseChoreContext, withContextLock } from './chores';
import { choreSubmit } from './chore-submit';
import { checkSurface } from './op';
import { bundledRules, createScanner, type SecretScanner } from '../scanner';
import { parseInput } from './schema';
import { completeUpgradeDetails } from './upgrade';
import { autoSync as runAutoSync, markSyncPending, sync, syncRequestOf, syncStatus, type AutoSyncRequest } from './sync';
import { INSTALL_FORMAT_RANGE } from './host';
import { findGitDirs } from '../machine-local/git-dirs';
import { readServedFingerprint } from '../generated/served';
import { VERSION } from '../version';
import type { CaptureOptions } from '../capture/end';

export type {
  CallContext,
  Surface,
  HostRepo,
  Identity,
  ClientInfo,
  Evidence,
  Actor,
  ReservedHint,
  McpCallFacts,
} from './context';
export { findHostRoot, readCheckoutConfig, readPerson, INSTALL_FORMAT_RANGE, type CheckoutConfig } from './host';
export type { OpResults, CreateResult, ShowResult, LabelsResult, SurfacePolicy } from './ops';
export type { UpdateResult, Noop } from './update';
export type { CommentResult } from './comment';
export type { ListResult, ListRow } from './list';
export type { RelatedIssue, ShownComment } from './show';
export type { IssueConflict } from './derive';
export type { Remedy } from './upgrade';
export type { AssignResult, ReassignResult, ReopenResult, Reblocked, DeleteResult, OutcomeSetResult } from './human-ops';
export type { ResolveResult } from './resolve';
export type { SettingsResult, SettingsSetResult, ShownSetting, SettingScope } from './settings';
export type { SkillListResult, SkillReadResult, SkillEditResult, SkillShowResult, ShownSkill, ShownChange, SkillProvenance, SkillOrigin } from './skills';
export type { WikiEditResult, WikiListResult, WikiListRow, WikiShowResult, ShownSide } from './wiki';
export type { QuarantineResult } from './quarantine';
export type { ChoreBrief, ChoreReadResult, ChoreAbandonResult } from './chores';
export type { ChoreSubmitResult } from './chore-submit';
export { choreThresholds, dueChores } from './chores';
export type { AutoSyncRequest, SyncResult, SyncStatusResult, SyncRequest, SyncSkip, SyncStatusRecord } from './sync';
export { AUTO_SYNC_SETTING, autoSync, autoSyncOn, markSyncPending, readSyncStatus, syncNow, syncRequestOf } from './sync';
export { runBackgroundSync, spawnedAutoSync, type SyncChildCommand, type BackgroundSyncOptions } from './background-sync';
export type { ErrorBody, ErrorCode } from '../errors';
export { traceCapture, captureMode, type TraceCapture, type CaptureEntry } from './capture';
export type { CaptureOptions } from '../capture/end';

export type Outcome<R> = { ok: true; result: R } | { ok: false; error: ErrorBody };

/** What a surface needs to expose an op (tool listing, CLI help, API routing). */
export interface OpDescriptor {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly policy: SurfacePolicy;
  /** Whether the MCP server lists it as a tool: agent ops only, and not every one of them. */
  readonly mcp: boolean;
  /** JSON Schema of the op's input. */
  readonly inputSchema: Record<string, unknown>;
  /** MCP annotations (spec §8). */
  readonly annotations: Readonly<Record<string, boolean>>;
}

export interface CoreOptions {
  readonly clock?: () => Date;
  /** Draws an issue id suffix of the given length (default: crypto-random Crockford). */
  readonly randomIdSuffix?: (length: number) => string;
  /** How long one write may keep retrying before BUSY (default ~10 s). */
  readonly writeBudgetMs?: number;
  /** The secret scanner for debriefs (default: the bundled rules). */
  readonly scanner?: SecretScanner;
  /**
   * How the automatic sync runs after the writes that trigger it (spec §4,
   * Where it runs):
   * - `in-process` (default): long-lived processes (`grimoire mcp`,
   *   `start`) sync here, after the call answers;
   * - a function: called after the sync-pending marker is set, for example
   *   the CLI's spawn of a detached `grimoire sync --background`;
   * - `off`: neither marks nor syncs (tests, tools that must stay offline).
   */
  readonly autoSync?: 'in-process' | 'off' | ((request: AutoSyncRequest) => void | Promise<void>);
  /**
   * Where attempt-end capture finds transcripts and how long it may take
   * (spec §14): the Claude Code and Codex folders, the home folder rewritten
   * to `~`, the 10 s cut budget and the 2 s flush wait. Defaults: the clients'
   * own folders and the spec's budgets.
   */
  readonly capture?: CaptureOptions;
  /**
   * How this process refreshes generated output after a write changed the
   * served set (spec §15 Refresh scope):
   * - `in-process` (default): the skill reconcile of every worktree on this
   *   pin runs here, after the call answers (`close()` waits for it), as a
   *   short-lived CLI call needs;
   * - a function: long-lived processes trigger their upkeep loop, forced;
   * - `off`: no refresh (upkeep catches up on its own schedule).
   */
  readonly refreshSkills?: 'in-process' | 'off' | ((request: RefreshRequest) => void | Promise<void>);
}

/** What a custom refresh is handed: the call that changed the served set. */
export interface RefreshRequest {
  /** The host repo root of the call. */
  readonly root: string;
  readonly ctx: CallContext;
}

export interface Core {
  /** Every op, in registry order. */
  readonly ops: readonly OpDescriptor[];
  /**
   * Runs op `name`. Expected failures come back as `{ok: false, error}` and
   * mean nothing changed; only bugs throw.
   */
  call<N extends string>(
    name: N,
    input: unknown,
    ctx: CallContext,
  ): Promise<Outcome<N extends keyof OpResults ? OpResults[N] : unknown>>;
  /**
   * Waits for the background syncs (or spawns of the sync child) this core
   * started, then releases the git processes it holds open. A surface awaits
   * it before its process exits; the sync-pending markers are set either way.
   */
  close(): Promise<void>;
}

const REGISTRY: readonly OpDefinition<unknown, unknown>[] = [
  show,
  list,
  labels,
  skillList,
  skillRead,
  create,
  update,
  comment,
  claim,
  release,
  close,
  settingsGet,
  assign,
  reassign,
  reopen,
  deleteIssue,
  resolve,
  outcomeSet,
  settingsSet,
  skillShow,
  skillEdit,
  wikiList,
  wikiShow,
  wikiEdit,
  quarantine,
  unquarantine,
  choreStart,
  choreRead,
  choreSubmit,
  choreAbandon,
  sync,
  syncStatus,
];

/**
 * The checkout's `install_format` must lie in this release's J..K (spec §5):
 * otherwise UPGRADE_REQUIRED, marker `install`, requiring the checkout's pin.
 * One that isn't a whole number was written by something newer.
 */
function checkInstallFormat(format: number | null, pin: string | null): void {
  const { J, K } = INSTALL_FORMAT_RANGE;
  if (format === null || (format >= J && format <= K)) return;
  const why = format < J ? 'older' : 'newer';
  const shown = Number.isNaN(format) ? 'an unreadable install_format' : `install_format ${format}`;
  throw new GrimoireError(
    'UPGRADE_REQUIRED',
    `this checkout's .grimoire/config.yml has ${shown}, which grimoire ${VERSION} can't run against${pin ? ` (the checkout pins ${pin})` : ''}; stop grimoire work and relay the remedies to the user`,
    { marker: 'install', why, requires: pin },
  );
}

/** A binding write an op made: a commit naming an attempt's handle (spec §14 Binding). */
interface BindingWrite {
  readonly handle: string;
  readonly issue: string;
}

/**
 * The tracker an op writes through. Every commit that seals an attempt asks
 * for the automatic sync itself (spec §4: every attempt-ending write), and
 * every commit that names a handle is a binding write, whose seen-here row
 * the core leaves once the op is done (spec §14): no op can forget either.
 */
function watched(tracker: TrackerStore, requestSync: (commit: string) => void, bindings: BindingWrite[]): TrackerStore {
  return {
    location: tracker.location,
    read: () => tracker.read(),
    tips: () => tracker.tips(),
    now: () => tracker.now(),
    async transact(spec, body) {
      const write = await tracker.transact(spec, body);
      if (write.commit && write.sealed) requestSync(write.commit);
      if (write.commit && write.attempt && write.issue) bindings.push({ handle: write.attempt, issue: write.issue });
      return write;
    },
    initialize: (spec, options) => tracker.initialize(spec, options),
    fold: (spec) => tracker.fold(spec),
    sync: (spec) => tracker.sync(spec),
    close: () => tracker.close(),
  };
}

/**
 * After the binding writes' refs moved (spec §14 Seen-here rows): one row per
 * attempt and context on this machine. Best effort: a row is only a hint, so
 * a store that can't take it never fails the call that already wrote.
 */
async function leaveSeenHereRows(tracker: TrackerStore, ctx: CallContext, actor: Actor, bindings: readonly BindingWrite[]): Promise<void> {
  try {
    const store = new MachineLocalStore(tracker.location.commonDir, ctx.repo.root);
    const { source, pendingHint } = observedEvidence(ctx);
    const at = tracker.now();
    for (const binding of bindings) {
      await recordSeenHere(store, { ...binding, actor, source, pendingHint, worktree: ctx.repo.root, at });
    }
  } catch {
    // The binding still stands: an id search finds the context without its row.
  }
}

function annotationsOf(op: OpDefinition<unknown, unknown>): Record<string, boolean> {
  if (op.kind === 'read') return { readOnlyHint: true };
  // Only the ending ops replay on their own arguments; the rest need an idempotency key (spec §8).
  return op.replay === 'attempt-and-reason'
    ? { destructiveHint: false, openWorldHint: false, idempotentHint: true }
    : { destructiveHint: false, openWorldHint: false };
}

export function createCore(options: CoreOptions = {}): Core {
  const ops = new Map(REGISTRY.map((op) => [op.name, op]));
  const trackers = new Map<string, Promise<TrackerStore>>();
  const scanner = options.scanner ?? createScanner(bundledRules);
  const autoSyncMode = options.autoSync ?? 'in-process';
  const refreshMode = options.refreshSkills ?? 'in-process';
  /** Background work started after a call answered: close() waits for it. */
  const background = new Set<Promise<void>>();
  /** Per clone: an in-process sync is running, and whether another write asked for one meanwhile. */
  const lanes = new Map<string, { again: boolean }>();

  const later = (task: () => Promise<void>): void => {
    const run: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch(() => {})
      .finally(() => background.delete(run));
    background.add(run);
  };

  /** Runs `task` for clone `key`, coalescing requests that arrive while one runs into one more run. */
  const inLane = async (key: string, task: () => Promise<unknown>): Promise<void> => {
    const running = lanes.get(key);
    if (running) {
      running.again = true;
      return;
    }
    const lane = { again: false };
    lanes.set(key, lane);
    try {
      do {
        lane.again = false;
        await task().catch(() => {});
      } while (lane.again);
    } finally {
      lanes.delete(key);
    }
  };

  /**
   * After a triggering write (spec §4): the sync-pending marker is set before
   * the call answers, so a process that exits or is killed right after still
   * leaves it; the sync itself runs after the call answers.
   */
  const afterWrite = async (tracker: TrackerStore, tip: string, ctx: CallContext): Promise<void> => {
    if (autoSyncMode === 'off') return;
    const { commonDir } = tracker.location;
    await markSyncPending(commonDir, tip).catch(() => {});
    later(async () => {
      if (typeof autoSyncMode === 'function') {
        await autoSyncMode({ root: ctx.repo.root, commonDir, tip, ctx });
        return;
      }
      const request = syncRequestOf(ctx, actorOf(ctx));
      await inLane(commonDir, async () => {
        const before = await readServedFingerprint(tracker, scanner);
        const outcome = await runAutoSync(tracker, request);
        // A fold that changed what agents are served: refresh this pin's worktrees (spec §15 Refresh scope).
        if ('fetched' in outcome && outcome.fetched && (await readServedFingerprint(tracker, scanner)) !== before) refresh(ctx);
      });
    });
  };

  /** After a write that changed the served set: the refresh runs after the call answers, never failing or delaying it. */
  const refresh = (ctx: CallContext): void => {
    if (refreshMode === 'off') return;
    later(async () => {
      if (typeof refreshMode === 'function') {
        await refreshMode({ root: ctx.repo.root, ctx });
        return;
      }
      const { refreshGeneratedOutput } = await import('../upkeep/refresh');
      await refreshGeneratedOutput({ root: ctx.repo.root, surface: ctx.surface, nonce: ctx.nonce });
    });
  };

  const trackerFor = (root: string): Promise<TrackerStore> => {
    let tracker = trackers.get(root);
    if (!tracker) {
      tracker = openTracker(root, {
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.randomIdSuffix ? { randomIdSuffix: options.randomIdSuffix } : {}),
        ...(options.writeBudgetMs !== undefined ? { budgetMs: options.writeBudgetMs } : {}),
      });
      tracker.catch(() => trackers.delete(root));
      trackers.set(root, tracker);
    }
    return tracker;
  };

  return {
    ops: REGISTRY.map((op) => ({
      name: op.name,
      description: op.description,
      kind: op.kind,
      policy: op.policy,
      mcp: op.policy === 'agent' && op.mcp !== false,
      inputSchema: op.input.json,
      annotations: annotationsOf(op),
    })),

    async call(name, input, ctx) {
      let tracker: TrackerStore | null = null;
      try {
        const op = ops.get(name);
        if (!op) throw new GrimoireError('INVALID', `there is no operation named ${name}`, { fields: { op: 'unknown' } });
        checkSurface(op, ctx);
        checkInstallFormat(ctx.repo.installFormat ?? null, ctx.repo.pin);
        const parsed = parseInput(op.input, input);
        const opened = await trackerFor(ctx.repo.root);
        tracker = opened;
        const syncTips: string[] = [];
        const requestSync = (commit: string): void => void syncTips.push(commit);
        const bindings: BindingWrite[] = [];
        let changedServed = false;
        let actor = actorOf(ctx);
        const agentWrite = op.kind === 'write' && actor.kind === 'agent';
        const store = agentWrite || op.name === choreStart.name ? new MachineLocalStore(opened.location.commonDir, ctx.repo.root) : null;
        const execute = async () => {
          if (agentWrite && store) {
            // Chore contexts never write issues; chore-exposed sessions and processes say so on every write (spec §8, §14).
            const now = opened.now();
            if (op.issueWrite) await refuseChoreContext(store, ctx, now);
            actor = await exposedActor(store, ctx, actor, now);
          }
          const result = await op.run(parsed, {
            ctx,
            tracker: watched(opened, requestSync, bindings),
            actor,
            scanner,
            requestSync,
            ...(options.capture ? { capture: options.capture } : {}),
            servedChanged: () => void (changedServed = true),
          });
          if (bindings.length > 0) await leaveSeenHereRows(opened, ctx, actor, bindings);
          return result;
        };
        // A chore start and a claim or issue write from one session never interleave (spec §16 Admission).
        const result = store && (op.name === choreStart.name || (agentWrite && op.issueWrite)) ? await withContextLock(store, ctx, execute) : await execute();
        if (changedServed) refresh(ctx);
        const syncTip = syncTips.at(-1);
        if (syncTip !== undefined) await afterWrite(opened, syncTip, ctx);
        return { ok: true, result } as never;
      } catch (error) {
        if (!(error instanceof GrimoireError)) throw error;
        const body = error.toBody();
        if (body.code === 'UPGRADE_REQUIRED') {
          // The install check fails before the tracker opens: find the common dir without it.
          const commonDir = tracker?.location.commonDir ?? (await findGitDirs(ctx.repo.root))?.commonDir ?? null;
          body.details = await completeUpgradeDetails(body.details, ctx, commonDir);
        }
        return { ok: false, error: body };
      }
    },

    async close() {
      while (background.size > 0) await Promise.all([...background]);
      const open = [...trackers.values()];
      trackers.clear();
      await Promise.all(open.map(async (tracker) => (await tracker.catch(() => null))?.close()));
    },
  };
}
