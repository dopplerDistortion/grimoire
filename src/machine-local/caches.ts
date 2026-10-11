import path from 'node:path';
import { readTextIfExists, removeFile, writeFileAtomic } from './fs-atomic';
import { fileNameForKey } from './names';

export interface CacheOptions<T> {
  /** This release's version of this cache's shape. */
  readonly version: number;
  /** Computes the value from the source of truth. */
  build(): T | Promise<T>;
}

/** The bytes on disk. */
interface CacheFile {
  name: string;
  cache_version: number;
  value: unknown;
}

/**
 * Caches, each versioned on its own (spec §6). A cache is trusted only at
 * exactly this release's version. One that is missing, carries no version or
 * an older one is rebuilt and replaced; one a newer release wrote is rebuilt
 * for this process and left in place for that release.
 */
export class Caches {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, `${fileNameForKey(name)}.json`);
  }

  async get<T>(name: string, options: CacheOptions<T>): Promise<T> {
    const file = this.file(name);
    const stored = parseCache(await readTextIfExists(file), name);
    if (stored?.cache_version === options.version) return stored.value as T;
    const value = await options.build();
    if (!stored || stored.cache_version < options.version) {
      const doc: CacheFile = { name, cache_version: options.version, value };
      await writeFileAtomic(file, `${JSON.stringify(doc)}\n`);
    }
    return value;
  }

  /** Drops the cache, so the next `get` rebuilds it. */
  async invalidate(name: string): Promise<void> {
    await removeFile(this.file(name));
  }
}

function parseCache(text: string | undefined, name: string): CacheFile | undefined {
  if (text === undefined) return undefined;
  try {
    const doc = JSON.parse(text) as Partial<CacheFile> | null;
    if (!doc || doc.name !== name || !('value' in doc)) return undefined;
    if (typeof doc.cache_version !== 'number' || !Number.isInteger(doc.cache_version)) {
      return undefined;
    }
    return doc as CacheFile;
  } catch {
    return undefined;
  }
}
