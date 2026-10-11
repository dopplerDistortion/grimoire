// Seam 3, timed (spec §20, SSE): a tracker write by another process reaches a
// live stream within ~2 s. It runs after every other file, with the machine
// to itself (vitest.config.ts); live.test.ts checks what the event carries.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { coreTest } from '../../core/support';
import { buildFull, signedIn, spawnStart, SseClient, startEnv, stopStart } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

describe('start: live events, timed', () => {
  coreTest('a tracker write by another process reaches the stream within ~2 s', async ({ world, grimoire }) => {
    const { env } = await startEnv(world.root);
    const commonDir = path.join(world.a.dir, '.git');
    const start = await spawnStart(bin, world.a.dir, env);
    try {
      const events = await SseClient.connect(start.port, await signedIn(start.port, commonDir, env));
      await events.next((event) => event.event === 'ready');

      const created = await grimoire.makeCore().call('create', { title: 'Written by another process' }, grimoire.ctx);
      const written = Date.now();
      const change = await events.next((event) => event.event === 'change');
      events.close();

      expect(created.ok).toBe(true);
      // The tips are checked about every second: ~2 s, with room for a slow spawn.
      expect(change.receivedAt - written).toBeLessThan(3_000);
    } finally {
      await stopStart(start, commonDir, env);
    }
  });
});
