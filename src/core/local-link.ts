// `local_link` (spec §3 Links, §20): the dashboard URL of an issue on this
// machine. Never committed. The port comes from a live, non-stale `start`
// lock (its pid alive and its port echoing its nonce), else the
// `dashboard.port` machine setting, else the clone's hashed default.
import { defaultDashboardPort, MachineLocalStore, runningStart } from '../machine-local';

function asPort(value: unknown): number | null {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * The dashboard port any process of this clone links to. Reading the
 * `dashboard.port` setting is a records read, so a machine marker outside this
 * release's range gives UPGRADE_REQUIRED (marker `machine`).
 */
export async function dashboardPort(commonDir: string): Promise<number> {
  const store = new MachineLocalStore(commonDir);
  const running = await runningStart(store);
  if (running !== null) return running.port;
  const setting = asPort(await store.records.read('machine-settings', 'dashboard.port'));
  return setting ?? (await defaultDashboardPort(commonDir));
}

export function localLink(port: number, id: string): string {
  return `http://127.0.0.1:${port}/issues/${id}`;
}
