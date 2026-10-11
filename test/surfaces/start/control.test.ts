// The control channel's client (spec §12, §20; spike D R5): what `open` and a
// second `start` get when the running `start` can't answer. instance.test.ts
// drives the channel end to end against a real `start`.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { callControl, ControlError, controlPaths, findControlPaths, posixControlDirs, serveControl } from '../../../src/surfaces/start/control';

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

  test('outside Windows, a client looks for the socket where any process of this user may have put it, its own choice first', () => {
    expect(posixControlDirs({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000)).toEqual(['/run/user/1000/grimoire', '/tmp/grimoire-1000']);
    // Started from a desktop session (XDG_RUNTIME_DIR set), reached from a shell without it, or the other way round.
    expect(posixControlDirs({}, 1000)).toEqual(['/tmp/grimoire-1000', '/run/user/1000/grimoire']);
    expect(posixControlDirs({ XDG_RUNTIME_DIR: '/home/me/.run' }, 1000)).toEqual(['/home/me/.run/grimoire', '/run/user/1000/grimoire', '/tmp/grimoire-1000']);
    expect(posixControlDirs({ XDG_RUNTIME_DIR: 'relative' }, 1000)).toEqual(['/tmp/grimoire-1000', '/run/user/1000/grimoire']);
  });

  test.skipIf(process.platform === 'win32')('outside Windows, a client without the start’s XDG_RUNTIME_DIR still reaches it; a directory others can use is never trusted', async () => {
    const runtime = await mkdtemp('/tmp/grt-');
    const open = await mkdtemp('/tmp/grt-');
    const cloneId = randomBytes(32).toString('hex');
    const nonce = randomBytes(8).toString('hex');
    // start without XDG_RUNTIME_DIR: /tmp/grimoire-<uid>.
    const server = await serveControl(controlPaths(cloneId, nonce, {}), async () => ({ answer: { result: { ok: true } } }));
    try {
      const found = await findControlPaths(cloneId, nonce, { XDG_RUNTIME_DIR: runtime });
      const answer = await callControl(found!, 'sign-in');
      // A socket and secret in a directory others can use (0755) are passed over.
      const squatted = controlPaths(cloneId, 'f'.repeat(16), { XDG_RUNTIME_DIR: open });
      await chmod(open, 0o755);
      await mkdir(squatted.dir, { mode: 0o755 });
      await chmod(squatted.dir, 0o755);
      await writeFile(squatted.secretFile, `${'d'.repeat(64)}\n`);
      const squatter = net.createServer();
      await new Promise<void>((resolve) => squatter.listen(squatted.endpoint, resolve));
      const elsewhere = await findControlPaths(cloneId, 'f'.repeat(16), { XDG_RUNTIME_DIR: open });
      await new Promise((resolve) => squatter.close(resolve));

      expect(found?.dir).toBe(server.paths.dir);
      expect(answer).toEqual({ ok: true });
      expect(elsewhere).toBeNull();
    } finally {
      await server.close();
      await removeDir(runtime);
      await removeDir(open);
    }
  });
});
