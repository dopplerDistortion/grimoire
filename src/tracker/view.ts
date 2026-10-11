// The read model: one immutable snapshot per tip, and the draft a write round
// edits on top of it.
import { TREE_MODE } from '../git/objects';
import { ID_LENGTH, ID_PREFIX, MAX_ID_LENGTH, notFound, parseWriteRef, resolveReadRef } from './ids';
import { DELETED_DIR, FORMAT_FILE, FORWARDS_DIR, ISSUES_DIR, issueFile, SETTINGS_FILE } from './layout';
import { lineValue, parseLines } from './lines';
import { parseMarker, type Marker } from './marker';
import { BoundedMap, type TrackerObjects } from './objects';
import { parseIssue, serializeIssue, type IssueRecord } from './record';

/** What every read sees: the tracker at one tip. */
export interface TrackerView {
  /** The commit this view shows. */
  readonly tip: string;
  /** The live issue with this full id. */
  issue(id: string): IssueRecord | undefined;
  /** Every live issue, ordered by (seq, id). */
  issues(): readonly IssueRecord[];
  /**
   * The id a read names: a full id, a unique prefix of at least 3 characters,
   * or text holding one full id. Throws INVALID, NOT_FOUND or AMBIGUOUS_REF.
   */
  resolveRead(ref: string, field?: string): string;
  /** The live issue a write names by its full id. Throws INVALID or NOT_FOUND. */
  resolveWrite(ref: string, field?: string): string;
  /** `link_base` + the record's path, or the bare id when no `link_base` is set (spec §3, Links). */
  link(id: string): string;
}

/** A view a write round edits; its edits become that round's one commit. */
export interface TrackerDraft extends TrackerView {
  /** The round's instant: use it for every timestamp the write records. */
  readonly now: Date;
  /** A fresh id, free on the local and the remote-tracking tip, never a deleted or forwarded one. */
  mintIssueId(): Promise<string>;
  /** 1 + the highest seq in the view (spec §3). */
  nextSeq(): number;
  /** Writes an issue record (canonically serialized; its unknown keys kept). */
  putIssue(record: IssueRecord): void;
}

function byOrder(a: IssueRecord, b: IssueRecord): number {
  return a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class Snapshot implements TrackerView {
  private readonly ordered: readonly IssueRecord[];
  readonly ids: ReadonlySet<string>;

  constructor(
    readonly tip: string,
    readonly rootTree: string,
    readonly marker: Marker | null,
    private readonly records: ReadonlyMap<string, IssueRecord>,
    private readonly settings: ReadonlyMap<string, unknown>,
    /** Ids gone from the live view but never reused: deleted and forwarded. */
    readonly retiredIds: ReadonlySet<string>,
  ) {
    this.ordered = [...records.values()].sort(byOrder);
    this.ids = new Set(records.keys());
  }

  issue(id: string): IssueRecord | undefined {
    return this.records.get(id);
  }

  issues(): readonly IssueRecord[] {
    return this.ordered;
  }

  resolveRead(ref: string, field = 'ref'): string {
    return resolveReadRef(ref, this.ids, field);
  }

  resolveWrite(ref: string, field = 'id'): string {
    const id = parseWriteRef(ref, field);
    if (!this.records.has(id)) throw notFound(field, id);
    return id;
  }

  link(id: string): string {
    const base = this.settings.get('link_base');
    return typeof base === 'string' && base !== '' ? base + issueFile(id) : id;
  }
}

export class Draft implements TrackerDraft {
  private readonly written = new Map<string, IssueRecord>();
  private readonly minted = new Set<string>();

  constructor(
    private readonly base: Snapshot,
    readonly now: Date,
    /** Every id taken on either tip, retired ones included. */
    private readonly takenIds: () => Promise<ReadonlySet<string>>,
    private readonly randomSuffix: (length: number) => string,
  ) {}

  get tip(): string {
    return this.base.tip;
  }

  issue(id: string): IssueRecord | undefined {
    return this.written.get(id) ?? this.base.issue(id);
  }

  issues(): readonly IssueRecord[] {
    if (this.written.size === 0) return this.base.issues();
    const merged = new Map(this.base.issues().map((r) => [r.id, r]));
    for (const [id, record] of this.written) merged.set(id, record);
    return [...merged.values()].sort(byOrder);
  }

  private liveIds(): ReadonlySet<string> {
    return new Set([...this.base.ids, ...this.written.keys()]);
  }

  resolveRead(ref: string, field = 'ref'): string {
    return resolveReadRef(ref, this.liveIds(), field);
  }

  resolveWrite(ref: string, field = 'id'): string {
    const id = parseWriteRef(ref, field);
    if (!this.issue(id)) throw notFound(field, id);
    return id;
  }

  link(id: string): string {
    return this.base.link(id);
  }

  async mintIssueId(): Promise<string> {
    const taken = await this.takenIds();
    // Three clashes in a row add a character (spec §3).
    for (let length = ID_LENGTH; length <= MAX_ID_LENGTH; length++) {
      for (let clash = 0; clash < 3; clash++) {
        const id = ID_PREFIX + this.randomSuffix(length);
        if (!taken.has(id) && !this.minted.has(id) && !this.written.has(id)) {
          this.minted.add(id);
          return id;
        }
      }
    }
    throw new Error('could not mint a free issue id: the random source keeps repeating taken ids');
  }

  nextSeq(): number {
    let highest = 0;
    for (const record of this.issues()) highest = Math.max(highest, record.seq);
    return highest + 1;
  }

  putIssue(record: IssueRecord): void {
    this.written.set(record.id, record);
  }

  /** The file edits this round's commit makes. */
  edits(): Map<string, Uint8Array | null> {
    const edits = new Map<string, Uint8Array | null>();
    for (const record of this.written.values()) edits.set(issueFile(record.id), serializeIssue(record));
    return edits;
  }
}

/** Builds snapshots from tracker trees, memoizing every subtree by oid. */
export class SnapshotLoader {
  private readonly issuesByTree = new BoundedMap<string, readonly IssueRecord[]>(8_192);
  private readonly namesByTree = new BoundedMap<string, readonly string[]>(8_192);
  private readonly records = new BoundedMap<string, IssueRecord>(50_000);

  constructor(private readonly objects: TrackerObjects) {}

  async load(tip: string): Promise<Snapshot> {
    const { tree } = await this.objects.commit(tip);
    const root = await this.objects.tree(tree);
    const find = (name: string) => root.find((entry) => entry.name === name);
    const [issues, markerBytes, settingsBytes, retired] = await Promise.all([
      this.issuesUnder(find(ISSUES_DIR)?.oid ?? null, 0),
      this.blobOf(find(FORMAT_FILE)),
      this.blobOf(find(SETTINGS_FILE)),
      this.retiredIn(tree),
    ]);
    const settings = new Map<string, unknown>();
    if (settingsBytes) {
      for (const { key, raw } of parseLines(settingsBytes.toString('utf8'))) {
        const entry = lineValue(raw);
        if (entry !== null && typeof entry === 'object' && 'value' in entry) {
          settings.set(key, (entry as { value: unknown }).value);
        }
      }
    }
    return new Snapshot(
      tip,
      tree,
      markerBytes ? parseMarker(markerBytes.toString('utf8')) : null,
      new Map(issues.map((record) => [record.id, record])),
      settings,
      retired,
    );
  }

  /** Every id a tip holds, live or retired, from tree names alone. */
  async takenIds(tip: string): Promise<Set<string>> {
    const { tree } = await this.objects.commit(tip);
    const issues = await this.objects.entryAt(tree, ISSUES_DIR);
    const names = issues && issues.mode === TREE_MODE ? await this.namesUnder(issues.oid, 0) : [];
    return new Set([...names.map((name) => name.replace(/~.*$/, '')), ...(await this.retiredIn(tree))]);
  }

  private async blobOf(entry: { mode: string; oid: string } | undefined): Promise<Buffer | null> {
    return entry && entry.mode !== TREE_MODE ? this.objects.blob(entry.oid) : null;
  }

  private async retiredIn(tree: string): Promise<Set<string>> {
    const [deleted, forwards] = await Promise.all([
      this.objects.dirAt(tree, DELETED_DIR),
      this.objects.dirAt(tree, FORWARDS_DIR),
    ]);
    return new Set([...deleted, ...forwards].map((entry) => entry.name.replace(/\.md$/, '')));
  }

  /** Records under `issues/` (depth 0), `<a>` (1), `<b>` (2) or `<id>` (3). */
  private async issuesUnder(oid: string | null, depth: number): Promise<readonly IssueRecord[]> {
    if (!oid) return [];
    const memoKey = `${depth}:${oid}`;
    const cached = this.issuesByTree.get(memoKey);
    if (cached) return cached;
    const entries = await this.objects.tree(oid);
    let records: readonly IssueRecord[];
    if (depth < 3) {
      const children = await Promise.all(
        entries.filter((e) => e.mode === TREE_MODE).map((e) => this.issuesUnder(e.oid, depth + 1)),
      );
      records = children.flat();
    } else {
      const file = entries.find((e) => e.name === 'issue.md' && e.mode !== TREE_MODE);
      records = file ? [await this.record(file.oid)] : [];
    }
    this.issuesByTree.set(memoKey, records);
    return records;
  }

  private async namesUnder(oid: string, depth: number): Promise<readonly string[]> {
    const memoKey = `${depth}:${oid}`;
    const cached = this.namesByTree.get(memoKey);
    if (cached) return cached;
    const dirs = (await this.objects.tree(oid)).filter((e) => e.mode === TREE_MODE);
    const names =
      depth < 2
        ? (await Promise.all(dirs.map((e) => this.namesUnder(e.oid, depth + 1)))).flat()
        : dirs.map((e) => e.name);
    this.namesByTree.set(memoKey, names);
    return names;
  }

  private async record(blob: string): Promise<IssueRecord> {
    let record = this.records.get(blob);
    if (!record) {
      record = parseIssue(await this.objects.blob(blob));
      this.records.set(blob, record);
    }
    return record;
  }
}
