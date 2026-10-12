// The shared patch derivation (spec §20, Concurrent body edits): a body edit
// made against a base becomes anchored `replace` ops (or one `append` on an
// empty base), anchored on the base, for one `update.body_patch`. Applied to
// the base they give the draft exactly; applied to a body someone changed
// elsewhere meanwhile they merge; where the change touched the anchored text
// they fail (ANCHOR_NOT_FOUND or ANCHOR_AMBIGUOUS) and nothing is saved.
//
// Pure and dependency-free: the dashboard bundles this module as it is.

export type DerivedPatchOp = { op: 'replace'; anchor: string; text: string } | { op: 'append'; text: string };

/** One line of a line diff: kept (`=`), removed (`-`) or added (`+`), without its newline. */
export interface DiffLine {
  readonly t: '=' | '-' | '+';
  readonly l: string;
}

/** The lines of `text`, each with its newline (the last one may have none): joined, they are `text` again. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Above this many cells the middle of a diff is treated as one changed block. */
const MAX_CELLS = 4_000_000;

type Op = { t: '=' | '-' | '+'; i: number; j: number };

/** An LCS line diff of `a` and `b`, as edit steps with their indexes in `a` (`i`) and `b` (`j`). */
function diffSteps(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const steps: Op[] = [];
  for (let k = 0; k < start; k++) steps.push({ t: '=', i: k, j: k });
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (let k = 0; k < n; k++) steps.push({ t: '-', i: start + k, j: start });
    for (let k = 0; k < m; k++) steps.push({ t: '+', i: endA, j: start + k });
  } else {
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * width + j] = a[start + i] === b[start + j] ? dp[(i + 1) * width + j + 1]! + 1 : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        steps.push({ t: '=', i: start + i, j: start + j });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
        steps.push({ t: '-', i: start + i, j: start + j });
        i++;
      } else {
        steps.push({ t: '+', i: start + i, j: start + j });
        j++;
      }
    }
    for (; i < n; i++) steps.push({ t: '-', i: start + i, j: start + j });
    for (; j < m; j++) steps.push({ t: '+', i: start + i, j: start + j });
  }
  for (let k = 0; k < a.length - endA; k++) steps.push({ t: '=', i: endA + k, j: endB + k });
  return steps;
}

/** The line diff of two texts, for showing: lines without their newlines. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const left = a.split('\n');
  const right = b.split('\n');
  return diffSteps(left, right).map((step) => (step.t === '+' ? { t: '+', l: right[step.j]! } : { t: step.t, l: left[step.i]! }));
}

/** A changed block: base lines [from, to) became draft lines [dFrom, dTo). */
interface Hunk {
  from: number;
  to: number;
  dFrom: number;
  dTo: number;
}

function hunksOf(base: readonly string[], draft: readonly string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const step of diffSteps(base, draft)) {
    if (step.t === '=') {
      if (current) hunks.push(current);
      current = null;
      continue;
    }
    if (!current) current = { from: step.i, to: step.i, dFrom: step.j, dTo: step.j };
    if (step.t === '-') current.to = step.i + 1;
    else current.dTo = step.j + 1;
  }
  if (current) hunks.push(current);
  return hunks;
}

/** Whether `anchor` occurs exactly once in `text`, overlapping occurrences included. */
function unique(text: string, anchor: string): boolean {
  if (anchor === '') return false;
  const at = text.indexOf(anchor);
  return at >= 0 && text.indexOf(anchor, at + 1) < 0;
}

/** A hunk widened with context lines: base lines [lo, hi) are its anchor. */
interface Anchored extends Hunk {
  lo: number;
  hi: number;
}

/** The smallest context around `hunk` that makes its anchor unique in the base, or null when even the whole base isn't. */
function anchorOf(text: string, base: readonly string[], hunk: Hunk): Anchored | null {
  let lo = hunk.from;
  let hi = hunk.to;
  const anchor = () => base.slice(lo, hi).join('');
  // A pure insertion anchors on a neighbour: the line before it, else the one after.
  if (lo === hi) {
    if (lo > 0) lo--;
    else if (hi < base.length) hi++;
    else return null;
  }
  let before = true;
  while (!unique(text, anchor())) {
    if (lo === 0 && hi === base.length) return null;
    if ((before && lo > 0) || hi === base.length) lo--;
    else hi++;
    before = !before;
  }
  return { ...hunk, lo, hi };
}

/** The op that turns anchored base lines into their draft lines. */
function opOf(base: readonly string[], draft: readonly string[], h: Anchored): DerivedPatchOp {
  const anchor = base.slice(h.lo, h.hi).join('');
  const text = base.slice(h.lo, h.from).join('') + draft.slice(h.dFrom, h.dTo).join('') + base.slice(h.to, h.hi).join('');
  return { op: 'replace', anchor, text };
}

/** Applies ops as `update.body_patch` does (each anchor exactly once in the body so far), or null when one wouldn't apply. */
function simulate(body: string, ops: readonly DerivedPatchOp[]): string | null {
  let out = body;
  for (const op of ops) {
    if (op.op === 'append') {
      if (out.includes(op.text)) return null;
      out += op.text;
      continue;
    }
    if (!unique(out, op.anchor)) return null;
    const at = out.indexOf(op.anchor);
    out = out.slice(0, at) + op.text + out.slice(at + op.anchor.length);
  }
  return out;
}

/**
 * The anchored ops that turn `base` into `draft`, anchored on `base`: one
 * `replace` per changed block, its anchor the changed lines widened with
 * context until it occurs once; blocks whose anchors would touch merge into
 * one. An empty base is one `append`. No change is no ops.
 */
export function derivePatch(base: string, draft: string): DerivedPatchOp[] {
  if (base === draft) return [];
  if (base === '') return [{ op: 'append', text: draft }];
  const left = linesOf(base);
  const right = linesOf(draft);
  let hunks = hunksOf(left, right);
  for (;;) {
    const anchored: Anchored[] = [];
    let merged = false;
    for (const hunk of hunks) {
      const widened = anchorOf(base, left, hunk);
      if (!widened) return [{ op: 'replace', anchor: base, text: draft }];
      const last = anchored[anchored.length - 1];
      // Anchors that overlap or touch would interfere when applied in turn: one block instead.
      if (last && widened.lo <= last.hi) {
        anchored[anchored.length - 1] = { from: last.from, to: Math.max(last.to, hunk.to), dFrom: last.dFrom, dTo: Math.max(last.dTo, hunk.dTo), lo: last.lo, hi: last.hi };
        merged = true;
      } else {
        anchored.push(widened);
      }
    }
    if (merged) {
      hunks = anchored.map(({ from, to, dFrom, dTo }) => ({ from, to, dFrom, dTo }));
      continue;
    }
    const ops = anchored.map((h) => opOf(left, right, h));
    // An earlier op's text could repeat a later anchor: then the whole base is the anchor.
    return simulate(base, ops) === draft ? ops : [{ op: 'replace', anchor: base, text: draft }];
  }
}
