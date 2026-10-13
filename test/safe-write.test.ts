// Safe writes into a checkout (spec §13 Safe writes): compare-and-swap through
// a temp file, a re-check and a rename, never through a link. Seam 1: the
// safe write called directly, with a plan that went stale before it ran, and
// with a person's save landing between its re-check and its move.
import * as fsp from 'node:fs/promises';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { readCheckoutText, safeWrite } from '../src/safe-write';

// Lets a test land a save right before the write's next rename or hard link that touches the file.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let root: string;
let elsewhere: string;
beforeEach(async () => {
  root = await makeTempDir('grimoire-safe-write-');
  elsewhere = await makeTempDir('grimoire-safe-write-elsewhere-');
});
afterEach(async () => {
  vi.mocked(fsp.rename).mockImplementation(actualFs.rename);
  vi.mocked(fsp.link).mockImplementation(actualFs.link);
  await removeDir(root);
  await removeDir(elsewhere);
});

/**
 * A person saves `text` to `file` the moment before the safe write's first
 * rename or hard link that names `file`: after every check it makes, before
 * its move.
 */
function saveBeforeTheMove(file: string, text: string): void {
  let saved = false;
  const save = async (...paths: unknown[]) => {
    if (!saved && paths.some((p) => path.resolve(String(p)) === path.resolve(file))) {
      saved = true;
      await actualFs.writeFile(file, text);
    }
  };
  vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
    await save(from, to);
    return actualFs.rename(from, to);
  });
  vi.mocked(fsp.link).mockImplementation(async (from, to) => {
    await save(from, to);
    return actualFs.link(from, to);
  });
}

/** Every file below `dir`, as POSIX paths: a temp file left behind would show here. */
async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

describe('a safe write', () => {
  it('replaces the file when it still holds what the plan saw, leaving no temp file', async () => {
    await mkdir(path.join(root, 'rules'));
    await writeFile(path.join(root, 'rules/grimoire.md'), 'old\n');

    expect(await safeWrite(root, 'rules/grimoire.md', 'old\n', 'new\n')).toBeNull();

    expect(await readFile(path.join(root, 'rules/grimoire.md'), 'utf8')).toBe('new\n');
    expect(await filesIn(root)).toEqual(['rules/grimoire.md']);
  });

  it('leaves a file that changed after the plan untouched', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'what the plan saw\n');
    const plan = await readCheckoutText(path.join(root, 'AGENTS.md'));
    if (plan.state !== 'text') throw new Error('not read as text');
    await writeFile(path.join(root, 'AGENTS.md'), 'the person’s edit\n');

    expect(await safeWrite(root, 'AGENTS.md', plan.text, 'shipped\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('the person’s edit\n');
    expect(await filesIn(root)).toEqual(['AGENTS.md']);
  });

  it('compares bytes: a file whose bytes only decode to what the plan saw is left alone', async () => {
    // An ANSI é decodes, lossily, to U+FFFD.
    const bytes = Buffer.from('Règles\n', 'latin1');
    await writeFile(path.join(root, 'AGENTS.md'), bytes);

    expect(await safeWrite(root, 'AGENTS.md', 'R�gles\n', 'shipped\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'))).toEqual(bytes);
  });

  it('leaves a file that appeared after a plan that saw none', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'mine\n');

    expect(await safeWrite(root, 'AGENTS.md', null, 'shipped\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('mine\n');
  });

  it('never writes through a folder swapped for a link after the plan', async () => {
    await mkdir(path.join(root, 'rules'));
    await writeFile(path.join(root, 'rules/grimoire.md'), 'old\n');
    await writeFile(path.join(elsewhere, 'grimoire.md'), 'old\n');
    await rm(path.join(root, 'rules'), { recursive: true });
    // A junction on Windows (no privilege needed), a symlink elsewhere.
    await symlink(elsewhere, path.join(root, 'rules'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(await safeWrite(root, 'rules/grimoire.md', 'old\n', 'new\n')).toEqual({ reason: 'link', at: 'rules' });

    expect(await readFile(path.join(elsewhere, 'grimoire.md'), 'utf8')).toBe('old\n');
    expect(await filesIn(elsewhere)).toEqual(['grimoire.md']);
  });

  it('leaves a folder where the file was', async () => {
    await mkdir(path.join(root, 'AGENTS.md'));

    expect(await safeWrite(root, 'AGENTS.md', 'old\n', 'new\n')).toEqual({ reason: 'not-a-file' });

    expect(await filesIn(root)).toEqual([]);
  });

  it('a save landing after the re-check of a new file stands: the write is left alone as changed', async () => {
    saveBeforeTheMove(path.join(root, 'AGENTS.md'), 'saved just now\n');

    expect(await safeWrite(root, 'AGENTS.md', null, 'shipped\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('saved just now\n');
    expect(await filesIn(root)).toEqual(['AGENTS.md']);
  });

  it('a save landing after the re-check of a file it replaces stands: the write is left alone as changed', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'what the plan saw\n');
    saveBeforeTheMove(path.join(root, 'AGENTS.md'), 'saved just now\n');

    expect(await safeWrite(root, 'AGENTS.md', 'what the plan saw\n', 'shipped\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('saved just now\n');
    expect(await filesIn(root)).toEqual(['AGENTS.md']);
  });

  it('writes on a file system without hard links, creating and replacing', async () => {
    vi.mocked(fsp.link).mockRejectedValue(Object.assign(new Error('ENOTSUP: injected'), { code: 'ENOTSUP' }));

    expect(await safeWrite(root, 'AGENTS.md', null, 'first\n')).toBeNull();
    expect(await safeWrite(root, 'AGENTS.md', 'first\n', 'second\n')).toBeNull();
    expect(await safeWrite(root, 'AGENTS.md', 'first\n', 'third\n')).toEqual({ reason: 'changed' });

    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('second\n');
    expect(await filesIn(root)).toEqual(['AGENTS.md']);
  });

  it('fails without leaving its temp file when the folder can’t be made', async () => {
    await writeFile(path.join(root, 'rules'), 'a file where a folder goes\n');

    await expect(safeWrite(root, 'rules/grimoire.md', null, 'new\n')).rejects.toThrow();

    expect(await filesIn(root)).toEqual(['rules']);
  });
});

describe('reading a checkout file as text', () => {
  it('reads UTF-8, a UTF-8 byte order mark kept', async () => {
    await writeFile(path.join(root, 'a.md'), '﻿Règles\r\n');
    expect(await readCheckoutText(path.join(root, 'a.md'))).toEqual({ state: 'text', text: '﻿Règles\r\n' });
    expect(await readCheckoutText(path.join(root, 'missing.md'))).toEqual({ state: 'absent' });
  });

  it('counts UTF-16 (with or without a byte order mark) and ANSI bytes as not text', async () => {
    const files = {
      'bom.md': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Agents\n', 'utf16le')]),
      'plain16.md': Buffer.from('# Agents\n', 'utf16le'),
      'ansi.md': Buffer.from('Règles\n', 'latin1'),
    };
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(path.join(root, name), bytes);
      expect(await readCheckoutText(path.join(root, name)), name).toEqual({ state: 'not-text' });
    }
  });
});
