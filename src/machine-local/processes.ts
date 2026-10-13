import { randomBytes } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isTempName, readTextIfExists, removeFile, writeFileAtomic } from './fs-atomic';
import { currentProcessStartTime, liveProcesses, processStartTimes } from './process-info';

/**
 * One running grimoire process, as it registered itself (or as its parent
 * registered it). Coordination data: version-free, frozen by the cross-pin
 * contract. Times are epoch ms.
 */
export interface ProcessRecord {
  readonly pid: number;
  /** The process's start time, so a reused pid isn't mistaken for it. */
  readonly start_time: number;
  readonly host: string;
  /** A random id for this registration. */
  readonly nonce: string;
  /** What the process is, for example `mcp`, `start`, `sync` or `init`. */
  readonly role: string;
  /** The agent client that spawned it, when known. */
  readonly client: string | null;
  /** The worktree it runs from, or null for clone-wide work. */
  readonly worktree: string | null;
  /** The pinned version it runs. */
  readonly pin: string;
  /** The Node version in use, as `process.version` spells it. */
  readonly node: string;
  /** Where the PATH that found `node` came from, when known. */
  readonly path_source: string | null;
  readonly registered_at: number;
}

export interface ProcessInfo {
  readonly role: string;
  readonly client: string | null;
  readonly worktree: string | null;
  readonly pin: string;
  readonly pathSource: string | null;
  /** Defaults to this process. A parent registering a child passes the child's pid and start time. */
  readonly pid?: number;
  readonly startTime?: number;
  /** Defaults to `process.version`. */
  readonly node?: string;
}

export interface ProcessFilter {
  readonly role?: string;
  readonly client?: string;
  readonly worktree?: string;
  readonly pin?: string;
}

export interface ProcessRegistration {
  /** The record as last written. */
  readonly record: ProcessRecord;
  /** Rewrites the record with facts learnt after registering (a server's client); returns it. */
  update(changes: Partial<Pick<ProcessRecord, 'client' | 'path_source'>>): Promise<ProcessRecord>;
  unregister(): Promise<void>;
}

/**
 * Process records, one file per registration. A record is stale once its pid
 * is gone from this host, or its pid is alive but started at another time.
 * Records from another host can't be checked here and count as live.
 */
export class ProcessRecords {
  constructor(
    private readonly dir: string,
    private readonly host: string,
  ) {}

  async register(info: ProcessInfo): Promise<ProcessRegistration> {
    const pid = info.pid ?? process.pid;
    const record: ProcessRecord = {
      pid,
      start_time: info.startTime ?? (await startTimeOf(pid)),
      host: this.host,
      nonce: randomBytes(8).toString('hex'),
      role: info.role,
      client: info.client,
      worktree: info.worktree === null ? null : await canonical(info.worktree),
      pin: info.pin,
      node: info.node ?? process.version,
      path_source: info.pathSource,
      registered_at: Date.now(),
    };
    const file = path.join(this.dir, `${pid}-${record.nonce}.json`);
    await writeFileAtomic(file, `${JSON.stringify(record)}\n`);
    let current = record;
    return {
      get record() {
        return current;
      },
      update: async (changes) => {
        current = { ...current, ...changes };
        await writeFileAtomic(file, `${JSON.stringify(current)}\n`);
        return current;
      },
      unregister: async () => {
        await removeFile(file);
      },
    };
  }

  /** Every record, each with whether it is live. */
  async list(): Promise<{ record: ProcessRecord; live: boolean }[]> {
    return (await this.evaluate()).map(({ record, live }) => ({ record, live }));
  }

  private async evaluate(): Promise<{ file: string; record: ProcessRecord; live: boolean }[]> {
    const entries = await this.read();
    const local = entries.filter((e) => e.record.host === this.host);
    const verdicts = await liveProcesses(local.map((e) => e.record));
    const live = new Map(local.map((e, i) => [e.file, verdicts[i]!]));
    return entries.map((e) => ({ ...e, live: live.get(e.file) ?? true }));
  }

  /** Live processes, optionally only those matching every given field. */
  async live(filter: ProcessFilter = {}): Promise<ProcessRecord[]> {
    const worktree = filter.worktree === undefined ? undefined : comparable(await canonical(filter.worktree));
    return (await this.list())
      .filter(({ record, live }) => {
        if (!live) return false;
        if (filter.role !== undefined && record.role !== filter.role) return false;
        if (filter.client !== undefined && record.client !== filter.client) return false;
        if (filter.pin !== undefined && record.pin !== filter.pin) return false;
        if (worktree !== undefined && (record.worktree === null || comparable(record.worktree) !== worktree)) {
          return false;
        }
        return true;
      })
      .map(({ record }) => record);
  }

  /** Live processes among the records `match` picks; only those are checked for liveness (cheap when none match). */
  async liveWhere(match: (record: ProcessRecord) => boolean): Promise<ProcessRecord[]> {
    const entries = (await this.read()).filter((e) => match(e.record));
    const local = entries.filter((e) => e.record.host === this.host);
    const verdicts = await liveProcesses(local.map((e) => e.record));
    const gone = new Set(local.filter((_, i) => !verdicts[i]).map((e) => e.file));
    return entries.filter((e) => !gone.has(e.file)).map((e) => e.record);
  }

  /** Records whose process is gone. */
  async stale(): Promise<ProcessRecord[]> {
    return (await this.list()).filter((e) => !e.live).map((e) => e.record);
  }

  /** Removes the stale records and returns them. */
  async prune(): Promise<ProcessRecord[]> {
    const stale = (await this.evaluate()).filter((e) => !e.live);
    await Promise.all(stale.map((e) => removeFile(e.file)));
    return stale.map((e) => e.record);
  }

  private async read(): Promise<{ file: string; record: ProcessRecord }[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const entries: { file: string; record: ProcessRecord }[] = [];
    for (const name of names.sort()) {
      if (isTempName(name) || !name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      const record = parseRecord(await readTextIfExists(file));
      if (record) entries.push({ file, record });
    }
    return entries;
  }
}

function parseRecord(text: string | undefined): ProcessRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<ProcessRecord> | null;
    if (
      !value ||
      typeof value.pid !== 'number' ||
      typeof value.start_time !== 'number' ||
      typeof value.host !== 'string' ||
      typeof value.nonce !== 'string'
    ) {
      return undefined;
    }
    return value as ProcessRecord;
  } catch {
    return undefined;
  }
}

async function startTimeOf(pid: number): Promise<number> {
  if (pid === process.pid) return currentProcessStartTime();
  return (await processStartTimes([pid])).get(pid) ?? Date.now();
}

async function canonical(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
