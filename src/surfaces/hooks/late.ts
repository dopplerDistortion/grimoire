// Work a hook stopped waiting for at its budget (session-start's chore facts,
// spec §12): it may still be running git when the hook has answered. The
// clients give a hook 10 s and wait for its process to exit, so the process
// must not wait for that work either: `exitWith` (../entry.ts) ends it at once
// while any is left. Tiny on purpose: every verb's exit loads it.

const running = new Set<Promise<unknown>>();

/** Notes `work` as left running past the hook's budget; it is forgotten once it settles, and its failure is no unhandled rejection. */
export function leftRunning(work: Promise<unknown>): void {
  running.add(work);
  work.then(
    () => running.delete(work),
    () => running.delete(work),
  );
}

/** How many pieces of work a hook left running are still running. */
export function lateWork(): number {
  return running.size;
}
