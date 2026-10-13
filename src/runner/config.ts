// The runner's machine-local config (spec §6 Records: "machine settings and
// runner config"; §16 Enabling): which client this clone's runner starts, by
// absolute binary path, whether API billing is allowed, and the model. One
// record per clone, shared by every worktree and pin.
import type { MachineLocalStore } from '../machine-local';

export const RUNNER_KINDS = ['claude', 'codex'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export interface RunnerConfig {
  readonly kind: RunnerKind;
  /** The platform binary's absolute path (the `.exe` on Windows, never a `.cmd` shim). */
  readonly binary: string;
  /** Whether a run may bill an API key, a token or a cloud provider instead of the plan. */
  readonly allow_api_billing: boolean;
  /** The model to ask for (`--model` / `-m`), or null for the client's own default. */
  readonly model: string | null;
  /** When `runner enable` stored it. */
  readonly enabled_at: string;
  /** The auth method the preflight saw at enable time. */
  readonly auth_method: string | null;
}

const KIND = 'runner-config';
const KEY = 'runner';

export function isRunnerKind(value: unknown): value is RunnerKind {
  return typeof value === 'string' && (RUNNER_KINDS as readonly string[]).includes(value);
}

/** The runner config, or null when no runner is enabled (or the record isn't one this release reads). */
export async function readRunnerConfig(store: MachineLocalStore): Promise<RunnerConfig | null> {
  const value = await store.records.read<Partial<RunnerConfig>>(KIND, KEY);
  if (!value || !isRunnerKind(value.kind) || typeof value.binary !== 'string') return null;
  return {
    kind: value.kind,
    binary: value.binary,
    allow_api_billing: value.allow_api_billing === true,
    model: typeof value.model === 'string' && value.model !== '' ? value.model : null,
    enabled_at: typeof value.enabled_at === 'string' ? value.enabled_at : '',
    auth_method: typeof value.auth_method === 'string' ? value.auth_method : null,
  };
}

export async function writeRunnerConfig(store: MachineLocalStore, config: RunnerConfig): Promise<void> {
  await store.records.write(KIND, KEY, config);
}

/** Removes the config; returns what was there. */
export async function removeRunnerConfig(store: MachineLocalStore): Promise<RunnerConfig | null> {
  const was = await readRunnerConfig(store);
  await store.records.remove(KIND, KEY);
  return was;
}
