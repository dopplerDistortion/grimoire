// The error envelope against the clock: a write the process can't make fails at
// once, well inside the write budget, not as BUSY once it is spent. In the serial
// `slow` project (npm run test:slow); the rest is in errors.test.ts.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { makeUnwritable, permissionsApply } from '#harness';
import { coreTest as test, expectRefUnmoved } from './support';

describe('error envelope: an error means nothing changed', () => {
  test.skipIf(!permissionsApply)('a ref the process can’t move gives NOT_WRITABLE at once, not BUSY', async ({ world, grimoire }) => {
    const restore = await makeUnwritable(path.join(world.a.dir, '.git', 'refs'));
    try {
      const started = Date.now();
      const write = await expectRefUnmoved(world.a, () => grimoire.core.call('create', { title: 'x' }, grimoire.ctx));
      expect(write).toMatchObject({ ok: false, error: { code: 'NOT_WRITABLE' } });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await restore();
    }
  });
});
