// Sweeps running in this process (spec §14 Cut at attempt end, step 1): an
// attempt-ending call cancels every one of them before it cuts, so the two
// never cut the same transcripts at once. Sweeps register here when they start.

const running = new Set<() => void>();

/** Registers a running sweep's cancel; returns the call that unregisters it when the sweep is done. */
export function registerSweep(cancel: () => void): () => void {
  running.add(cancel);
  return () => void running.delete(cancel);
}

/** Cancels every sweep running in this process. */
export function cancelSweeps(): void {
  const cancels = [...running];
  running.clear();
  for (const cancel of cancels) {
    try {
      cancel();
    } catch {
      // A sweep that fails to stop is still not ours to wait for.
    }
  }
}
