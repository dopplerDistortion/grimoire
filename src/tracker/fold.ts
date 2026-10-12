// The fold (spec §4, Fold rules): the deterministic, record-aware merge of two
// tracker trees over their merge base, computed in memory. It never uses
// `git merge` and never reads the clock, and it is symmetric: fold(A, B) and
// fold(B, A) build the same tree, so every clone reaches the same state.
//
// The walk takes a whole subtree wherever only one side changed it, so its cost
// follows the size of the concurrent change, not of the tracker. Where both
// sides changed a path, the rule for that path's kind of record decides.
//
// Skill ledger records and skill versions (`knowledge/ledger/`,
// `knowledge/skill-versions/`) need no rule here: each is write-once and named
// by the sha256 of its bytes, so two clones' files fold to their union. Skill
// forks are resolved on read, from the ledger alone (src/knowledge/derive.ts).
import { BLOB_MODE, TREE_MODE, type TreeEntry } from '../git/objects';
import { conflictName } from './conflict';
import { compareTimes, deleteConflict, foldEnd, foldExtra, foldIssue, foldMarker, foldOutcome, foldSession, foldSettings, sessionCutAt } from './fold-records';
import { parseEnd } from './attempt';
import {
  attemptDir,
  ATTEMPTS_DIR,
  COMMENTS_DIR,
  CONFLICTS_DIR,
  DELETED_DIR,
  FORMAT_FILE,
  issueDir,
  ISSUES_DIR,
  outcomeFile,
  OUTCOMES_DIR,
  PURGES_DIR,
  SESSIONS_DIR,
  SETTINGS_FILE,
} from './layout';
import { bareId } from './ids';
import type { FileEdit, VirtualObjects } from './objects';
import { collisionHash, parseIssue } from './record';
import { foldPage, regenerateWikiTree, wikiConflictPath, wikiKind } from './wiki';

/** What a fold noticed that a write committing it records (machine-locally: the capture doctor stats). */
export interface FoldReport {
  /** Late session records the fold dropped, as `<attempt>/<session-key>`: cut after the attempt's end on the other side. */
  readonly lateDrops: string[];
}

/** The merge bases of the first commit and (a hypothetical merge of) the rest, as `git merge-base --all` gives them. */
export type MergeBases = (commits: readonly string[]) => Promise<readonly string[]>;

/** Past this depth of criss-cross merges, the virtual base stops recursing and takes the first base. */
const MAX_BASE_DEPTH = 8;

type Entry = TreeEntry | undefined;

function same(x: Entry, y: Entry): boolean {
  return x === y || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
}

/** A directory entry (the predicate type keeps a file's type intact in the false branch). */
const isTree = (entry: Entry): entry is TreeEntry & { mode: typeof TREE_MODE } => entry?.mode === TREE_MODE;

/** The entry with the lower oid: the deterministic tie-break of last resort. */
function lower(a: TreeEntry, b: TreeEntry): TreeEntry {
  return a.oid < b.oid ? a : b;
}

/**
 * Folds the commits `local` and `remote`: their merge base (a recursive
 * virtual base when there are several), then the three-way fold of the trees.
 * Returns the merged root tree, held in `objects` until a write persists it.
 */
export async function foldCommits(
  objects: VirtualObjects,
  mergeBases: MergeBases,
  local: string,
  remote: string,
  report?: FoldReport,
): Promise<string> {
  const base = await virtualBase(objects, mergeBases, await mergeBases([local, remote]), 0);
  const [ours, theirs] = await Promise.all([objects.commit(local), objects.commit(remote)]);
  return (await foldTrees(objects, base, ours.tree, theirs.tree, report)) ?? objects.putTree([]);
}

/**
 * The tree a fold uses as its base: none, the one base's tree, or for several
 * bases (criss-cross folds) their own fold, built pairwise in oid order like
 * git's recursive strategy.
 */
async function virtualBase(
  objects: VirtualObjects,
  mergeBases: MergeBases,
  bases: readonly string[],
  depth: number,
): Promise<string | null> {
  if (bases.length === 0) return null;
  const sorted = [...bases].sort();
  let tree: string | null = (await objects.commit(sorted[0]!)).tree;
  if (depth >= MAX_BASE_DEPTH) return tree;
  for (let i = 1; i < sorted.length; i++) {
    const inner = await virtualBase(objects, mergeBases, await mergeBases([sorted[i]!, ...sorted.slice(0, i)]), depth + 1);
    tree = await foldTrees(objects, inner, tree, (await objects.commit(sorted[i]!)).tree);
  }
  return tree;
}

/** Folds the trees `a` and `b` over `base` (null: absent or empty). */
export async function foldTrees(
  objects: VirtualObjects,
  base: string | null,
  a: string | null,
  b: string | null,
  report?: FoldReport,
): Promise<string | null> {
  [base, a, b] = await keepCollisionsApart(objects, base, a, b);
  const fold = new Fold(objects, { a, b }, report);
  await fold.readTombstones([base, a, b]);
  return fold.finish(await fold.dir([], base, a, b));
}

/** Which record an `issue.md` (or `issue-at-start.md`) is: the hash4 of what never changes about it. */
async function identityAt(objects: VirtualObjects, entry: Entry): Promise<string | null> {
  if (!entry || entry.mode === TREE_MODE) return null;
  return collisionHash(parseIssue(await objects.blob(entry.oid)));
}

/**
 * Id collisions (spec §3): one id minted on two clones is found when both
 * sides hold a different record under it, or when either side already keeps
 * the collision apart as `<id>~<hash4>`. Every side's bare `<id>` directory,
 * with its attempts and outcomes, then moves to `<id>~<hash4>`, the hash of
 * that record's creation, so each record folds with its own history on every
 * clone, however many folds ago the collision was found.
 */
async function keepCollisionsApart(
  objects: VirtualObjects,
  base: string | null,
  a: string | null,
  b: string | null,
): Promise<[string | null, string | null, string | null]> {
  const collided = new Set<string>();
  const shard = async (oids: readonly (string | null)[], depth: number): Promise<void> => {
    if (oids[1] === oids[2]) return;
    const sides = await Promise.all(oids.map(async (oid) => new Map((oid ? await objects.tree(oid) : []).map((e) => [e.name, e]))));
    if (depth < 2) {
      const names = new Set(sides.flatMap((side) => [...side.keys()]));
      await Promise.all(
        [...names].map((name) => shard(sides.map((side) => (isTree(side.get(name)) ? side.get(name)!.oid : null)), depth + 1)),
      );
      return;
    }
    const ids = new Set(sides.flatMap((side) => [...side.keys()].map(bareId)));
    await Promise.all(
      [...ids].map(async (id) => {
        const kept = sides.some((side) => [...side.keys()].some((name) => name !== id && bareId(name) === id));
        const bare = sides.map((side) => side.get(id));
        if (kept && bare.some((entry) => entry !== undefined)) collided.add(id);
        else if (bare[1] && bare[2] && !same(bare[1], bare[2]) && isTree(bare[1]) && isTree(bare[2])) {
          const [x, y] = await Promise.all(
            [bare[1], bare[2]].map(async (dir) => identityAt(objects, (await objects.tree(dir.oid)).find((e) => e.name === 'issue.md'))),
          );
          if (x !== null && y !== null && x !== y) collided.add(id);
        }
      }),
    );
  };
  const issuesOf = async (root: string | null) => {
    const entry = root ? await objects.entryAt(root, ISSUES_DIR) : null;
    return entry && isTree(entry) ? entry.oid : null;
  };
  await shard(await Promise.all([base, a, b].map(issuesOf)), 0);
  if (collided.size === 0) return [base, a, b];
  const renamed = await Promise.all([base, a, b].map((root) => (root ? renameCollided(objects, root, collided) : null)));
  return renamed as [string | null, string | null, string | null];
}

/** Moves one side's bare directories of collided ids, and their attempts and outcomes, under `<id>~<hash4>`. */
async function renameCollided(objects: VirtualObjects, root: string, collided: ReadonlySet<string>): Promise<string> {
  const edits = new Map<string, FileEdit>();
  for (const id of collided) {
    const dir = issueDir(id);
    const issue = await objects.entryAt(root, dir);
    const own = issue && isTree(issue) ? await identityAt(objects, (await objects.tree(issue.oid)).find((e) => e.name === 'issue.md')) : null;
    if (issue && own) {
      edits.set(dir, null);
      edits.set(`${dir}~${own}`, { tree: issue.oid });
    }
    const handles = new Map<string, string>();
    const attempts = attemptDir(id, 'x').replace(/\/x$/, '');
    for (const attempt of await objects.dirAt(root, attempts)) {
      if (!isTree(attempt)) continue;
      const opened = await identityAt(objects, (await objects.tree(attempt.oid)).find((e) => e.name === 'issue-at-start.md'));
      const side = opened ?? own;
      if (!side) continue;
      handles.set(attempt.name, side);
      edits.set(attempts, null);
      edits.set(`${attempts}~${side}/${attempt.name}`, { tree: attempt.oid });
    }
    const outcomes = outcomeFile(id, 'x').replace(/\/x\.md$/, '');
    for (const outcome of await objects.dirAt(root, outcomes)) {
      const side = handles.get(outcome.name.replace(/\.md$/, '')) ?? own;
      if (!side || isTree(outcome)) continue;
      edits.set(outcomes, null);
      edits.set(`${outcomes}~${side}/${outcome.name}`, { oid: outcome.oid });
    }
  }
  if (edits.size === 0) return root;
  return (await objects.editTree(root, edits)) ?? objects.putTree([]);
}

/** Where a path sits in the tracker layout (spec §3), as far as the fold's rules care. */
function kindOf(path: readonly string[]): string {
  const [top] = path;
  const depth = path.length;
  if (depth === 1 && top === FORMAT_FILE) return 'marker';
  if (depth === 1 && top === SETTINGS_FILE) return 'settings';
  if (top === ISSUES_DIR) {
    if (depth === 4) return 'issue-dir';
    if (depth === 5 && path[4] === 'issue.md') return 'issue';
  }
  if (top === ATTEMPTS_DIR) {
    if (depth === 5) return 'attempt-dir';
    if (depth === 6 && path[5] === 'end.md') return 'attempt-end';
    if (depth === 7 && path[5] === SESSIONS_DIR) return 'session';
  }
  if (top === OUTCOMES_DIR && depth === 5) return 'outcome';
  return wikiKind(path) ?? 'other';
}

class Fold {
  /** Files a rule adds next to the path it folded (conflict records), by directory path. */
  private readonly additions = new Map<string, Map<string, Buffer>>();
  /** Attempts a purge tombstone (`purges/<attempt>.md`) removed, on either side. */
  private readonly purgedAttempts = new Set<string>();
  /** Session records a tombstone (`purges/<attempt>/<session-key>.md`) removed, as `<attempt>/<session-key>`. */
  private readonly purgedSessions = new Set<string>();
  /** Tombstones only one side holds. */
  private readonly newTombstones = new Set<string>();
  /** Issues kept against a delete: their `deleted/<id>.md` tombstones are dropped. */
  private readonly undeleted = new Set<string>();

  constructor(
    private readonly objects: VirtualObjects,
    private readonly roots: { readonly a: string | null; readonly b: string | null },
    private readonly report?: FoldReport,
  ) {}

  /**
   * Reads every purge tombstone the trees hold. Tombstones are add-only, so
   * their union is the fold's; the ones only one side holds are new to the
   * other, whose additions under them `finish` removes.
   */
  async readTombstones(roots: readonly (string | null)[]): Promise<void> {
    const held = await Promise.all(roots.map((root) => this.tombstonesIn(root)));
    for (const set of held) for (const key of set) this.addTombstone(key);
    const [, inA, inB] = held as [Set<string>, Set<string>, Set<string>];
    for (const key of [...inA, ...inB]) if (!(inA.has(key) && inB.has(key))) this.newTombstones.add(key);
  }

  /** `<attempt>` for a trace's tombstone, `<attempt>/<session-key>` for a session record's. */
  private async tombstonesIn(root: string | null): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const entry of root ? await this.objects.dirAt(root, PURGES_DIR) : []) {
      if (entry.mode !== TREE_MODE) {
        if (entry.name.endsWith('.md')) keys.add(entry.name.slice(0, -3));
        continue;
      }
      for (const session of await this.objects.tree(entry.oid)) {
        if (session.mode !== TREE_MODE && session.name.endsWith('.md')) keys.add(`${entry.name}/${session.name.slice(0, -3)}`);
      }
    }
    return keys;
  }

  private addTombstone(key: string): void {
    if (key.includes('/')) this.purgedSessions.add(key);
    else this.purgedAttempts.add(key);
  }

  /**
   * The folded root, minus the tombstones of issues a fold kept against their
   * delete, and minus anything a tombstone new to one side removes that the
   * other side still held or added (purge tombstones dominate, spec §3).
   */
  async finish(root: string | null): Promise<string | null> {
    const edits = new Map<string, null>([...this.undeleted].map((id) => [`${DELETED_DIR}/${id}.md`, null]));
    if (root && this.newTombstones.size > 0) {
      const attempts = new Set([...this.newTombstones].map((key) => key.split('/')[0]!));
      for (const [attempt, dir] of await this.findAttempts(root, ATTEMPTS_DIR, attempts, (name) => name)) {
        if (this.newTombstones.has(attempt)) {
          edits.set(dir, null);
          continue;
        }
        for (const session of await this.objects.dirAt(root, `${dir}/${SESSIONS_DIR}`)) {
          if (this.newTombstones.has(`${attempt}/${session.name.replace(/\.md$/, '')}`)) edits.set(`${dir}/${SESSIONS_DIR}/${session.name}`, null);
        }
      }
      const outcomes = (name: string) => name.replace(/\.md$/, '');
      for (const [attempt, file] of await this.findAttempts(root, OUTCOMES_DIR, attempts, outcomes)) {
        if (this.newTombstones.has(attempt)) edits.set(file, null);
      }
    }
    return edits.size === 0 ? root : this.objects.editTree(root, edits);
  }

  /** The paths under `top` (sharded `<a>/<b>/<issue>/`) whose entry names one of `attempts`. */
  private async findAttempts(
    root: string,
    top: string,
    attempts: ReadonlySet<string>,
    attemptOf: (name: string) => string,
  ): Promise<[string, string][]> {
    const found: [string, string][] = [];
    const walk = async (oid: string, path: string, depth: number): Promise<void> => {
      const entries = await this.objects.tree(oid);
      if (depth === 3) {
        for (const entry of entries) if (attempts.has(attemptOf(entry.name))) found.push([attemptOf(entry.name), `${path}/${entry.name}`]);
        return;
      }
      await Promise.all(entries.filter(isTree).map((entry) => walk(entry.oid, `${path}/${entry.name}`, depth + 1)));
    };
    const start = await this.objects.entryAt(root, top);
    if (start && isTree(start)) await walk(start.oid, top, 0);
    return found;
  }

  /** Whether a purge tombstone removes this path, whatever either side did to it. */
  private purged(kind: string, path: readonly string[]): boolean {
    const name = path[path.length - 1]!;
    if (kind === 'attempt-dir') return this.purgedAttempts.has(name);
    if (kind === 'outcome') return this.purgedAttempts.has(name.replace(/\.md$/, ''));
    if (kind === 'session') return this.purgedSessions.has(`${path[4]}/${name.replace(/\.md$/, '')}`);
    return false;
  }

  /**
   * An issue directory deleted on one side and changed on the other. If the
   * other side edited the issue after the base (its record, comments or
   * conflict records), the issue stays with a conflict record and its
   * tombstone goes; otherwise the delete stands, and with it the whole
   * directory, unknown files included.
   */
  private async deleteAgainstEdit(path: readonly string[], base: TreeEntry, kept: TreeEntry, deleter: string | null): Promise<TreeEntry | null> {
    if (!isTree(kept) || !isTree(base)) return kept;
    const [baseEntries, keptEntries] = await Promise.all([this.entries(base.oid), this.entries(kept.oid)]);
    const edited = ['issue.md', COMMENTS_DIR, CONFLICTS_DIR].some((name) => !same(baseEntries.get(name), keptEntries.get(name)));
    if (!edited) return null;
    const id = path[3]!;
    const record = keptEntries.get('issue.md');
    const [tombstone, issue] = await Promise.all([
      deleter ? this.objects.fileAt(deleter, `${DELETED_DIR}/${id}.md`) : null,
      record && record.mode !== TREE_MODE ? this.objects.blob(record.oid) : null,
    ]);
    const conflict = deleteConflict(tombstone, issue);
    this.undeleted.add(id);
    const oid = await this.objects.editTree(kept.oid, new Map([[`${CONFLICTS_DIR}/${conflictName(conflict)}.md`, conflict]]));
    return { mode: TREE_MODE, name: kept.name, oid: oid! };
  }

  private async entries(oid: string | null): Promise<Map<string, TreeEntry>> {
    return new Map((oid ? await this.objects.tree(oid) : []).map((entry) => [entry.name, entry]));
  }

  private add(dir: readonly string[], file: string, bytes: Buffer): void {
    const key = dir.join('/');
    let files = this.additions.get(key);
    if (!files) this.additions.set(key, (files = new Map()));
    files.set(file, bytes);
  }

  /** Folds one directory; null when nothing is left in it. */
  async dir(path: readonly string[], base: string | null, a: string | null, b: string | null): Promise<string | null> {
    const [baseEntries, aEntries, bEntries] = await Promise.all([this.entries(base), this.entries(a), this.entries(b)]);
    const names = [...new Set([...baseEntries.keys(), ...aEntries.keys(), ...bEntries.keys()])];
    const folded = await Promise.all(
      names.map((name) => this.entry([...path, name], baseEntries.get(name), aEntries.get(name), bEntries.get(name))),
    );
    const entries = folded.filter((entry): entry is TreeEntry => entry !== null);
    let tree = entries.length === 0 ? null : this.objects.putTree(entries);
    const added = this.additions.get(path.join('/'));
    if (added) tree = await this.objects.editTree(tree, added);
    return tree;
  }

  /** Folds a file both sides changed, by the rule for its kind of record. */
  private async file(path: readonly string[], base: Entry, a: TreeEntry, b: TreeEntry): Promise<TreeEntry | null> {
    const name = path[path.length - 1]!;
    const blobOf = (entry: Entry) => (entry && entry.mode !== TREE_MODE ? this.objects.blob(entry.oid) : Promise.resolve(null));
    switch (kindOf(path)) {
      case 'issue': {
        const [baseBytes, aBytes, bBytes] = await Promise.all([blobOf(base), blobOf(a), blobOf(b)]);
        const folded = foldIssue(baseBytes, aBytes!, bBytes!);
        if (folded.conflict) this.add(path.slice(0, -1), `${CONFLICTS_DIR}/${conflictName(folded.conflict)}.md`, folded.conflict);
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(folded.bytes) };
      }
      case 'attempt-end': {
        // Two seals of one attempt: the stronger ending stands, and the other is kept beside it.
        const [kept, setAside] = foldEnd(await this.objects.blob(a.oid), await this.objects.blob(b.oid));
        this.add(path.slice(0, -1), `${CONFLICTS_DIR}/${conflictName(setAside)}.md`, setAside);
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(kept) };
      }
      case 'marker':
      case 'settings': {
        const [baseBytes, aBytes, bBytes] = await Promise.all([blobOf(base), blobOf(a), blobOf(b)]);
        const fold = kindOf(path) === 'marker' ? foldMarker : foldSettings;
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(fold(baseBytes, aBytes!, bBytes!)) };
      }
      case 'outcome': {
        // The attempt's own `end.md` on each side: when both sealed it differently, the outcome follows the end that stands.
        const end = [ATTEMPTS_DIR, ...path.slice(1, 4), name.replace(/\.md$/, ''), 'end.md'].join('/');
        const [aBytes, bBytes, aEnd, bEnd] = await Promise.all([
          this.objects.blob(a.oid),
          this.objects.blob(b.oid),
          ...[this.roots.a, this.roots.b].map((root) => (root ? this.objects.fileAt(root, end) : null)),
        ]);
        const ends = aEnd && bEnd && !aEnd.equals(bEnd) ? ([aEnd, bEnd] as const) : null;
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(foldOutcome(aBytes!, bBytes!, ends)) };
      }
      case 'session':
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(foldSession(await this.objects.blob(a.oid), await this.objects.blob(b.oid))) };
      case 'wiki-page': {
        // A page both clones wrote (spec §17): the side set aside goes under the wiki's conflicts/.
        const slug = name.slice(0, -'.md'.length);
        const [baseBytes, aBytes, bBytes] = await Promise.all([blobOf(base), blobOf(a), blobOf(b)]);
        const folded = foldPage(slug, baseBytes, aBytes!, bBytes!, foldExtra);
        if (folded.conflict) this.add(path.slice(0, 2), wikiConflictPath(slug, folded.conflict.name), folded.conflict.bytes);
        return { mode: BLOB_MODE, name, oid: this.objects.putBlob(folded.bytes) };
      }
      default:
        // Files this release doesn't know, and add-only files both sides wrote: the lower hash wins.
        return lower(a, b);
    }
  }

  /**
   * Late session records (spec §14): when one side sealed the attempt and the
   * other hadn't, a record the other side cut after that end is dropped (the
   * sealing side's record of that context stands, if it has one) and counted;
   * one cut before it folds like any record, the further reach winning, so it
   * replaces the placeholder or a shorter record. `end.md` is never edited.
   * Records written by a side that sealed the attempt itself are never late.
   */
  private async dropLateRecords(attempt: string, a: string, b: string, folded: string): Promise<string> {
    const [aEntries, bEntries] = await Promise.all([this.entries(a), this.entries(b)]);
    const [aEnd, bEnd] = [aEntries.get('end.md'), bEntries.get('end.md')];
    if ((aEnd === undefined) === (bEnd === undefined)) return folded;
    const [sealer, other] = aEnd ? [aEntries, bEntries] : [bEntries, aEntries];
    const end = sealer.get('end.md')!;
    if (end.mode === TREE_MODE) return folded;
    const endAt = parseEnd(await this.objects.blob(end.oid)).at;
    const [sealed, open] = await Promise.all(
      [sealer, other].map((side) => {
        const dir = side.get(SESSIONS_DIR);
        return this.entries(dir && isTree(dir) ? dir.oid : null);
      }),
    );
    const edits = new Map<string, FileEdit>();
    for (const [name, entry] of open!) {
      const kept = sealed!.get(name);
      const key = name.replace(/\.md$/, '');
      if (entry.mode === TREE_MODE || same(entry, kept) || this.purgedSessions.has(`${attempt}/${key}`)) continue;
      const cutAt = sessionCutAt(await this.objects.blob(entry.oid));
      if (cutAt === null || compareTimes(cutAt, endAt) <= 0) continue;
      edits.set(`${SESSIONS_DIR}/${name}`, kept && kept.mode !== TREE_MODE ? { oid: kept.oid } : null);
      this.report?.lateDrops.push(`${attempt}/${key}`);
    }
    if (edits.size === 0) return folded;
    return (await this.objects.editTree(folded, edits)) ?? folded;
  }

  /** Folds one path: a one-sided change wins outright; a change on both sides goes to its rule. */
  async entry(path: readonly string[], base: Entry, a: Entry, b: Entry): Promise<TreeEntry | null> {
    if (same(a, b)) return a ?? null;
    if (same(a, base)) return b ?? null;
    if (same(b, base)) return a ?? null;
    const name = path[path.length - 1]!;
    const kind = kindOf(path);
    if (this.purged(kind, path)) return null;
    if (!a || !b) {
      const present = (a ?? b)!;
      if (kind === 'issue-dir') return this.deleteAgainstEdit(path, base!, present, a ? this.roots.b : this.roots.a);
      // A modification beats a delete, file by file: walk into a deleted directory so the rules inside still apply.
      if (isTree(present) && isTree(base)) {
        const oid = await this.dir(path, base.oid, a?.oid ?? null, b?.oid ?? null);
        return oid === null ? null : { mode: TREE_MODE, name, oid };
      }
      return present;
    }
    if (isTree(a) && isTree(b)) {
      let oid = await this.dir(path, isTree(base) ? base.oid : null, a.oid, b.oid);
      // The wiki's index and log are never merged as text: the fold derives them again (spec §17).
      if (kind === 'wiki-dir') oid = await regenerateWikiTree(this.objects, oid, a.oid, b.oid);
      if (kind === 'attempt-dir' && oid !== null) oid = await this.dropLateRecords(name, a.oid, b.oid, oid);
      return oid === null ? null : { mode: TREE_MODE, name, oid };
    }
    if (!isTree(a) && !isTree(b)) return this.file(path, base, a, b);
    // A file against a directory: the lower hash wins.
    return lower(a, b);
  }
}
