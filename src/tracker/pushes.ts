// Pushes under way (spec §3 Delete and purge; §4 Sync): what a sync in this
// clone is pushing right now. A push sends a fixed commit, outside the
// fairness lock, for as long as the network takes; a purge in that window
// must count that commit as pushed (it is landing), or it would say "never
// pushed" and rewrite a segment the remote is about to hold. A sync records
// its commit under the fairness lock, after reading the local tip there, so
// either the purge committed first and the sync pushes the purged history, or
// the purge sees the push. A push whose outcome the sync never learned (its
// git timed out or failed unparsed, or the remote-tracking ref couldn't
// follow it) may have landed: its record stays, unsettled, owned by no
// process and expiring never, until a later sync has read what the remote
// holds into the remote-tracking ref. Coordination data, version-free:
// `<git-common-dir>/grimoire/coordination/tracker-push/<key>.json`.
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { MachineLocalStore } from '../machine-local';
import { readTextIfExists } from '../machine-local/fs-atomic';
import { isPidAlive } from '../machine-local/process-info';

const KIND = 'tracker-push';

/** One push under way: the commit it sends, and who sends it until when. */
interface PushRecord {
  readonly commit: string;
  readonly pid: number;
  readonly host: string;
  /** Epoch ms after which the push is over, landed or not (its timeout has killed it by then). */
  readonly expires_at: number;
  /** Epoch ms the push ended with its outcome unknown: it counts as pushed until a later sync settles it. */
  readonly unsettled_at?: number;
}

/** A recorded push: `done` lets go of its record once its outcome is known; `unsettled` keeps it when it isn't. */
export interface PushRecordHandle {
  done(): Promise<void>;
  unsettled(): Promise<void>;
}

export class PushesUnderWay {
  private readonly machine: MachineLocalStore;

  constructor(commonDir: string) {
    this.machine = new MachineLocalStore(commonDir);
  }

  /** Records a push of `commit` that ends within `ttlMs`. */
  async begin(commit: string, ttlMs: number): Promise<PushRecordHandle> {
    const key = `${process.pid}-${randomBytes(6).toString('hex')}`;
    const record: PushRecord = { commit, pid: process.pid, host: this.machine.host, expires_at: Date.now() + ttlMs };
    await this.machine.coordination.write(KIND, key, record);
    return {
      done: async () => {
        await this.machine.coordination.remove(KIND, key).catch(() => {});
      },
      // Best effort: a record that can't be rewritten stays as it was, counted while this process lives.
      unsettled: async () => {
        await this.machine.coordination.write(KIND, key, { ...record, unsettled_at: Date.now() }).catch(() => {});
      },
    };
  }

  /**
   * Lets go of the unsettled pushes that ended before `before` (epoch ms):
   * the caller has read what the remote held after that into the
   * remote-tracking ref, so a push that landed is there now.
   */
  async settle(before: number): Promise<void> {
    for (const { key, record } of await this.records()) {
      if (record?.unsettled_at !== undefined && record.unsettled_at < before) await this.machine.coordination.remove(KIND, key).catch(() => {});
    }
  }

  /**
   * The commits pushes under way are sending: records that haven't expired,
   * whose process lives (one on another host counts until it expires). A
   * folder that can't be listed is an error, never "no push".
   */
  async commits(): Promise<string[]> {
    const commits = new Set<string>();
    const now = Date.now();
    for (const { record } of await this.records()) {
      if (!record) continue;
      if (record.unsettled_at === undefined) {
        if (record.expires_at <= now) continue;
        if (record.host === this.machine.host && !isPidAlive(record.pid)) continue;
      }
      commits.add(record.commit);
    }
    return [...commits];
  }

  /** Every record, by key (null: unreadable). A folder that can't be listed is an error. */
  private async records(): Promise<{ key: string; record: PushRecord | null }[]> {
    const dir = path.join(this.machine.dir, 'coordination', KIND);
    const names = await readdir(dir).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [] as string[];
      throw error;
    });
    const found: { key: string; record: PushRecord | null }[] = [];
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      found.push({ key: name.slice(0, -'.json'.length), record: parse(await readTextIfExists(path.join(dir, name))) });
    }
    return found;
  }
}

function parse(text: string | undefined): PushRecord | null {
  if (text === undefined) return null;
  try {
    const value = (JSON.parse(text) as { value?: Partial<PushRecord> } | null)?.value;
    if (!value || typeof value.commit !== 'string' || typeof value.pid !== 'number' || typeof value.host !== 'string' || typeof value.expires_at !== 'number') return null;
    if (value.unsettled_at !== undefined && typeof value.unsettled_at !== 'number') return null;
    return value as PushRecord;
  } catch {
    return null;
  }
}
