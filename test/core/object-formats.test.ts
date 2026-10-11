import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, makeTempDir, removeDir, ALICE } from '#harness';
import { createCore } from '../../src/core';
import { openTracker } from '../../src/tracker';
import { issuePath, T0 } from './support';

async function freshRepo(root: string, flags: string[]): Promise<string> {
  const dir = path.join(root, 'repo');
  await git(root, ['init', '--quiet', ...flags, dir]);
  await git(dir, ['config', 'user.name', ALICE.name]);
  await git(dir, ['config', 'user.email', ALICE.email]);
  return dir;
}

describe.each([
  ['sha256 objects', ['--object-format=sha256'], 64],
  ['sha256 objects and reftable refs', ['--object-format=sha256', '--ref-format=reftable'], 64],
  ['sha1 objects and reftable refs', ['--ref-format=reftable'], 40],
])('a repo with %s', (_label, flags, oidLength) => {
  it('creates and shows an issue, and every object grimoire wrote passes git fsck --strict', async () => {
    const root = await makeTempDir('grimoire-format-');
    const core = createCore({ clock: () => T0 });
    try {
      const dir = await freshRepo(root, flags);
      const store = await openTracker(dir);
      await store.initialize({ author: ALICE, actor: { kind: 'human', client: 'cli', nonce: 'n' } });
      await store.close();
      const ctx = {
        surface: 'mcp' as const,
        repo: { root: dir, pin: null },
        person: ALICE,
        client: { name: 'codex-mcp-client' },
        nonce: 'n',
      };

      const created = await core.call('create', { title: 'Wide hashes', body: 'b\r\n', labels: ['l'] }, ctx);
      const id = created.ok ? created.result.id : '';
      const shown = await core.call('show', { ref: id }, ctx);

      expect(shown).toMatchObject({ ok: true, result: { id, title: 'Wide hashes', body: 'b\r\n', labels: ['l'] } });
      const tip = await git(dir, ['rev-parse', 'refs/grimoire/tracker']);
      expect(tip).toHaveLength(oidLength);
      expect(await git(dir, ['cat-file', '-t', `${tip}:${issuePath(id)}`])).toBe('blob');
      expect(await git(dir, ['rev-list', '--count', tip])).toBe('2');
      await git(dir, ['fsck', '--strict', '--no-dangling']);
    } finally {
      await core.close();
      await removeDir(root);
    }
  });
});
