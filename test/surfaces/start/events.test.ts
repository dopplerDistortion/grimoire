// The live events' failure paths (spec §20, SSE), driven through `LiveEvents`
// on an in-process HTTP server: a git that fails can't be staged through a
// spawned `start`. live.test.ts covers the same stream end to end.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { LiveEvents, type LiveEventsOptions } from '../../../src/surfaces/start/events';
import type { TrackerTips } from '../../../src/tracker';
import { SseClient } from './support';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

interface Served {
  readonly port: number;
  /** The tips the next read sees. */
  tips: TrackerTips;
  /** Makes the next `count` tip reads throw. */
  failReads(count: number): void;
  close(): Promise<void>;
}

/** LiveEvents on 127.0.0.1, checking every 50 ms; `root` is where its git runs. */
async function serveLive(root: string, machineDir: string, options: Partial<LiveEventsOptions> = {}): Promise<Served> {
  let failing = 0;
  const served = {
    port: 0,
    tips: { local: A, remote: null } as TrackerTips,
    failReads: (count: number) => void (failing = count),
    close: async () => {},
  };
  const live = new LiveEvents({
    root,
    machineDir,
    tips: async () => {
      if (failing > 0) {
        failing--;
        throw new Error('git stopped answering');
      }
      return served.tips;
    },
    pin: async () => null,
    checkMs: 50,
    ...options,
  });
  const server = http.createServer((request, response) => {
    const last = request.headers['last-event-id'];
    live.attach(request, response, typeof last === 'string' ? last : null);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  served.port = (server.address() as AddressInfo).port;
  served.close = () =>
    new Promise<void>((resolve) => {
      live.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return served;
}

describe('live events when reading fails', () => {
  gitTest('a stream whose first read fails is ended, so the browser reconnects; the next connect gets ready', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    const served = await serveLive(world.a.dir, machineDir);
    try {
      served.failReads(1);
      const failed = await SseClient.connect(served.port, '');
      const ended = await Promise.race([failed.ended.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
      const again = await SseClient.connect(served.port, '');
      const ready = await again.next(() => true);
      again.close();

      expect(ended).toBe(true);
      expect(failed.events).toEqual([]);
      expect(ready.event).toBe('ready');
      expect(ready.id).toMatch(new RegExp(`^${A}:0:[0-9a-f]{12}$`));
    } finally {
      await served.close();
    }
  });
});
