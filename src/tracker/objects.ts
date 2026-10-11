// Cached reads of tracker objects through one long-lived `git cat-file --batch`,
// which also resolves refs, and in-process writes of new blobs, trees and
// commits. Objects are immutable, so every cache is keyed by oid and never
// invalidated; refs are never cached.
//
// A fold builds its merged tree in memory (`VirtualObjects`): the same oids git
// would give the objects, computed without writing anything, so reads never
// create objects (spec §4, Read path). A write persists the ones it needs.
import { GrimoireError } from '../errors';
import { ObjectReader } from '../git/batch';
import {
  BLOB_MODE,
  decodeCommitHeader,
  decodeTree,
  encodeCommit,
  encodeTree,
  hashObject,
  TREE_MODE,
  writeLooseObject,
  type CommitFields,
  type CommitHeader,
  type ObjectFormat,
  type ObjectType,
  type TreeEntry,
} from '../git/objects';

/** A Map that forgets its oldest entries past `limit`. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }
  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.limit) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return super.set(key, value);
  }
}

/** An existing blob, placed at another path without rewriting it. */
export interface BlobRef {
  readonly oid: string;
}

/** An existing tree, placed at another path as a whole directory. */
export interface TreeRef {
  readonly tree: string;
}

/** A change to one path: new bytes, an existing blob or tree, or null to remove it. */
export type FileEdit = Uint8Array | BlobRef | TreeRef | null;
export type FileEdits = ReadonlyMap<string, FileEdit>;

/** Reads tracker trees and blobs by oid, and paths under a root tree. */
export abstract class ObjectSource {
  abstract readonly format: ObjectFormat;
  abstract tree(oid: string): Promise<readonly TreeEntry[]>;
  abstract blob(oid: string): Promise<Buffer>;

  /** The entry at `path` under the tree `root`, or null. */
  async entryAt(root: string, path: string): Promise<TreeEntry | null> {
    let entry: TreeEntry | null = { mode: TREE_MODE, name: '', oid: root };
    for (const name of path.split('/')) {
      if (entry.mode !== TREE_MODE) return null;
      entry = (await this.tree(entry.oid)).find((e) => e.name === name) ?? null;
      if (!entry) return null;
    }
    return entry;
  }

  /** The blob at `path` under the tree `root`, or null. */
  async fileAt(root: string, path: string): Promise<Buffer | null> {
    const entry = await this.entryAt(root, path);
    return entry && entry.mode !== TREE_MODE ? this.blob(entry.oid) : null;
  }

  /** The entries of the directory at `path` under `root` (empty when absent). */
  async dirAt(root: string, path: string): Promise<readonly TreeEntry[]> {
    const entry = await this.entryAt(root, path);
    return entry && entry.mode === TREE_MODE ? this.tree(entry.oid) : [];
  }
}

interface ObjectSink {
  putBlob(content: Uint8Array): Promise<string>;
  putTree(entries: readonly TreeEntry[]): Promise<string>;
}

/**
 * Applies `edits` to the tree `base` (null: the empty tree), reading through
 * `source` and creating objects through `sink`. Returns the new tree's oid, or
 * null when nothing is left in it. Only the trees on edited paths are read and
 * rebuilt; every other entry, known or not, is carried over untouched.
 */
async function editTreeWith(
  source: ObjectSource,
  sink: ObjectSink,
  base: string | null,
  edits: FileEdits,
): Promise<string | null> {
  const entries = new Map((base ? await source.tree(base) : []).map((e) => [e.name, e]));
  const nested = new Map<string, Map<string, FileEdit>>();
  const writes: Promise<void>[] = [];
  for (const [path, content] of edits) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      if (content === null) entries.delete(path);
      else if (content instanceof Uint8Array) {
        writes.push(sink.putBlob(content).then((oid) => void entries.set(path, { mode: BLOB_MODE, name: path, oid })));
      } else if ('tree' in content) entries.set(path, { mode: TREE_MODE, name: path, oid: content.tree });
      else entries.set(path, { mode: BLOB_MODE, name: path, oid: content.oid });
      continue;
    }
    const dir = path.slice(0, slash);
    let group = nested.get(dir);
    if (!group) nested.set(dir, (group = new Map()));
    group.set(path.slice(slash + 1), content);
  }
  for (const [dir, group] of nested) {
    const existing = entries.get(dir);
    const childBase = existing?.mode === TREE_MODE ? existing.oid : null;
    writes.push(
      editTreeWith(source, sink, childBase, group).then((oid) => {
        if (oid === null) entries.delete(dir);
        else entries.set(dir, { mode: TREE_MODE, name: dir, oid });
      }),
    );
  }
  await Promise.all(writes);
  if (entries.size === 0) return null;
  return sink.putTree([...entries.values()]);
}

export class TrackerObjects extends ObjectSource {
  private reader: ObjectReader;
  /** Readers being shut down after a restart. */
  private readonly retiring = new Set<Promise<void>>();
  /** The packed-refs stamp when the current reader first resolved refs; undefined before. */
  private refsStamp: string | undefined;
  private readonly trees = new BoundedMap<string, readonly TreeEntry[]>(20_000);
  private readonly blobs = new BoundedMap<string, Buffer>(20_000);
  private readonly commits = new BoundedMap<string, CommitHeader>(2_000);
  private readonly sink: ObjectSink = {
    putBlob: (content) => this.writeBlob(content),
    putTree: (entries) => this.writeTree(entries),
  };

  constructor(
    private readonly repoDir: string,
    private readonly objectsDir: string,
    readonly format: ObjectFormat,
  ) {
    super();
    this.reader = new ObjectReader(repoDir);
  }

  warm(): void {
    this.reader.warm();
  }

  async close(): Promise<void> {
    await Promise.all([this.reader.close(), ...this.retiring]);
  }

  /**
   * Resolves full ref names to oids (null: no such ref) through the long-lived
   * reader, which reads refs fresh, except that it trusts its cached
   * packed-refs while the file's stat looks unchanged to it. `packedRefs` is
   * `packedRefsStamp`, taken just before: when it differs from the stamp of
   * the reader's first ref lookup, a new reader answers instead.
   */
  async resolveRefs(names: readonly string[], packedRefs: string): Promise<(string | null)[]> {
    if (this.refsStamp !== packedRefs) {
      if (this.refsStamp !== undefined) this.restartReader();
      this.refsStamp = packedRefs;
    }
    const objects = await Promise.all(names.map((name) => this.reader.read(name)));
    return objects.map((object) => {
      if (!object) return null;
      if (object.type === 'commit' && !this.commits.has(object.oid)) {
        this.commits.set(object.oid, decodeCommitHeader(object.content));
      }
      return object.oid;
    });
  }

  private restartReader(): void {
    const old = this.reader;
    this.reader = new ObjectReader(this.repoDir);
    const closing: Promise<void> = old.close().finally(() => this.retiring.delete(closing));
    this.retiring.add(closing);
  }

  private async readObject(oid: string, type: ObjectType): Promise<Buffer> {
    const object = await this.reader.read(oid);
    if (!object) {
      throw new GrimoireError('NOT_SYNCED', `the tracker object ${oid} is missing from this clone`, {
        remedy: 'run `grimoire sync` to fetch the missing tracker objects',
      });
    }
    if (object.type !== type) throw new Error(`object ${oid} is a ${object.type}, not a ${type}`);
    return object.content;
  }

  async commit(oid: string): Promise<CommitHeader> {
    let header = this.commits.get(oid);
    if (!header) {
      header = decodeCommitHeader(await this.readObject(oid, 'commit'));
      this.commits.set(oid, header);
    }
    return header;
  }

  async tree(oid: string): Promise<readonly TreeEntry[]> {
    let entries = this.trees.get(oid);
    if (!entries) {
      entries = decodeTree(this.format, await this.readObject(oid, 'tree'));
      this.trees.set(oid, entries);
    }
    return entries;
  }

  async blob(oid: string): Promise<Buffer> {
    let content = this.blobs.get(oid);
    if (!content) {
      content = await this.readObject(oid, 'blob');
      this.blobs.set(oid, content);
    }
    return content;
  }

  async write(type: ObjectType, content: Uint8Array): Promise<string> {
    try {
      return await writeLooseObject(this.objectsDir, this.format, type, content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
        throw new GrimoireError('NOT_WRITABLE', `this process can't write the live store (${code})`, {});
      }
      throw error;
    }
  }

  async writeBlob(content: Uint8Array): Promise<string> {
    const oid = await this.write('blob', content);
    this.blobs.set(oid, Buffer.from(content));
    return oid;
  }

  async writeTree(entries: readonly TreeEntry[]): Promise<string> {
    const oid = await this.write('tree', encodeTree(entries));
    this.trees.set(oid, entries);
    return oid;
  }

  /**
   * Applies `edits` to the tree `base` (null: the empty tree), writing the new
   * objects, and returns the new tree's oid, or null when nothing is left in it.
   */
  editTree(base: string | null, edits: FileEdits): Promise<string | null> {
    return editTreeWith(this, this.sink, base, edits);
  }

  /** Writes a commit object, remembering its header for the next snapshot. */
  async writeCommit(fields: CommitFields): Promise<string> {
    const oid = await this.write('commit', encodeCommit(fields));
    this.commits.set(oid, { tree: fields.tree, parents: [...fields.parents] });
    return oid;
  }

  /** Writes the empty tree (a root with nothing in it). */
  emptyTree(): Promise<string> {
    return this.writeTree([]);
  }
}

type VirtualObject = { type: 'blob'; content: Buffer } | { type: 'tree'; entries: readonly TreeEntry[] };

/**
 * Objects built in memory over the real ones: blobs and trees get the oids git
 * would give them, and reads see them first, but nothing reaches the object
 * database until `persist`.
 */
export class VirtualObjects extends ObjectSource {
  private readonly objects = new Map<string, VirtualObject>();
  private readonly sink: ObjectSink = {
    putBlob: async (content) => this.putBlob(content),
    putTree: async (entries) => this.putTree(entries),
  };

  constructor(private readonly real: TrackerObjects) {
    super();
  }

  get format(): ObjectFormat {
    return this.real.format;
  }

  commit(oid: string): Promise<CommitHeader> {
    return this.real.commit(oid);
  }

  async tree(oid: string): Promise<readonly TreeEntry[]> {
    const object = this.objects.get(oid);
    if (object?.type === 'tree') return object.entries;
    return this.real.tree(oid);
  }

  async blob(oid: string): Promise<Buffer> {
    const object = this.objects.get(oid);
    if (object?.type === 'blob') return object.content;
    return this.real.blob(oid);
  }

  /** The oid of `content` as a blob, kept in memory. */
  putBlob(content: Uint8Array): string {
    const bytes = Buffer.from(content);
    const oid = hashObject(this.format, 'blob', bytes);
    if (!this.objects.has(oid)) this.objects.set(oid, { type: 'blob', content: bytes });
    return oid;
  }

  /** The oid of a tree holding `entries`, kept in memory. */
  putTree(entries: readonly TreeEntry[]): string {
    const oid = hashObject(this.format, 'tree', encodeTree(entries));
    if (!this.objects.has(oid)) this.objects.set(oid, { type: 'tree', entries: [...entries] });
    return oid;
  }

  /** `TrackerObjects.editTree`, in memory. */
  editTree(base: string | null, edits: FileEdits): Promise<string | null> {
    return editTreeWith(this, this.sink, base, edits);
  }

  /** Writes every in-memory object reachable from `root` into the object database. */
  async persist(root: string): Promise<void> {
    const pending = [root];
    const seen = new Set<string>();
    const writes: Promise<unknown>[] = [];
    for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'blob') writes.push(this.real.writeBlob(object.content));
      else {
        writes.push(this.real.writeTree(object.entries));
        for (const entry of object.entries) pending.push(entry.oid);
      }
    }
    await Promise.all(writes);
  }
}
