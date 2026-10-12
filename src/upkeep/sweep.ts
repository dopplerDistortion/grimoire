// The excerpt sweep as an upkeep part (spec §13, §14 Sweeps): at every
// `grimoire mcp` start, every `start` launch and every `init`, and every 30 min
// in long-lived processes. Its lease (`upkeep-excerpt-sweep`) makes it one
// sweep at a time per live store; it never delays a tool call, and an
// attempt-ending call in the same process cancels it.
import { seenHereRows } from '../capture/seen-here';
import { sweepContexts, type SweepOptions } from '../core/sweep';
import type { Json } from '../machine-local';
import { openTracker } from '../tracker';
import type { UpkeepPart } from './run';

export type { SweepOptions } from '../core/sweep';

/** The part's name: its lease is `upkeep-excerpt-sweep`. */
export const SWEEP_PART = 'excerpt-sweep';

/**
 * The sweep part. Two processes starting within a minute of each other sweep
 * once between them (the clone-wide stamp); the 30-min timer always finds it
 * due.
 */
export function excerptSweep(options: SweepOptions = {}): UpkeepPart {
  return {
    name: SWEEP_PART,
    scope: 'clone',
    intervalMs: 60_000,
    async run({ store, root, context }) {
      // No binding seen here: nothing to cut, and no tracker to open.
      if ((await seenHereRows(store)).length === 0) return { result: { rows: 0 } };
      const tracker = await openTracker(root);
      try {
        const report = await sweepContexts(tracker, store, context, options);
        return { result: { ...report } as { [key: string]: Json } };
      } finally {
        await tracker.close();
      }
    },
  };
}
