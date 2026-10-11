// The error envelope (spec §9). Every module throws GrimoireError; the core turns
// it into `{error: {code, message, retryable, details}}`. An error always means
// nothing changed.

export type ErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_REF'
  | 'INVALID'
  | 'REVISION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'ALREADY_CLAIMED'
  | 'NOT_OPEN'
  | 'HAS_OPEN_CHILDREN'
  | 'ATTEMPT_OPEN'
  | 'NOT_ASSIGNEE'
  | 'DEBRIEF_REQUIRED'
  | 'ANCHOR_NOT_FOUND'
  | 'ANCHOR_AMBIGUOUS'
  | 'CYCLE'
  | 'IDEMPOTENCY_MISMATCH'
  | 'HUMAN_ONLY'
  | 'NO_GIT_IDENTITY'
  | 'NO_REPO'
  | 'NOT_WRITABLE'
  | 'BUSY'
  | 'NOT_SYNCED'
  | 'UPGRADE_REQUIRED'
  | 'NOT_DUE'
  | 'NOT_ISOLATED'
  | 'RUN_SUPERSEDED'
  | 'PENDING_LIMIT'
  | 'BASE_MOVED'
  | 'NO_SESSION'
  // Not in the spec's table: a surface's answer to a bug (an unexpected throw),
  // so a client gets the envelope rather than a protocol error. Unlike every
  // other code, it can't promise that nothing changed.
  | 'INTERNAL';

/** Only BUSY is worth retrying unchanged (spec §9). */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['BUSY']);

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export class GrimoireError extends Error {
  override readonly name = 'GrimoireError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

/** INVALID with per-field messages, keyed by the field's path (`title`, `labels[2]`). */
export function invalid(fields: Record<string, string>, message?: string): GrimoireError {
  const summary = Object.entries(fields)
    .map(([field, problem]) => `${field}: ${problem}`)
    .join('; ');
  return new GrimoireError('INVALID', message ?? `invalid input (${summary})`, { fields });
}
