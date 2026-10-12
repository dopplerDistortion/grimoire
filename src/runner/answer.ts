// Reading a child's answer, and its failure rules (spec §16; spike D C3,
// spike F C4).
//
// Claude: a run failed on a non-zero exit, `is_error`, a `subtype` other than
// `success`, or a missing `structured_output`; the answer is read only from
// `structured_output` (API and auth errors report `subtype: success` with
// `is_error: true`).
// Codex: a run failed on a non-zero exit, a `turn.failed` event, or a missing
// or invalid `-o` file. `error` events alone are not failures: a successful
// run can carry reconnect errors.
import type { ProcessRun } from './process';

export type ChildAnswer = { readonly ok: true; readonly answer: Record<string, unknown> } | { readonly ok: false; readonly reason: string };

function processFailure(run: ProcessRun): string | null {
  if (run.spawnError !== undefined) return `child_not_started:${run.spawnError}`;
  if (run.timedOut) return 'child_timed_out';
  if (run.code !== 0) return `child_exit_${run.code ?? 'killed'}`;
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function claudeAnswer(run: ProcessRun): ChildAnswer {
  let output: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as unknown;
    output = isObject(parsed) ? parsed : null;
  } catch {
    output = null;
  }
  const failed = processFailure(run);
  if (failed !== null) return { ok: false, reason: failed };
  if (output === null) return { ok: false, reason: 'child_output_unreadable' };
  if (output.is_error === true) return { ok: false, reason: 'child_is_error' };
  if (output.subtype !== 'success') return { ok: false, reason: `child_${typeof output.subtype === 'string' ? output.subtype.slice(0, 40) : 'no_subtype'}` };
  if (!isObject(output.structured_output)) return { ok: false, reason: 'child_no_structured_output' };
  return { ok: true, answer: output.structured_output };
}

export function codexAnswer(run: ProcessRun, out: string | undefined): ChildAnswer {
  const failed = processFailure(run);
  if (failed !== null) return { ok: false, reason: failed };
  for (const line of run.stdout.split('\n')) {
    try {
      if ((JSON.parse(line) as { type?: unknown }).type === 'turn.failed') return { ok: false, reason: 'child_turn_failed' };
    } catch {
      // Not an event line.
    }
  }
  if (out === undefined) return { ok: false, reason: 'child_no_output_file' };
  try {
    const answer = JSON.parse(out) as unknown;
    return isObject(answer) ? { ok: true, answer } : { ok: false, reason: 'child_output_invalid' };
  } catch {
    return { ok: false, reason: 'child_output_invalid' };
  }
}
