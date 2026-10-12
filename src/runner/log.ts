// The runner log (spec §16 Spawn: "stdout and stderr kept in a machine-local
// log"; Failures and replays: after a secret-scan failure the runner log
// drops that run's output). Records class, one document per run, the newest
// LOG_KEEP kept. The preflight's output is never logged: `codex login status`
// prints an API key partly masked, and `codex mcp list` a server's env.
import type { MachineLocalStore } from '../machine-local';

const KIND = 'runner-logs';
/** How many runs' logs are kept. */
export const LOG_KEEP = 20;

export interface SpawnLog {
  readonly code: number | null;
  readonly timed_out: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** The failure rule's reason, or null when the child answered. */
  readonly failure: string | null;
}

export interface RunnerLog {
  readonly run: string;
  readonly kind: string;
  readonly runner: string;
  readonly at: string;
  readonly result: string;
  readonly spawns: readonly SpawnLog[];
  /** A submit failed the secret scan: the output isn't kept. */
  readonly secretRefused: boolean;
}

/** Keeps a run's log; after a secret-scan failure, without the output. */
export async function keepRunnerLog(store: MachineLocalStore, log: RunnerLog): Promise<void> {
  const spawns = log.spawns.map((spawn) => (log.secretRefused ? { ...spawn, stdout: '', stderr: '', dropped: 'secret-scan' } : spawn));
  const { secretRefused: _drop, ...rest } = log;
  await store.records.write(KIND, `${log.at.replace(/[:.]/g, '-')}-${log.run}`, { ...rest, spawns, ...(log.secretRefused ? { dropped: 'secret-scan' } : {}) });
  const entries = await store.records.list(KIND);
  for (const entry of entries.slice(0, Math.max(0, entries.length - LOG_KEEP))) await store.records.remove(KIND, entry.key);
}

/** The kept runner logs, oldest first. */
export async function readRunnerLogs(store: MachineLocalStore): Promise<RunnerLog[]> {
  return (await store.records.list<RunnerLog>(KIND)).map((entry) => entry.value);
}
