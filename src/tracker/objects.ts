// Cached reads of tracker objects through one long-lived `git cat-file --batch`,
// and in-process writes of new blobs, trees and commits. Objects are immutable,
// so every cache is keyed by oid and never invalidated.
import { GrimoireError } from '../errors';
import { ObjectReader } from '../git/batch';
import {
  BLOB_MODE,
  decodeCommitHeader,
  decodeTree,
  encodeCommit,
  encodeTree,
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

/** A change to one file path: new bytes, or null to remove it. */
export type FileEdits = ReadonlyMap<string, Uint8Array | null>;

export class TrackerObjects {
  private readonly reader: ObjectReader;
  private readonly trees = new BoundedMap<string, readonly TreeEntry[]>(20_000);
  private readonly blobs = new BoundedMap<string, Buffer>(20_000);
  private readonly commits = new BoundedMap<string, CommitHeader>(2_000);

  constructor(
    repoDir: string,
    private readonly objectsDir: string,
    readonly format: ObjectFormat,
  ) {
    this.reader = new ObjectReader(repoDir);
  }

  warm(): void {
    this.reader.warm();
  }

  close(): Promise<void> {
    return this.reader.close();
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

  private async writeTree(entries: readonly TreeEntry[]): Promise<string> {
    const oid = await this.write('tree', encodeTree(entries));
    this.trees.set(oid, entries);
    return oid;
  }

  /**
   * Applies `edits` to the tree `base` (null: the empty tree) and returns the
   * new tree's oid, or null when nothing is left in it. Only the trees on
   * edited paths are read and rewritten; every other entry, known or not, is
   * carried over untouched.
   */
  async editTree(base: string | null, edits: FileEdits): Promise<string | null> {
    const entries = new Map((base ? await this.tree(base) : []).map((e) => [e.name, e]));
    const nested = new Map<string, Map<string, Uint8Array | null>>();
    const writes: Promise<void>[] = [];
    for (const [path, content] of edits) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        if (content === null) entries.delete(path);
        else {
          writes.push(this.writeBlob(content).then((oid) => void entries.set(path, { mode: BLOB_MODE, name: path, oid })));
        }
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
        this.editTree(childBase, group).then((oid) => {
          if (oid === null) entries.delete(dir);
          else entries.set(dir, { mode: TREE_MODE, name: dir, oid });
        }),
      );
    }
    await Promise.all(writes);
    if (entries.size === 0) return null;
    return this.writeTree([...entries.values()]);
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
