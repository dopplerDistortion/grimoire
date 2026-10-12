// Line diffs for the proposal checks (spec §18 Size, Repeats, Copying): which
// lines a change removes and adds, how many of a skill's lines it changes, and
// how alike two changes are (normalized line-diff similarity).

/** A text's lines: split on LF, without the empty piece after a final line end. */
export function linesOf(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The length of the longest common subsequence of two line lists, with which lines of each it keeps. */
function common(a: readonly string[], b: readonly string[]): { length: number; keptA: boolean[]; keptB: boolean[] } {
  // Trim the shared head and tail first: changes are usually local.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const keptA = a.map((_, i) => i < head || i >= a.length - tail);
  const keptB = b.map((_, i) => i < head || i >= b.length - tail);
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  if (n === 0 || m === 0) return { length: head + tail, keptA, keptB };
  // Skills are at most a few hundred lines: the quadratic table is small.
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      keptA[head + i] = true;
      keptB[head + j] = true;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return { length: head + tail + table[0]![0]!, keptA, keptB };
}

export interface LineDiff {
  /** Lines of the old text the change removes. */
  readonly removed: string[];
  /** Lines of the new text the change adds, and which of the new text's lines they are. */
  readonly added: string[];
  readonly addedAt: ReadonlySet<number>;
  /** max(removed, added) over the old text's line count (1 when the old text is empty). */
  readonly changedShare: number;
}

export function diffLines(before: string, after: string): LineDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  const { keptA, keptB } = common(a, b);
  const removed = a.filter((_, i) => !keptA[i]);
  const addedAt = new Set(b.flatMap((_, i) => (keptB[i] ? [] : [i])));
  const added = b.filter((_, i) => !keptB[i]);
  const changedShare = a.length === 0 ? 1 : Math.max(removed.length, added.length) / a.length;
  return { removed, added, addedAt, changedShare };
}

/** A line as the repeat check compares it: trimmed, whitespace collapsed, lowercased. Blank lines drop out. */
export function normalizedLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase()).filter((line) => line !== '');
}

/** A change as the repeat check compares it: its removed lines, then its added ones, normalized and marked. */
export function changeLines(before: string, after: string): string[] {
  const diff = diffLines(before, after);
  return [...normalizedLines(diff.removed).map((line) => `-${line}`), ...normalizedLines(diff.added).map((line) => `+${line}`)];
}

/** Line-diff similarity of two line lists: 2 × common lines over all lines (1 for two empty lists). */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length + b.length === 0) return 1;
  return (2 * common(a, b).length) / (a.length + b.length);
}
