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
import { bundledRules, createScanner, type SecretScanner } from '../scanner';
import { parseInput } from './schema';
import { completeUpgradeDetails } from './upgrade';

export type {
  CallContext,
  Surface,
  HostRepo,
  Identity,
  ClientInfo,
  Evidence,
  Actor,
} from './context';
export type { OpResults, CreateResult, ShowResult, LabelsResult, SurfacePolicy } from './ops';
export type { UpdateResult, Noop } from './update';
export type { CommentResult } from './comment';
export type { ListResult, ListRow } from './list';
export type { RelatedIssue, ShownComment } from './show';
export type { Remedy } from './upgrade';
export type { ErrorBody, ErrorCode } from '../errors';

export type Outcome<R> = { ok: true; result: R } | { ok: false; error: ErrorBody };

/** What a surface needs to expose an op (tool listing, CLI help, API routing). */
export interface OpDescriptor {
  readonly name: string;
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly policy: SurfacePolicy;
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
  /** Releases the git processes the core holds open. */
  close(): Promise<void>;
}

const REGISTRY: readonly OpDefinition<unknown, unknown>[] = [
  show,
  list,
  labels,
  create,
  update,
  comment,
  claim,
  release,
  close,
];

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
      inputSchema: op.input.json,
      annotations: annotationsOf(op),
    })),

    async call(name, input, ctx) {
      let tracker: TrackerStore | null = null;
      try {
        const op = ops.get(name);
        if (!op) throw new GrimoireError('INVALID', `there is no operation named ${name}`, { fields: { op: 'unknown' } });
        const parsed = parseInput(op.input, input);
        tracker = await trackerFor(ctx.repo.root);
        const result = await op.run(parsed, { ctx, tracker, actor: actorOf(ctx), scanner });
        return { ok: true, result } as never;
      } catch (error) {
        if (!(error instanceof GrimoireError)) throw error;
        const body = error.toBody();
        if (body.code === 'UPGRADE_REQUIRED') {
          body.details = await completeUpgradeDetails(body.details, ctx, tracker?.location.commonDir ?? null);
        }
        return { ok: false, error: body };
      }
    },

    async close() {
      const open = [...trackers.values()];
      trackers.clear();
      await Promise.all(open.map(async (tracker) => (await tracker.catch(() => null))?.close()));
    },
  };
}
