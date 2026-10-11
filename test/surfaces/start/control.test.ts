// The control channel's client (spec §12, §20; spike D R5): what `open` and a
// second `start` get when the running `start` can't answer. instance.test.ts
// drives the channel end to end against a real `start`.
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { callControl, ControlError } from '../../../src/surfaces/start/control';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the control channel client', () => {
  test('a connect that never completes (a pipe whose instances are all busy) times out as unreachable', async () => {
    const dir = await makeTempDir('grimoire-control-');
    try {
      const secretFile = path.join(dir, 'clone.secret');
      await writeFile(secretFile, `${'c'.repeat(64)}\n`);
      // The OS never completes the connect: libuv waits on a busy pipe, a blackholed socket hangs.
      vi.spyOn(net, 'connect').mockImplementation(() => new net.Socket());

      const started = Date.now();
      const outcome = await Promise.race([
        callControl({ endpoint: path.join(dir, 'never.sock'), secretFile, dir }, 'sign-in', {}, { timeoutMs: 300 }).catch((error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5_000)),
      ]);

      expect(outcome).toBeInstanceOf(ControlError);
      expect((outcome as ControlError).reason).toBe('unreachable');
      expect((outcome as ControlError).message).toMatch(/didn’t answer within 0\.3 s/);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await removeDir(dir);
    }
  });
});
