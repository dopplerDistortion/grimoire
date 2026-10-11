// A hook never fails (spec §10): whatever goes wrong, it exits 0 and says
// nothing. With GRIMOIRE_DEBUG set, the failure it swallowed goes to stderr,
// so a person (or a test) can see why a hook was quiet. The launcher does the
// same for a copy that fails to load.

/** Reports a hook's swallowed failure on stderr when GRIMOIRE_DEBUG is set. Never throws. */
export function hookFailed(error: unknown): void {
  if (!process.env.GRIMOIRE_DEBUG) return;
  try {
    process.stderr.write(`grimoire hook failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  } catch {
    // stderr is gone: nothing more to say.
  }
}
