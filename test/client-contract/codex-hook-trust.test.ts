// Seam 2 (spec Testing Decisions; §21 Codex re-approval; spike E finding 6):
// `status` and `doctor` say whether Codex runs grimoire's SessionStart hook
// by reproducing the hash Codex trusts and reading the trust Codex writes.
// The recipe is Codex-internal, so it is pinned here against what Codex
// 0.162.1 itself reported for the real bootstrap (fixtures); the live
// `codex app-server` check is in codex-hook-trust.slow.test.ts.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, makeTempDir, readFixture, readFixtureJson, removeDir } from '#harness';
import { codexHookCommand } from '../../src/installer/bootstrap';
import { codexHookState, trustedHashes } from '../../src/installer/codex-trust';
import { codexHookHash } from '../../src/installer/pointers';
import { findGitDirs } from '../../src/machine-local';
import { blockText, hooksOf, TRUST, type HooksList, type ListedHook } from './codex-hook-trust-support';

describe('Codex hook trust for the shipped bootstrap (Codex 0.162.1 fixtures)', () => {
  it('the fixtures were taken for the block this release writes: a changed block means taking them again', () => {
    expect(readFixture(`${TRUST}/project-config-real-bootstrap.toml`)).toBe(blockText());
  });

  it('codexHookHash() is the hash Codex reports for grimoire’s group', () => {
    const [hook] = hooksOf(readFixtureJson<HooksList>(`${TRUST}/hooks-list-real-bootstrap-untrusted.json`));

    expect(hook).toMatchObject({ command: codexHookCommand(), trustStatus: 'untrusted' });
    expect(codexHookHash()).toBe(hook!.currentHash);
  });

  it('grimoire reads the trust Codex wrote into the user’s config', () => {
    const [trusted] = hooksOf(readFixtureJson<HooksList>(`${TRUST}/hooks-list-real-bootstrap-trusted.json`));

    expect(trusted!.trustStatus).toBe('trusted');
    expect(trustedHashes(readFixture(`${TRUST}/user-config-real-bootstrap.toml`))).toEqual(new Map([[trusted!.key, trusted!.currentHash]]));
    // Spike E's capture of the stand-in, in the same shape.
    const [spike] = hooksOf(readFixtureJson<HooksList>(`${TRUST}/hooks-list-trusted.json`));
    expect(trustedHashes(readFixture(`${TRUST}/user-config-hooks-state.toml`)).get(spike!.key)).toBe(spike!.currentHash);
  });

  // Codex writes `[hooks.state.'<key>']` tables (both captures above); an inline entry is a person's hand edit, read the same.
  it('tolerates trust a person wrote inline under [hooks.state], and ignores other tables', () => {
    const text = [
      '[hooks.state]',
      `'C:\\repo\\.codex\\config.toml:session_start:1:0' = { trusted_hash = "sha256:aa" }`,
      '"/home/u/repo/.codex/config.toml:session_start:0:0" = { trusted_hash = "sha256:bb", enabled = true }',
      '[projects."/home/u/repo"]',
      'trusted_hash = "sha256:not-a-hook"',
    ].join('\n');

    expect(trustedHashes(text)).toEqual(
      new Map([
        ['C:\\repo\\.codex\\config.toml:session_start:1:0', 'sha256:aa'],
        ['/home/u/repo/.codex/config.toml:session_start:0:0', 'sha256:bb'],
      ]),
    );
  });
});

describe('a linked worktree runs the main checkout’s hooks', () => {
  it('grimoire names the trust key under the main checkout’s file, as Codex lists it for a worktree', async () => {
    // Spike E: listed from the worktree (`cwd`), the hook's key and sourcePath are the main checkout's file.
    const [listing] = readFixtureJson<HooksList>(`${TRUST}/hooks-list-linked-worktree.json`).result.data as unknown as { cwd: string; hooks: ListedHook[] }[];
    const listed = listing!.hooks[0]!;
    expect(listed.key).toBe(`${listed.sourcePath}:session_start:0:0`);
    expect(listed.sourcePath.startsWith(`${listing!.cwd}\\`)).toBe(false);

    const dir = await makeTempDir('grimoire-codex-worktree-');
    try {
      const main = path.join(await realpath(dir), 'main');
      await mkdir(path.join(main, '.codex'), { recursive: true });
      await git(main, ['init', '--quiet']);
      await writeFile(path.join(main, '.codex', 'config.toml'), blockText());
      await git(main, ['add', '.']);
      await git(main, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'hooks']);
      const worktree = path.join(path.dirname(main), 'feature');
      await git(main, ['worktree', 'add', '--quiet', '-b', 'feature', worktree]);

      const state = await codexHookState(worktree, (await findGitDirs(worktree))!, { CODEX_HOME: path.join(dir, 'codex-home') }, null);

      expect(state).toMatchObject({ declaring_file: path.join(main, '.codex', 'config.toml'), position: 0, trust: 'needs-approval' });
      expect(state.key).toBe(`${state.declaring_file}:session_start:0:0`);
    } finally {
      await removeDir(dir);
    }
  });
});
