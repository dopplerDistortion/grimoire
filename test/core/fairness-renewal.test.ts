// The fairness lock's heartbeat against its release (spec §4, Write path): a
// renewal still under way when the lock is let go must not write it back as
// held. One that did would hold up every writer, this process's next write
// first, until the lock lapsed ABANDONED_AFTER_MS later: on a loaded machine,
// where a renewal's write takes long, that happened to writes that held the
// lock for a heartbeat or more.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { MachineLocalStore } from '../../src/machine-local';
import { FAIRNESS_LOCK, FairnessLock, HEARTBEAT_MS } from '../../src/tracker/locks';

afterEach(() => {
  vi.useRealTimers();
});

describe('the fairness lock', () => {
  test('let go while its heartbeat renews it, it is free', async () => {
    const commonDir = await makeTempDir('grimoire-fairness-');
    try {
      const fairness = new FairnessLock(commonDir);
      const locks = new MachineLocalStore(commonDir).locks;
      // Only the heartbeat's clock is faked: each round has a renewal start, and the release follow at once.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      for (let round = 0; round < 30; round++) {
        const lock = await fairness.acquire(Date.now() + 10_000);
        expect(lock).not.toBeNull();
        vi.advanceTimersByTime(HEARTBEAT_MS);

        await lock!.release();

        expect(await locks.inspect(FAIRNESS_LOCK)).toEqual({ status: 'free' });
      }
    } finally {
      await removeDir(commonDir);
    }
  });
});
