// Anchored body patches (spec §8, Write rules): `update.body_patch` and, later,
// `close.parent_patch`. An anchor must match the verbatim body exactly once;
// an insert whose text is already present is a no-op, so retries never
// duplicate it.
import { GrimoireError } from '../errors';
import { s } from './schema';

export const patchOps = s.array(
  s.tagged(
    'op',
    {
      replace: {
        anchor: s.string({ nonEmpty: true, description: 'text that occurs exactly once in the body' }),
        text: s.string({ description: 'the replacement; empty deletes the anchor' }),
      },
      insert_before: {
        anchor: s.string({ nonEmpty: true, description: 'text that occurs exactly once in the body' }),
        text: s.string({ nonEmpty: true, description: 'inserted right before the anchor; a no-op if already present' }),
      },
      append: {
        text: s.string({ nonEmpty: true, description: 'added at the end, verbatim; a no-op if already present' }),
      },
    },
    'one anchored edit',
  ),
  'edits applied in order, all or nothing',
);

export type PatchOp = NonNullable<ReturnType<typeof patchOps.parse>>[number];

export interface PatchResult {
  readonly body: string;
  /** Indexes of the ops that changed nothing. */
  readonly noops: readonly number[];
}

/** How often `anchor` occurs in `body`, overlapping occurrences included (stops at 2). */
function occurrences(body: string, anchor: string): { count: number; at: number } {
  const at = body.indexOf(anchor);
  if (at < 0) return { count: 0, at };
  return { count: body.indexOf(anchor, at + 1) < 0 ? 1 : 2, at };
}

function anchorAt(body: string, anchor: string, op: number): number {
  const { count, at } = occurrences(body, anchor);
  if (count === 0) {
    throw new GrimoireError('ANCHOR_NOT_FOUND', `the anchor of patch op ${op} occurs nowhere in the body`, { op });
  }
  if (count > 1) {
    throw new GrimoireError(
      'ANCHOR_AMBIGUOUS',
      `the anchor of patch op ${op} occurs more than once in the body; make it longer`,
      { op },
    );
  }
  return at;
}

/**
 * Applies `ops` in order, each to the body the previous ones left. Throws
 * ANCHOR_NOT_FOUND or ANCHOR_AMBIGUOUS (with the op index) and changes nothing
 * when any op fails.
 */
export function applyPatch(body: string, ops: readonly PatchOp[]): PatchResult {
  const noops: number[] = [];
  let out = body;
  ops.forEach((op, i) => {
    if (op.op === 'replace') {
      const at = anchorAt(out, op.anchor, i);
      if (op.text === op.anchor) noops.push(i);
      else out = out.slice(0, at) + op.text + out.slice(at + op.anchor.length);
    } else if (out.includes(op.text)) {
      noops.push(i);
    } else if (op.op === 'insert_before') {
      const at = anchorAt(out, op.anchor, i);
      out = out.slice(0, at) + op.text + out.slice(at);
    } else {
      out += op.text;
    }
  });
  return { body: out, noops };
}
