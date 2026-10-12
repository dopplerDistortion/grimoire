// The reporting structure `doctor` and `status` share (spec §12): each check
// or fact is one entry in a list, so a later slice adds its own lines (capture
// statistics, knowledge facts, the runner) by adding an entry, never by
// changing the report's shape.
import type { Json } from '../machine-local';

export type Severity = 'error' | 'warning' | 'info';

/** One thing a `doctor` check found. */
export interface Finding {
  /** The report section: `store`, `install`, and what later slices add. */
  readonly section: string;
  /** The check that found it, e.g. `store.records`. */
  readonly check: string;
  /** What was found, a stable slug: `non-canonical`, `stale-ref-lock`, `content-drift`, … */
  readonly kind: string;
  readonly severity: Severity;
  /** One line a person reads. */
  readonly message: string;
  /** What it is about: a tracker path, a checkout path, a ref, a lock. */
  readonly subject?: string;
  /** `doctor --fix` repairs it: a single-answer repair (content pointer files, stale locks). */
  readonly fixable: boolean;
  /** What a person does about it when `doctor --fix` doesn't. */
  readonly remedy?: string;
  readonly details?: { readonly [key: string]: Json };
}

/** A finding as a check reports it: the section and check are filled in from the check. */
export type CheckFinding = Omit<Finding, 'section' | 'check' | 'fixable'> & { readonly fixable?: boolean };

/** How one check went. */
export interface CheckRun {
  readonly check: string;
  readonly section: string;
  /** `failed`: the check itself threw (`error`); `skipped`: it had nothing to look at (`why`). */
  readonly status: 'ok' | 'findings' | 'skipped' | 'failed';
  readonly why?: string;
  readonly error?: string;
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
