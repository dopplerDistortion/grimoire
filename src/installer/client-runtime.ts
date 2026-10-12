// The Node version and PATH source each agent client's servers ran with
// (spec §6, §11 Node): `node` 22+ must resolve on the PATH each client gives
// its servers and hooks, so a server records what it got once it knows its
// client, and `status` and `doctor` report it. Process records say the same
// while a server lives; this record keeps the last one per client after it
// exits.
import path from 'node:path';
import type { MachineLocalStore } from '../machine-local';

/** Records kind: per client name, the runtime its last server ran with. */
export const CLIENT_RUNTIME_RECORDS = 'client-runtime';

export interface ClientRuntime {
  /** The client's name as it introduced itself (`claude-code`, `codex-mcp-client`, …). */
  readonly client: string;
  /** `process.version` of the server. */
  readonly node: string;
  /** The folder of the `node` executable the client's PATH led to. */
  readonly path_source: string;
  /** The version the server ran. */
  readonly pin: string;
  readonly worktree: string | null;
  /** When it was recorded (epoch ms). */
  readonly at: number;
}

/** Where this process's `node` came from. */
export function pathSourceOf(execPath: string = process.execPath): string {
  return path.dirname(execPath);
}

/** Records the runtime of this process for `client`. */
export async function noteClientRuntime(store: MachineLocalStore, client: string, pin: string, worktree: string | null): Promise<void> {
  await store.records.write<ClientRuntime>(CLIENT_RUNTIME_RECORDS, client, {
    client,
    node: process.version,
    path_source: pathSourceOf(),
    pin,
    worktree,
    at: Date.now(),
  });
}

/** Every client's last recorded runtime, by client name. */
export async function readClientRuntimes(store: MachineLocalStore): Promise<ClientRuntime[]> {
  return (await store.records.list<ClientRuntime>(CLIENT_RUNTIME_RECORDS))
    .map((entry) => entry.value)
    .filter((value) => typeof value?.client === 'string' && typeof value.node === 'string');
}

/** The major version of a `process.version` string (`v22.3.0` → 22). */
export function nodeMajor(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}
