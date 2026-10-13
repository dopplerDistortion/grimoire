// What `status` shows of the runner (spec §16 Caps: both caps shown in
// status; Billing guard: an allowed API-billing auth method is shown).
// Read-only: the client is never started for it.
import type { Json, MachineLocalStore } from '../machine-local';
import { capState } from './caps';
import { readRunnerConfig } from './config';

export async function runnerStatus(store: MachineLocalStore, now: Date): Promise<{ value: Json; lines: string[] }> {
  const config = await readRunnerConfig(store);
  const caps = await capState(store, now);
  if (config === null) return { value: { enabled: false, runs_today: caps.runs_today, runs_per_day: caps.runs_per_day }, lines: [] };
  const authMethod = caps.last?.auth_method ?? config.auth_method;
  const billed = authMethod !== null && authMethod !== 'claude.ai' && authMethod !== 'chatgpt';
  const value: Json = {
    enabled: true,
    kind: config.kind,
    binary: config.binary,
    model: config.model,
    allow_api_billing: config.allow_api_billing,
    auth_method: authMethod,
    bills_api: billed,
    runs_today: caps.runs_today,
    runs_per_day: caps.runs_per_day,
    next_run_at: caps.next_run_at,
    consecutive_failures: caps.consecutive_failures,
    paused_until: caps.paused_until,
    last: caps.last as unknown as Json,
  };
  const lines = [
    `Runner: ${config.kind} (${config.binary}), ${caps.runs_today} of ${caps.runs_per_day} runs in the last 24 h${authMethod ? `, auth ${authMethod}` : ''}${billed ? ' (bills outside the plan: allowed with --allow-api-billing)' : ''}`,
  ];
  if (caps.paused_until !== null) lines.push(`  paused until ${caps.paused_until} after 2 failed runs in a row`);
  else if (caps.next_run_at !== null) lines.push(`  at its daily cap: the next run may start at ${caps.next_run_at}`);
  if (caps.last) lines.push(`  last run: ${caps.last.result}${caps.last.kind ? ` (${caps.last.kind}${caps.last.run ? ` ${caps.last.run}` : ''})` : ''} at ${caps.last.at}${caps.last.reason ? `: ${caps.last.reason}` : ''}`);
  return { value, lines };
}
