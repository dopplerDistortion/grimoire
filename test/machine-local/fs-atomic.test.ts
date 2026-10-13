// Seam 1: the one retry every machine-local rename, unlink and read goes
// through, fed injected errors (an antivirus or a reader holding a file open
// is what gives them on Windows).
import { describe, expect, test } from 'vitest';
import { retryTransient } from '../../src/machine-local';

/** An operation that fails with `codes`, one per call, then succeeds. */
function failingWith(...codes: string[]): { op: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    op: async () => {
      const code = codes[calls++];
      if (code !== undefined) throw Object.assign(new Error(`${code}: injected`), { code });
      return 'done';
    },
    calls: () => calls,
  };
}

describe('retryTransient', () => {
  test('on Windows, retries EPERM, EBUSY and EACCES until the operation goes through', async () => {
    const { op, calls } = failingWith('EPERM', 'EBUSY', 'EACCES');
    await expect(retryTransient(op, { platform: 'win32' })).resolves.toBe('done');
    expect(calls()).toBe(4);
  });

  test('gives up once the budget runs out, with the last error', async () => {
    const { op, calls } = failingWith(...Array<string>(1_000).fill('EPERM'));
    await expect(retryTransient(op, { platform: 'win32', budgetMs: 50 })).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls()).toBeGreaterThan(1);
    expect(calls()).toBeLessThan(1_000);
  });

  test('never retries any other error, nor a sharing failure off Windows', async () => {
    const missing = failingWith('ENOENT');
    await expect(retryTransient(missing.op, { platform: 'win32' })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing.calls()).toBe(1);
    const elsewhere = failingWith('EPERM');
    await expect(retryTransient(elsewhere.op, { platform: 'linux' })).rejects.toMatchObject({ code: 'EPERM' });
    expect(elsewhere.calls()).toBe(1);
  });
});
