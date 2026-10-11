// Core operations (spec §2.1): the single registry of every operation behind
// every surface. A call takes a call context and returns a result or an error
// envelope; an error means nothing changed.
import { GrimoireError, type ErrorBody } from '../errors';
import { openTracker, type TrackerStore } from '../tracker';
import { actorOf, type CallContext } from './context';
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
import { checkSurface } from './op';
import { bundledRules, createScanner, type SecretScanner } from '../scanner';
import { parseInput } from './schema';
import { completeUpgradeDetails } from './upgrade';
import { autoSync as runAutoSync, markSyncPending, sync, syncRequestOf, syncStatus, type AutoSyncRequest } from './sync';
import { INSTALL_FORMAT_RANGE } from './host';
import { findGitDirs } from '../machine-local/git-dirs';
import { VERSION } from '../version';

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
export type { AutoSyncRequest, SyncResult, SyncStatusResult, SyncRequest, SyncSkip, SyncStatusRecord } from './sync';
export { AUTO_SYNC_SETTING, autoSync, markSyncPending, syncNow, syncRequestOf } from './sync';
export { runBackgroundSync, spawnedAutoSync, type SyncChildCommand, type BackgroundSyncOptions } from './background-sync';
export type { ErrorBody, ErrorCode } from '../errors';

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

/**
 * The tracker an op writes through: every commit that seals an attempt asks
 * for the automatic sync itself (spec §4: every attempt-ending write), so no
 * op that ends attempts can forget to.
 */
function syncingOnSeal(tracker: TrackerStore, requestSync: (commit: string) => void): TrackerStore {
  return {
    location: tracker.location,
    read: () => tracker.read(),
    now: () => tracker.now(),
    async transact(spec, body) {
      const write = await tracker.transact(spec, body);
      if (write.commit && write.sealed) requestSync(write.commit);
      return write;
    },
    initialize: (spec, options) => tracker.initialize(spec, options),
    fold: (spec) => tracker.fold(spec),
    sync: (spec) => tracker.sync(spec),
    close: () => tracker.close(),
  };
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
      await inLane(commonDir, () => runAutoSync(tracker, request));
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
        const result = await op.run(parsed, {
          ctx,
          tracker: syncingOnSeal(opened, requestSync),
          actor: actorOf(ctx),
          scanner,
          requestSync,
        });
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
