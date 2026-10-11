import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitTest as test, makeTempDir, removeDir } from '#harness';
import { locateMachineLocalStore } from '../../src/machine-local';

describe('locating the machine-local store', () => {
  test('every worktree of a clone resolves to <git-common-dir>/grimoire, without spawning git', async ({
    world,
  }) => {
    const feature = await world.a.addWorktree('feature');
    const deep = path.join(feature.dir, 'src', 'deep');
    await mkdir(deep, { recursive: true });
    const commonDir = await world.a.git(['rev-parse', '--path-format=absolute', '--git-common-dir']);

    // With no PATH, any attempt to spawn git would fail.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    vi.stubEnv(pathKey, '');
    const fromMain = await locateMachineLocalStore(world.a.dir);
    const fromWorktree = await locateMachineLocalStore(feature.dir);
    const fromSubdir = await locateMachineLocalStore(deep);
    vi.unstubAllEnvs();

    expect(fromMain).not.toBeNull();
    expect(samePath(fromMain!.dir, path.join(commonDir, 'grimoire'))).toBe(true);
    expect(fromWorktree!.dir).toBe(fromMain!.dir);
    expect(fromSubdir!.dir).toBe(fromMain!.dir);
    expect(samePath(fromWorktree!.worktree!, feature.dir)).toBe(true);
    expect(samePath(fromMain!.worktree!, world.a.dir)).toBe(true);
  });

  test('two worktrees read and write the same data', async ({ world }) => {
    const feature = await world.a.addWorktree('feature');
    const main = (await locateMachineLocalStore(world.a.dir))!;
    const linked = (await locateMachineLocalStore(feature.dir))!;

    await linked.coordination.write('sync-pending', 'tip', { oid: 'abc123' });
    expect(await main.coordination.read('sync-pending', 'tip')).toEqual({ oid: 'abc123' });

    await main.records.write('sync-status', 'last', { class: 'network' });
    expect(await linked.records.read('sync-status', 'last')).toEqual({ class: 'network' });
  });

  test('clones are separate stores', async ({ world }) => {
    const a = (await locateMachineLocalStore(world.a.dir))!;
    const b = (await locateMachineLocalStore(world.b.dir))!;
    await a.coordination.write('sync-pending', 'tip', { oid: 'abc123' });

    expect(b.dir).not.toBe(a.dir);
    expect(await b.coordination.read('sync-pending', 'tip')).toBeUndefined();
  });

  it('stops at the first .git it meets, following a gitdir: file through commondir', async () => {
    const root = await makeTempDir('grimoire-locate-');
    try {
      // An outer repo, and inside it a checkout whose .git file points at a
      // linked-worktree git dir (relative path, CRLF) with a commondir file.
      const outerGit = path.join(root, 'outer', '.git');
      await mkdir(outerGit, { recursive: true });
      const common = path.join(root, 'elsewhere', 'repo.git');
      const worktreeGitDir = path.join(common, 'worktrees', 'inner');
      await mkdir(worktreeGitDir, { recursive: true });
      await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');
      const inner = path.join(root, 'outer', 'inner');
      await mkdir(path.join(inner, 'sub'), { recursive: true });
      await writeFile(
        path.join(inner, '.git'),
        `gitdir: ${path.relative(inner, worktreeGitDir).split(path.sep).join('/')}\r\n`,
      );

      const store = await locateMachineLocalStore(path.join(inner, 'sub'));
      expect(samePath(store!.dir, path.join(common, 'grimoire'))).toBe(true);
      expect(samePath(store!.worktree!, inner)).toBe(true);

      const outer = await locateMachineLocalStore(path.join(root, 'outer'));
      expect(samePath(outer!.dir, path.join(outerGit, 'grimoire'))).toBe(true);

      // A .git file whose gitdir is missing is the end of the walk: no store.
      const broken = path.join(root, 'outer', 'broken');
      await mkdir(broken);
      await writeFile(path.join(broken, '.git'), 'gitdir: ../nowhere\n');
      expect(await locateMachineLocalStore(broken)).toBeNull();
    } finally {
      await removeDir(root);
    }
  });

  it('finds nothing outside a repository', async () => {
    const root = await makeTempDir('grimoire-locate-');
    try {
      expect(await locateMachineLocalStore(root, { ceilings: [path.dirname(root)] })).toBeNull();
    } finally {
      await removeDir(root);
    }
  });
});

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}
