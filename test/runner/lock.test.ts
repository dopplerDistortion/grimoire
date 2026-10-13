// The clone-wide runner lock (spec §16 The runner): one run at a time per
// machine, and the lock is released whatever fails after it is taken, so a
// long-lived process (start, the dashboard) can trigger the runner again.
import { describe, expect, vi } from 'vitest';
import { runChores, storeAt } from '../../src/runner';
import { GrimoireError } from '../../src/errors';
import { coreTest as test } from '../core/support';
import { dueCompile, enabled, expectError } from './scenario';
import { authStatus } from './support';

const failing = vi.hoisted(() => ({ next: false }));

vi.mock('../../src/tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tracker')>();
  return {
    ...actual,
    openTracker: (...args: Parameters<typeof actual.openTracker>) => {
      if (failing.next) {
        failing.next = false;
        return Promise.reject(new GrimoireError('NO_REPO', 'git stopped answering', {}));
      }
      return actual.openTracker(...args);
    },
  };
});

describe('the runner lock', () => {
  test('is released when opening the tracker fails', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai') });

    failing.next = true;
    const error = await expectError(runChores({ root: world.a.dir, core: d.core, env: fake.env(), now: d.clock.now, due: true }));
    expect(error.message).toContain('git stopped answering');

    const store = await storeAt(world.a.dir);
    const again = await store.locks.acquire('runner', { waitMs: 0 });
    expect(again.status).toBe('acquired');
    if (again.status === 'acquired') await again.lock.release();
  });
});
