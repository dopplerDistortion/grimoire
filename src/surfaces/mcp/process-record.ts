// A launched `grimoire mcp` registers itself in the clone's process records
// (spec §6, §11): which version it runs from which worktree, and the Node it
// runs on. Pruning never removes a copy a live server runs (a server loads its
// core lazily, from its copy's chunks), and status/doctor report the records.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { VERSION } from '../../version';

export interface ServerRecordInfo {
  /** `<git-common-dir>/grimoire`. */
  readonly home: string;
  /** The worktree the server runs from. */
  readonly root: string;
}

/** Registers this process (role `mcp`); the record goes when the process exits. Best effort: never throws. */
export async function recordServer(info: ServerRecordInfo): Promise<void> {
  try {
    const { MachineLocalStore } = await import('../../machine-local');
    const store = new MachineLocalStore(path.dirname(info.home));
    const { record } = await store.processes.register({ role: 'mcp', client: null, worktree: info.root, pin: VERSION, pathSource: null });
    const file = path.join(store.dir, 'processes', `${record.pid}-${record.nonce}.json`);
    // A record left by a killed server is stale by its pid, and pruned as such.
    process.once('exit', () => {
      try {
        rmSync(file, { force: true });
      } catch {
        // Gone already, or the folder is locked: stale either way.
      }
    });
  } catch {
    // A server that can't write its record still serves.
  }
}
