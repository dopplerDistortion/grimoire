// A launched `grimoire mcp` registers itself in the clone's process records
// (spec §6, §11): which version it runs from which worktree, and the Node it
// runs on. Pruning never removes a copy a live server runs (a server loads its
// core lazily, from its copy's chunks), and status/doctor report the records.
// The record names the agent client once the server learns it from its first
// call (`clientInfo`): never before the opening is answered.
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { ProcessRegistration } from '../../machine-local';
import { VERSION } from '../../version';

export interface ServerRecordInfo {
  /** `<git-common-dir>/grimoire`. */
  readonly home: string;
  /** The worktree the server runs from. */
  readonly root: string;
}

/** This process's registration, once `recordServer` started it; null when there is none to fill. */
let registration: Promise<ProcessRegistration | null> | null = null;
/** The client already written to the record. */
let noted: string | null = null;

/** Registers this process (role `mcp`); the record goes when the process exits. Best effort: never throws. */
export async function recordServer(info: ServerRecordInfo): Promise<void> {
  registration = register(info);
  await registration;
}

async function register(info: ServerRecordInfo): Promise<ProcessRegistration | null> {
  try {
    const { MachineLocalStore } = await import('../../machine-local');
    const store = new MachineLocalStore(path.dirname(info.home));
    const registered = await store.processes.register({ role: 'mcp', client: null, worktree: info.root, pin: VERSION, pathSource: null });
    const file = path.join(store.dir, 'processes', `${registered.record.pid}-${registered.record.nonce}.json`);
    // A record left by a killed server is stale by its pid, and pruned as such.
    process.once('exit', () => {
      try {
        rmSync(file, { force: true });
      } catch {
        // Gone already, or the folder is locked: stale either way.
      }
    });
    return registered;
  } catch {
    // A server that can't write its record still serves.
    return null;
  }
}

/**
 * Names the connecting agent client (`clientInfo.name`) in this server's
 * record, once. A server started without a record (the bare bin) has nothing
 * to fill. Best effort: never throws.
 */
export async function noteServerClient(client: string): Promise<void> {
  if (registration === null || noted !== null) return;
  noted = client;
  try {
    await (await registration)?.update({ client });
  } catch {
    // The record keeps a null client: status shows the server without one.
  }
}
