// The `start` lock (spec §12, §6): the single-instance lock of a clone's
// `grimoire start`. Coordination data, frozen by the cross-pin contract: the
// holder's pid, process start time and host, plus `{port, nonce}`.
//
// It is stale only when its pid is gone on this host, or when its port fails
// a loopback health probe that must echo its nonce: `GET /health` on
// 127.0.0.1:<port> answers `{"service": "grimoire-start", "nonce": …}`. Every
// pin that reads the lock (`show`'s `local_link`, `open`, a second `start`)
// judges it the same way, so the probe's path and answer are part of the lock.
import http from 'node:http';
import { START_LOCK, type StartLockData } from './clone';
import type { StaleCheck } from './locks';
import type { Holder } from './slots';
import type { MachineLocalStore } from './store';

/** The health probe's path on a running `start`, outside `/api` (it needs no session). */
export const START_HEALTH_PATH = '/health';
/** What the probe's answer names as its service. */
export const START_SERVICE = 'grimoire-start';
/** How long the probe waits for an answer. */
export const START_PROBE_MS = 2_000;

/** A live `start`, as its lock shows it. */
export interface RunningStart {
  readonly port: number;
  readonly nonce: string;
  readonly pid: number;
  readonly host: string;
  /** When it took the lock, epoch ms. */
  readonly since: number;
}

/** The lock's `{port, nonce}`, or null when its holder wrote none that can be used. */
export function startLockData(holder: Holder): StartLockData | null {
  const port = holder.data?.port;
  const nonce = holder.data?.nonce;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65_536) return null;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{8,64}$/.test(nonce)) return null;
  return { port, nonce };
}

/**
 * Asks 127.0.0.1:`port` for its nonce: true when a `start` answers with
 * `nonce`, false for anything else (nothing listening, another server, another
 * start, no answer within `timeoutMs`).
 */
export function probeStart(port: number, nonce: string, timeoutMs = START_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: START_HEALTH_PATH, headers: { host: `127.0.0.1:${port}`, accept: 'application/json' }, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4_096) return void response.destroy();
          chunks.push(chunk);
        });
        response.on('error', () => done(false));
        response.on('end', () => {
          if (response.statusCode !== 200) return done(false);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { service?: unknown; nonce?: unknown };
            done(body.service === START_SERVICE && body.nonce === nonce);
          } catch {
            done(false);
          }
        });
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      done(false);
    }, timeoutMs);
    timer.unref();
    request.on('error', () => done(false));
  });
}

/** The start lock's further staleness check: a holder whose port doesn't echo its nonce holds nothing. */
export function startStaleness(timeoutMs = START_PROBE_MS): StaleCheck {
  return async (holder) => {
    const data = startLockData(holder);
    return data === null || !(await probeStart(data.port, data.nonce, timeoutMs));
  };
}

/** The clone's live `start`, or null when its lock is free or stale. */
export async function runningStart(store: MachineLocalStore, options: { readonly probeMs?: number } = {}): Promise<RunningStart | null> {
  const state = await store.locks.inspect(START_LOCK, { staleIf: startStaleness(options.probeMs) });
  if (state.status !== 'held') return null;
  const data = startLockData(state.holder);
  if (data === null) return null;
  return { ...data, pid: state.holder.pid, host: state.holder.host, since: state.holder.acquired_at };
}
