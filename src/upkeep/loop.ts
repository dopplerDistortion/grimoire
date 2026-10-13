// Upkeep in a long-lived process (spec §13 Where it runs): `grimoire mcp`
// runs a pass after the handshake and then every 30 min; `start` runs it at
// launch and on its timers. Passes never overlap within a process, run on
// the side of whatever else the process does, and keep no handle open: the
// timer is unref'd, so a server whose client is gone still exits.
import { runUpkeep, type UpkeepOptions, type UpkeepReport } from './run';

/** How often a long-lived process runs a pass. */
export const UPKEEP_EVERY_MS = 30 * 60_000;

export interface UpkeepLoopOptions extends Omit<UpkeepOptions, 'force' | 'signal'> {
  /** The time between passes (default 30 min). */
  readonly everyMs?: number;
  /** Each pass's report, as it finishes. */
  readonly onReport?: (report: UpkeepReport) => void;
}

export interface UpkeepLoop {
  /** Runs a pass after the one running now, if any; `force` ignores the throttles (a decision). */
  trigger(options?: { readonly force?: boolean }): Promise<UpkeepReport>;
  /** Runs no more passes, and waits up to `waitMs` (default 5 s) for the part running now to finish. */
  stop(waitMs?: number): Promise<void>;
}

const EMPTY: UpkeepReport = { runs: [], notices: [] };

/** Starts the loop: the first pass begins at once, on the side; the caller never awaits it. */
export function startUpkeep(options: UpkeepLoopOptions): UpkeepLoop {
  const { everyMs = UPKEEP_EVERY_MS, onReport, ...upkeep } = options;
  const abort = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const pass = (force: boolean): Promise<UpkeepReport> => {
    if (abort.signal.aborted) return Promise.resolve(EMPTY);
    const next = chain.then(async () => {
      if (abort.signal.aborted) return EMPTY;
      const report = await runUpkeep({ ...upkeep, force, signal: abort.signal }).catch(() => EMPTY);
      try {
        onReport?.(report);
      } catch {
        // A reporter's failure is never upkeep's.
      }
      return report;
    });
    chain = next.catch(() => {});
    return next;
  };
  const schedule = () => {
    if (abort.signal.aborted) return;
    timer = setTimeout(() => {
      void pass(false).finally(schedule);
    }, everyMs);
    timer.unref();
  };

  void pass(false).finally(schedule);
  return {
    trigger: (opts = {}) => pass(opts.force === true),
    async stop(waitMs = 5_000) {
      abort.abort();
      if (timer) clearTimeout(timer);
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([chain, new Promise<void>((resolve) => (wait = setTimeout(resolve, waitMs)))]);
      clearTimeout(wait);
    },
  };
}
