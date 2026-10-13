// The body fold (spec §4, Fold rules: body, hunk by hunk): a three-way merge of
// line hunks against the base. Concurrent insertions at one place both stay, in
// a deterministic order; concurrent deletions remove their union; any other
// overlap is a conflict, settled for that group of hunks alone by the side the
// caller prefers, while every other hunk still merges. Nothing else depends on
// which side is which, so swapping the sides and the preference gives the same
// text.

/** A change to the base: its lines [start, end) replaced by `lines` (start = end: a pure insertion). */
interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

export interface TextMerge {
  readonly text: string;
  /** True when hunks overlapped and only the preferred side's changes to them were kept. */
  readonly conflicted: boolean;
}

/** Beyond this many edits between two versions, the diff gives up on detail: one hunk spans the difference. */
const MAX_EDITS = 4_000;

/** The text's lines, each with its own line ending (the last one may have none). */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The base-to-other hunks of a Myers diff (fewest inserted and deleted lines). */
function diffHunks(base: readonly string[], other: readonly string[]): Hunk[] {
  let prefix = 0;
  while (prefix < base.length && prefix < other.length && base[prefix] === other[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  };
  const a = base.slice(prefix, base.length - suffix).map(intern);
  const b = other.slice(prefix, other.length - suffix).map(intern);
  const matches = matchedPairs(a, b);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [a.length, b.length] as const]) {
    if (mi > i || mj > j) {
      hunks.push({ start: prefix + i, end: prefix + mi, lines: other.slice(prefix + j, prefix + mj) });
    }
    i = mi + 1;
    j = mj + 1;
  }
  return hunks;
}

/** The (i, j) pairs of equal elements a Myers diff keeps, in order; none when the edit count passes the limit. */
function matchedPairs(a: readonly number[], b: readonly number[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: v over k in [-(d+1), d+1] as it stood before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [];
}

function backtrack(trace: readonly Int32Array[], a: readonly number[], b: readonly number[], depth: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY && a[x - 1] === b[y - 1]) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    pairs.push([x - 1, y - 1]);
    x--;
    y--;
  }
  return pairs.reverse();
}

/**
 * Whether two hunks of different sides touch the same base text. An insertion
 * overlaps a range only strictly inside it; at a range's edge the two are
 * adjacent and both apply.
 */
function overlaps(x: Hunk, y: Hunk): boolean {
  const xInsert = x.start === x.end;
  const yInsert = y.start === y.end;
  if (xInsert && yInsert) return x.start === y.start;
  if (xInsert) return y.start < x.start && x.start < y.end;
  if (yInsert) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

const byBytes = (x: string, y: string) => Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));

/** What a group of overlapping hunks from both sides becomes, or null for a conflict. */
function resolveCluster(sides: readonly [readonly Hunk[], readonly Hunk[]]): string[] | null {
  const [ours, theirs] = sides;
  if (ours.length === 0 || theirs.length === 0) return [...(ours[0] ?? theirs[0])!.lines];
  const all = [...ours, ...theirs];
  // Both deleted: the base minus the union of the deletions.
  if (all.every((h) => h.start < h.end && h.lines.length === 0)) return [];
  // Both inserted at one place: keep both, in byte order (once when they agree).
  if (all.every((h) => h.start === h.end)) {
    const texts = [...new Set(all.map((h) => h.lines.join('')))].sort(byBytes);
    return texts.flatMap(splitLines);
  }
  if (ours.length === 1 && theirs.length === 1) {
    const [x, y] = [ours[0]!, theirs[0]!];
    if (x.start === y.start && x.end === y.end && x.lines.join('') === y.lines.join('')) return [...x.lines];
  }
  return null;
}

/**
 * Folds the texts `a` and `b` over `base`, hunk by hunk. A group of hunks that
 * overlap and don't resolve takes only the `prefer` side's changes; the rest of
 * the text merges as usual.
 */
export function mergeText(base: string, a: string, b: string, prefer: 'a' | 'b'): TextMerge {
  if (a === b) return { text: a, conflicted: false };
  if (a === base) return { text: b, conflicted: false };
  if (b === base) return { text: a, conflicted: false };
  const baseLines = splitLines(base);
  const hunks = [diffHunks(baseLines, splitLines(a)), diffHunks(baseLines, splitLines(b))] as const;
  // Group hunks that overlap across the sides, transitively.
  const all = [...hunks[0].map((h) => ({ h, side: 0 })), ...hunks[1].map((h) => ({ h, side: 1 }))];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < hunks[0].length; i++) {
    for (let j = 0; j < hunks[1].length; j++) {
      const y = hunks[1][j]!;
      if (y.start > hunks[0][i]!.end) break;
      if (overlaps(hunks[0][i]!, y)) parent[find(i)] = find(hunks[0].length + j);
    }
  }
  const clusters = new Map<number, { start: number; end: number; sides: [Hunk[], Hunk[]] }>();
  all.forEach(({ h, side }, i) => {
    const root = find(i);
    let cluster = clusters.get(root);
    if (!cluster) clusters.set(root, (cluster = { start: h.start, end: h.end, sides: [[], []] }));
    cluster.start = Math.min(cluster.start, h.start);
    cluster.end = Math.max(cluster.end, h.end);
    cluster.sides[side]!.push(h);
  });
  const ordered = [...clusters.values()].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let at = 0;
  let conflicted = false;
  for (const cluster of ordered) {
    out.push(...baseLines.slice(at, cluster.start));
    const lines = resolveCluster(cluster.sides);
    if (lines !== null) out.push(...lines);
    else {
      // The preferred side's own hunks, over the base text the group spans.
      conflicted = true;
      let inside = cluster.start;
      for (const h of cluster.sides[prefer === 'a' ? 0 : 1]) {
        out.push(...baseLines.slice(inside, h.start), ...h.lines);
        inside = h.end;
      }
      out.push(...baseLines.slice(inside, cluster.end));
    }
    at = cluster.end;
  }
  out.push(...baseLines.slice(at));
  return { text: out.join(''), conflicted };
}
