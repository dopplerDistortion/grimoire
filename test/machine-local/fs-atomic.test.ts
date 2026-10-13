// Seam 1: the one retry every machine-local rename, unlink and read goes
// through, fed injected errors (an antivirus or a reader holding a file open
// is what gives them on Windows); and the exclusive create a slot's every
// generation is written with, fed injected hard-link failures.
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { retryTransient } from '../../src/machine-local';
import { createFileExclusive } from '../../src/machine-local/fs-atomic';

// Lets a test make the next hard links fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
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

describe('createFileExclusive', () => {
  let dir: string | undefined;
  afterEach(async () => {
    vi.mocked(fsp.link).mockReset();
    vi.mocked(fsp.link).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).link);
    if (dir) await removeDir(dir);
    dir = undefined;
  });

  /** Makes the next hard links fail with `codes`, one per link. */
  function linkFailsWith(...codes: string[]): void {
    for (const code of codes) vi.mocked(fsp.link).mockRejectedValueOnce(Object.assign(new Error(`${code}: injected`), { code }));
  }

  test.runIf(process.platform === 'win32')('on Windows, retries a hard link a reader held up, and the file appears whole', async () => {
    dir = await makeTempDir('grimoire-fs-atomic-');
    const file = path.join(dir, '7.json');
    linkFailsWith('EBUSY', 'EPERM');
    expect(await createFileExclusive(file, '{"owner":"a"}\n')).toBe(true);
    expect(fsp.link).toHaveBeenCalledTimes(3);
    expect(await fsp.readFile(file, 'utf8')).toBe('{"owner":"a"}\n');
  });

  test('falls back to an exclusive create only on a file system without hard links', async () => {
    dir = await makeTempDir('grimoire-fs-atomic-');
    const file = path.join(dir, '7.json');
    linkFailsWith('ENOTSUP');
    expect(await createFileExclusive(file, '{"owner":"a"}\n')).toBe(true);
    expect(await fsp.readFile(file, 'utf8')).toBe('{"owner":"a"}\n');
    linkFailsWith('ENOTSUP');
    expect(await createFileExclusive(file, '{"owner":"b"}\n')).toBe(false);
  });

  test('any other hard-link failure is an error, never a non-atomic create; no temp file is left', async () => {
    dir = await makeTempDir('grimoire-fs-atomic-');
    const file = path.join(dir, '7.json');
    linkFailsWith('EIO');
    await expect(createFileExclusive(file, '{"owner":"a"}\n')).rejects.toMatchObject({ code: 'EIO' });
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});
