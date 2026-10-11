// ADR 0012: every surface answers a failure grimoire didn't expect (a bug, a
// git spawn failure, a filesystem error) with the same envelope, under
// INTERNAL, the one code that can't promise nothing changed.
import { GrimoireError, type ErrorBody } from '../errors';

/** The envelope for a failure outside the core's own outcomes: grimoire's errors as they are, anything else as INTERNAL. */
export function errorBodyOf(error: unknown, log: (line: string) => void): ErrorBody {
  if (error instanceof GrimoireError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  log(error instanceof Error && error.stack ? error.stack : message);
  return {
    code: 'INTERNAL',
    message: `grimoire failed unexpectedly (${message}); re-read the issue before retrying, and tell the user if it keeps happening`,
    retryable: false,
    details: {},
  };
}
