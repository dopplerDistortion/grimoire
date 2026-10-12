import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGitWorld, git, gitTest as test, HARNESS_GIT_CONFIG, type WorldTemplate } from '#harness';
import { removeWorldTemplates } from './git-world';

describe('a git world (bare remote, clones a and b)', () => {
  test('a commit pushed from clone a is visible in clone b after git fetch', async ({ world }) => {
    const sha = await world.a.commitFile('notes/hello.txt', 'hello from a\n', 'add hello');
    await world.a.git(['push', 'origin', 'HEAD:main']);

    const before = await world.b.gitResult(['cat-file', '-e', `${sha}^{commit}`]);
    expect(before.code).not.toBe(0);

    await world.b.git(['fetch', 'origin']);

    expect(await world.b.git(['rev-parse', 'origin/main'])).toBe(sha);
    expect(await world.b.git(['show', 'origin/main:notes/hello.txt'])).toBe('hello from a');
  });

  test('a linked worktree shares its clone’s git common directory', async ({ world }) => {
    const worktree = await world.a.addWorktree('feature');
    const commonDir = (checkoutDir: string) =>
      git(checkoutDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

    expect(samePath(worktree.dir, world.a.dir)).toBe(false);
    expect(samePath(await commonDir(worktree.dir), path.join(world.a.dir, '.git'))).toBe(true);
    expect(samePath(await commonDir(world.a.dir), path.join(world.a.dir, '.git'))).toBe(true);
    expect(samePath(await worktree.git(['rev-parse', '--show-toplevel']), worktree.dir)).toBe(true);

    // Shared object store and refs: the clone sees the worktree's commit without a fetch.
    const sha = await worktree.commitFile('wt.txt', 'from the worktree\n');
    expect(await world.a.git(['rev-parse', 'refs/heads/feature'])).toBe(sha);
  });

  test('each clone commits under its own git identity', async ({ world }) => {
    await world.a.commitFile('a.txt', 'a\n');
    await world.b.commitFile('b.txt', 'b\n');

    expect(await world.a.git(['log', '-1', '--format=%an <%ae>'])).toBe(
      'Alice Example <alice@example.com>',
    );
    expect(await world.b.git(['log', '-1', '--format=%an <%ae>'])).toBe(
      'Bob Example <bob@example.com>',
    );
    expect(await world.a.git(['config', 'user.email'])).toBe('alice@example.com');
  });

  test('git ignores inherited GIT_* variables and the system and user config', async ({
    world,
  }) => {
    vi.stubEnv('GIT_DIR', path.join(world.root, 'not-a-repo'));
    vi.stubEnv('GIT_AUTHOR_NAME', 'Mallory');

    await world.a.commitFile('isolated.txt', 'isolated\n');

    expect(await world.a.git(['log', '-1', '--format=%an'])).toBe('Alice Example');
    const scopes = (await world.a.git(['config', '--list', '--show-scope']))
      .split('\n')
      .map((line) => line.split('\t')[0]);
    expect(scopes).not.toContain('system');
    expect(await world.a.git(['config', 'core.autocrlf'])).toBe('false');
  });

  test('code under test that spawns git with the inherited environment is isolated too', async ({
    world,
  }) => {
    // What product code does: spawn git with process.env, no harness helpers.
    // -z: entries are `scope NUL origin NUL key LF value NUL`, origins unquoted.
    const fields = execFileSync(
      'git',
      ['config', '--list', '--show-origin', '--show-scope', '-z'],
      { cwd: world.a.dir, encoding: 'utf8' },
    ).split('\0');
    const entries: { scope: string; origin: string }[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      entries.push({ scope: fields[i]!, origin: fields[i + 1]! });
    }
    const globalOrigins = entries.filter((e) => e.scope === 'global').map((e) => e.origin);

    expect(entries.map((e) => e.scope)).not.toContain('system');
    expect(globalOrigins.length).toBeGreaterThan(0);
    for (const origin of globalOrigins) {
      expect(samePath(origin.replace(/^file:/, ''), HARNESS_GIT_CONFIG)).toBe(true);
    }
  });
});

describe('createGitWorld', () => {
  it('cleanup removes the whole world, read-only git objects included', async () => {
    const world = await createGitWorld();
    await world.a.commitFile('x.txt', 'x\n');
    await world.a.git(['push', '--quiet', 'origin', 'HEAD:main']);
    await world.a.git(['gc', '--quiet']); // packs: read-only .pack and .idx files
    expect(existsSync(world.root)).toBe(true);

    await world.cleanup();

    expect(existsSync(world.root)).toBe(false);
  });

  // setup.ts runs removeWorldTemplates after every test file: a worker's exit handlers don't run.
  it('removeWorldTemplates removes the template worlds built so far; the next world builds its template again', async () => {
    const roots: string[] = [];
    const template: WorldTemplate = { name: 'removed', prepare: async (world) => void roots.push(world.root) };
    const first = await createGitWorld(template);
    await first.cleanup();
    expect(roots).toHaveLength(1);
    expect(existsSync(roots[0]!)).toBe(true);

    await removeWorldTemplates();

    expect(existsSync(roots[0]!)).toBe(false);
    const again = await createGitWorld(template);
    try {
      expect(roots).toHaveLength(2);
      expect(await again.a.git(['log', '--format=%s'])).toBe('initial commit');
    } finally {
      await again.cleanup();
    }
  });

  it('a template whose build fails leaves no folder behind, and the next world asking for it builds it again', async () => {
    const roots: string[] = [];
    let fail = true;
    const template: WorldTemplate = {
      name: 'failing',
      prepare: async (world) => {
        roots.push(world.root);
        if (fail) throw new Error('the template failed to build');
      },
    };

    await expect(createGitWorld(template)).rejects.toThrow('the template failed to build');

    expect(roots).toHaveLength(1);
    expect(existsSync(roots[0]!)).toBe(false);
    fail = false;
    const world = await createGitWorld(template);
    await world.cleanup();
    expect(roots).toHaveLength(2);
  });
});

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = realpathSync.native(path.resolve(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}
