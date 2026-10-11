// The detached sync child (spec §4, Where it runs; §22 R4): a CLI write can't
// sync in its own short-lived process, so it spawns `grimoire sync
// --background`, which registers a process record, runs one automatic sync
// and exits. Spike E: `codex exec` waits for such a child, so it stays short;
// spike F: some Codex sandboxes kill it, so the sync-pending marker the core
// set first is what makes the push happen eventually.
import { spawn } from 'node:child_process';
import { MachineLocalStore } from '../machine-local';
import { openTracker, type SyncOutcome } from '../tracker';
import { VERSION } from '../version';
import { actorOf, type CallContext } from './context';
import { autoSync, syncRequestOf, type AutoSyncRequest, type SyncSkip } from './sync';

/** How to start the child: for the CLI, `process.execPath` and `[<grimoire.mjs>, 'sync', '--background']`. */
export interface SyncChildCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The core's `autoSync` for short-lived processes: spawns the detached sync
 * child in the host repo root (`windowsHide`, never a shell) and lets go of it.
 */
export function spawnedAutoSync(child: SyncChildCommand): (request: AutoSyncRequest) => void {
  return (request) => {
    const spawned = spawn(child.command, [...child.args], {
      cwd: request.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    // A child that can't start leaves the marker for upkeep, like one that dies.
    spawned.on('error', () => {});
    spawned.unref();
  };
}

export interface BackgroundSyncOptions {
  /** Where the PATH that found `node` came from, for the process record. */
  readonly pathSource?: string | null;
}

/**
 * The body of `grimoire sync --background`: registers this process (role
 * `sync`), runs one automatic sync of the host repo, and unregisters. Never
 * throws for a sync that fails: that is recorded in the sync status.
 */
export async function runBackgroundSync(
  ctx: CallContext,
  options: BackgroundSyncOptions = {},
): Promise<SyncOutcome | { skipped: SyncSkip }> {
  const tracker = await openTracker(ctx.repo.root);
  const actor = actorOf(ctx);
  const registration = await new MachineLocalStore(tracker.location.commonDir).processes
    .register({
      role: 'sync',
      client: actor.client ?? null,
      worktree: ctx.repo.root,
      pin: ctx.repo.pin ?? VERSION,
      pathSource: options.pathSource ?? null,
    })
    .catch(() => null);
  try {
    return await autoSync(tracker, syncRequestOf(ctx, actor));
  } finally {
    await registration?.unregister().catch(() => {});
    await tracker.close();
  }
}
