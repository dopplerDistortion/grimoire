import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isTempName, readTextIfExists, removeFile, writeFileAtomic } from './fs-atomic';
import { assertKind, fileNameForKey } from './names';

/** Any value that survives JSON. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One document as listed: its key and its value. */
export interface DocEntry<T> {
  readonly key: string;
  readonly value: T;
}

/** The bytes on disk: `{"key": …, "value": …}`. No version field. */
interface DocFile {
  key: string;
  value: unknown;
}

export interface DocStoreHooks {
  /** Runs before every read; may throw (the records class checks the marker). */
  beforeRead(): Promise<void>;
  /** Runs before every write or removal; may throw. */
  beforeWrite(): Promise<void>;
  /** Runs `fn` exclusively per (collection, kind), across processes. */
  exclusive<R>(kind: string, fn: () => Promise<R>): Promise<R>;
}

/**
 * A collection of JSON documents, `<root>/<kind>/<file>.json`, keyed by any
 * string. Every write is a temp file plus a rename; `update` is a
 * read-modify-write that is exclusive across processes.
 */
export class DocStore {
  constructor(
    private readonly root: string,
    private readonly hooks: DocStoreHooks,
  ) {}

  private file(kind: string, key: string): string {
    assertKind(kind);
    return path.join(this.root, kind, `${fileNameForKey(key)}.json`);
  }

  /** The value stored under (kind, key), or undefined. */
  async read<T = Json>(kind: string, key: string): Promise<T | undefined> {
    const file = this.file(kind, key);
    await this.hooks.beforeRead();
    return parseDoc<T>(await readTextIfExists(file), key)?.value;
  }

  /** Stores `value` under (kind, key), replacing what was there. */
  async write<T = Json>(kind: string, key: string, value: T): Promise<void> {
    const file = this.file(kind, key);
    await this.hooks.beforeWrite();
    await writeFileAtomic(file, serialize(key, value));
  }

  /**
   * Read-modify-write, exclusive across processes for this kind. `fn` gets the
   * current value (or undefined) and returns the new one; returning undefined
   * removes the document. Returns what `fn` returned.
   */
  async update<T = Json>(
    kind: string,
    key: string,
    fn: (current: T | undefined) => T | undefined | Promise<T | undefined>,
  ): Promise<T | undefined> {
    const file = this.file(kind, key);
    await this.hooks.beforeWrite();
    return this.hooks.exclusive(kind, async () => {
      const current = parseDoc<T>(await readTextIfExists(file), key)?.value;
      const next = await fn(current);
      if (next === undefined) await removeFile(file);
      else await writeFileAtomic(file, serialize(key, next));
      return next;
    });
  }

  /** Removes (kind, key); false if it wasn't there. */
  async remove(kind: string, key: string): Promise<boolean> {
    const file = this.file(kind, key);
    await this.hooks.beforeWrite();
    return removeFile(file);
  }

  /**
   * Stores `value` under a new, unique key that sorts after earlier appends
   * (for logs and event rows), and returns that key.
   */
  async append<T = Json>(kind: string, value: T): Promise<string> {
    const key = `${String(Date.now()).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
    await this.write(kind, key, value);
    return key;
  }

  /** Every document of a kind, sorted by key. Unreadable files are skipped. */
  async list<T = Json>(kind: string): Promise<DocEntry<T>[]> {
    assertKind(kind);
    await this.hooks.beforeRead();
    const dir = path.join(this.root, kind);
    const names = await readdir(dir).catch(() => [] as string[]);
    const entries: DocEntry<T>[] = [];
    for (const name of names) {
      if (isTempName(name) || !name.endsWith('.json')) continue;
      const doc = parseDoc<T>(await readTextIfExists(path.join(dir, name)));
      if (doc) entries.push(doc);
    }
    return entries.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  }
}

function serialize(key: string, value: unknown): string {
  const doc: DocFile = { key, value };
  return `${JSON.stringify(doc)}\n`;
}

function parseDoc<T>(text: string | undefined, expectedKey?: string): DocEntry<T> | undefined {
  if (text === undefined) return undefined;
  try {
    const doc = JSON.parse(text) as Partial<DocFile> | null;
    if (!doc || typeof doc.key !== 'string' || !('value' in doc)) return undefined;
    if (expectedKey !== undefined && doc.key !== expectedKey) return undefined;
    return { key: doc.key, value: doc.value as T };
  } catch {
    return undefined;
  }
}
