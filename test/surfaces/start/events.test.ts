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

  gitTest('a check that can’t read the commits between the tips sends reload, never drops the move', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    // git can't even start where nothing exists: every diff fails.
    const served = await serveLive(path.join(world.root, 'gone'), machineDir);
    try {
      const events = await SseClient.connect(served.port, '');
      await events.next((event) => event.event === 'ready');
      served.tips = { local: B, remote: null };
      const moved = await events.next((event) => event.event !== 'ready');
      events.close();

      expect(moved.event).toBe('reload');
      expect(moved.id).toMatch(new RegExp(`^${B}:0:[0-9a-f]{12}$`));
      expect(moved.data).toEqual({ tips: { local: B, remote: null } });
    } finally {
      await served.close();
    }
  });

  gitTest('a resume that can’t read the commits it missed gets reload', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    const served = await serveLive(path.join(world.root, 'gone'), machineDir);
    try {
      const first = await SseClient.connect(served.port, '');
      const ready = await first.next((event) => event.event === 'ready');
      first.close();
      served.tips = { local: B, remote: null };
      const resumed = await SseClient.connect(served.port, '', ready.id!);
      const answer = await resumed.next(() => true);
      resumed.close();

      expect(answer.event).toBe('reload');
      expect(answer.id).toMatch(new RegExp(`^${B}:0:[0-9a-f]{12}$`));
    } finally {
      await served.close();
    }
  });
});

type Git = (args: readonly string[], options?: { input?: string }) => Promise<string>;

/** Makes commits in `git`'s repo whose messages carry `Grimoire-Op: <op>` and `trailers`, each on `parent` (or a root). */
async function committer(git: Git): Promise<(parent: string | null, op: string, trailers?: Record<string, string>) => Promise<string>> {
  const tree = await git(['mktree'], { input: '' });
  return (parent, op, trailers = {}) => {
    const lines = [`Grimoire-Op: ${op}`, ...Object.entries(trailers).map(([key, value]) => `${key}: ${value}`)];
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', [op, '', ...lines, ''].join('\n')]);
  };
}

describe('live events: what a change carries', () => {
  gitTest('each op names what the dashboard refetches: knowledge decisions set knowledge, settings set settings, issue writes name their issue', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    const commit = await committer(world.a.git.bind(world.a));
    let tip = await commit(null, 'init');
    const served = await serveLive(world.a.dir, machineDir);
    served.tips = { local: tip, remote: null };
    try {
      const events = await SseClient.connect(served.port, '');
      await events.next((event) => event.event === 'ready');
      const changeOf = async (op: string, trailers: Record<string, string> = {}) => {
        const from = events.events.length;
        tip = await commit(tip, op, trailers);
        served.tips = { local: tip, remote: null };
        const event = await events.next((candidate) => candidate.id?.startsWith(tip) === true, 10_000, from);
        return { event: event.event, ...event.data };
      };

      // A knowledge decision carries no Grimoire-Issue: only the flag tells the Knowledge views.
      const accepted = await changeOf('accept');
      const settings = await changeOf('settings-set');
      const deleted = await changeOf('delete', { 'Grimoire-Issue': 'gr-7k2pq' });
      const claimed = await changeOf('claim', { 'Grimoire-Issue': 'gr-7k2pq', 'Grimoire-Attempt': 'at-abc234', 'Grimoire-Actor': '{"kind":"agent","client":"claude-code"}' });
      events.close();

      expect(accepted).toMatchObject({ event: 'change', knowledge: true, settings: false, issues: [] });
      expect(settings).toMatchObject({ event: 'change', knowledge: false, settings: true, issues: [] });
      expect(deleted).toMatchObject({ event: 'change', knowledge: false, settings: false, issues: ['gr-7k2pq'], agent: false });
      expect(claimed).toMatchObject({ event: 'change', knowledge: false, issues: ['gr-7k2pq'], attempts: ['at-abc234'], agent: true });
    } finally {
      await served.close();
    }
  });

  gitTest('a fold, a purge, an op this release doesn’t know or a large jump sends reload', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    const commit = await committer(world.a.git.bind(world.a));
    let tip = await commit(null, 'init');
    const served = await serveLive(world.a.dir, machineDir, { largeJump: 3 });
    served.tips = { local: tip, remote: null };
    try {
      const events = await SseClient.connect(served.port, '');
      await events.next((event) => event.event === 'ready');
      const after = async (ops: string[]) => {
        const from = events.events.length;
        for (const op of ops) tip = await commit(tip, op, { 'Grimoire-Issue': 'gr-7k2pq' });
        served.tips = { local: tip, remote: null };
        return (await events.next((candidate) => candidate.id?.startsWith(tip) === true, 10_000, from)).event;
      };

      const fold = await after(['update', 'fold']);
      const purge = await after(['purge']);
      const unknown = await after(['a-later-release-op']);
      const small = await after(['update', 'update', 'update']);
      const large = await after(['update', 'update', 'update', 'update']);
      events.close();

      expect({ fold, purge, unknown, small, large }).toEqual({ fold: 'reload', purge: 'reload', unknown: 'reload', small: 'change', large: 'reload' });
    } finally {
      await served.close();
    }
  });

  gitTest('every stream gets a heartbeat', async ({ world }) => {
    const machineDir = path.join(world.root, 'machine');
    await mkdir(machineDir, { recursive: true });
    const served = await serveLive(world.a.dir, machineDir, { heartbeatMs: 100 });
    try {
      const events = await SseClient.connect(served.port, '');
      const heartbeat = await events.next((event) => event.event === 'heartbeat');
      events.close();

      expect(heartbeat.data).toEqual({});
    } finally {
      await served.close();
    }
  });
});
