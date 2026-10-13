// Moving a foreign grimoire-* folder aside (spec §13; generated output) when
// the checkout sits on another volume than the git common dir: a rename can't
// cross volumes (EXDEV), so the folder is copied, then deleted. Seam 1: the
// reconcile called directly against a real checkout, with the volume boundary
// and a file an editor holds open injected at node:fs/promises.
import * as fsp from 'node:fs/promises';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, vi } from 'vitest';
import { gitTest } from '#harness';
import { MOVED_ASIDE, reconcileNotices, reconcileWorktree } from '../../src/generated';
import { MachineLocalStore } from '../../src/machine-local';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

afterEach(() => {
  vi.mocked(fsp.rename).mockImplementation(actualFs.rename);
  vi.mocked(fsp.rm).mockImplementation(actualFs.rm);
});

const FOLDER = '.claude/skills/grimoire-mine';
const NOTHING_SERVED = { delivery: true, skills: [], known: new Map() };

/** A hand-made grimoire-* folder in `dir`, and the machine-local store of its clone. */
async function foreignFolder(dir: string): Promise<{ store: MachineLocalStore; folder: string }> {
  const folder = path.join(dir, ...FOLDER.split('/'));
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), 'hand-made\n');
  await writeFile(path.join(folder, 'notes.md'), 'mine too\n');
  return { store: new MachineLocalStore(path.join(dir, '.git')), folder };
}

/** Renames of `folder` fail as they do across volumes. */
function anotherVolume(folder: string): void {
  vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
    if (path.resolve(String(from)) === path.resolve(folder)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    return actualFs.rename(from, to);
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('moving a folder aside across volumes', () => {
  gitTest.runIf(process.platform === 'win32')('a delete an editor holds up for a moment is retried, and the folder moves whole', async ({ world }) => {
    const { store, folder } = await foreignFolder(world.a.dir);
    anotherVolume(folder);
    let held = 1;
    vi.mocked(fsp.rm).mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(folder) && held-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return actualFs.rm(target, options);
    });

    const report = await reconcileWorktree(store, world.a.dir, NOTHING_SERVED, 'reconcile');

    expect(report.movedAside).toEqual([{ path: FOLDER, to: expect.any(String) }]);
    expect(report.left).toEqual([]);
    expect(await exists(folder)).toBe(false);
    expect(await readFile(path.join(report.movedAside[0]!.to, 'notes.md'), 'utf8')).toBe('mine too\n');
  });

  gitTest('a delete that fails part-way after the copy is a partial move: recorded, reported, and named where the copy is', async ({ world }) => {
    const { store, folder } = await foreignFolder(world.a.dir);
    anotherVolume(folder);
    vi.mocked(fsp.rm).mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) !== path.resolve(folder)) return actualFs.rm(target, options);
      // One file goes; the next one fails for good.
      await actualFs.rm(path.join(folder, 'SKILL.md'));
      throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
    });

    const report = await reconcileWorktree(store, world.a.dir, NOTHING_SERVED, 'reconcile');

    expect(report.movedAside).toEqual([{ path: FOLDER, to: expect.any(String), partial: expect.stringMatching(/EIO/) }]);
    const { to } = report.movedAside[0]!;
    expect(await readFile(path.join(to, 'SKILL.md'), 'utf8')).toBe('hand-made\n');
    expect(await readFile(path.join(to, 'notes.md'), 'utf8')).toBe('mine too\n');
    expect(report.left).toEqual([]);
    expect(reconcileNotices(report, null)).toContainEqual(expect.stringContaining(`grimoire copied ${FOLDER} whole to ${to}, but part of it is still there`));
    const records = await store.records.list<{ path: string; to: string }>(MOVED_ASIDE);
    expect(records.map((entry) => entry.value)).toEqual([expect.objectContaining({ path: FOLDER, to, partial: expect.stringMatching(/EIO/) })]);
  });
});
