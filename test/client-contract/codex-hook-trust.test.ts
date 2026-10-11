// Seam 2 (spec Testing Decisions; §21 Codex re-approval; spike E finding 6):
// `status` and `doctor` say whether Codex runs grimoire's SessionStart hook
// by reproducing the hash Codex trusts and reading the trust Codex writes.
// The recipe is Codex-internal, so it is pinned here against what Codex
// 0.162.1 itself reported for the real bootstrap (fixtures), and, where the
// `codex` binary is installed, against a live `codex app-server`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { git, makeTempDir, readFixture, readFixtureJson, removeDir } from '#harness';
import { codexHookCommand } from '../../src/installer/bootstrap';
import { codexHookState, trustedHashes } from '../../src/installer/codex-trust';
import { codexBlockBody, codexHookHash } from '../../src/installer/pointers';
import { tomlMarkers } from '../../src/installer/writer';
import { findGitDirs } from '../../src/machine-local';

interface ListedHook {
  key: string;
  command: string;
  currentHash: string;
  trustStatus: string;
  sourcePath: string;
}
interface HooksList {
  result: { data: { hooks: ListedHook[] }[] };
}

const TRUST = 'codex/hook-trust';
const hooksOf = (listing: HooksList) => listing.result.data.flatMap((entry) => entry.hooks);

/** grimoire's block as `init` appends it to `.codex/config.toml`. */
function blockText(): string {
  const { begin, end } = tomlMarkers('grimoire');
  return `${begin}\n${codexBlockBody()}${end}\n`;
}

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

/** The Codex release the fixtures and the trust recipe were taken from: another one may hash or list hooks differently. */
const PINNED_CODEX = /^codex-cli 0\.162\./m;
const codexVersion = spawnSync('codex --version', { shell: true, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
const codexInstalled = codexVersion.status === 0 && PINNED_CODEX.test(codexVersion.stdout ?? '');

/** How long one app-server request may take before the test gives up on it. */
const REQUEST_MS = 30_000;

/**
 * A `codex app-server` over stdio, as the TUI's `/hooks` screen talks to it.
 * A request that gets no answer, or a server that exits, fails the test
 * instead of hanging it; `close` ends the whole process tree.
 */
async function appServer(codexHome: string, cwd: string) {
  const windows = process.platform === 'win32';
  // Windows installs codex as a .cmd shim, which needs a shell; elsewhere the binary runs directly.
  const child = windows
    ? spawn('codex app-server', { cwd, env: { ...process.env, CODEX_HOME: codexHome }, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawn('codex', ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (message: { result?: unknown; error?: unknown }) => void; reject: (error: Error) => void }>();
  let gone: Error | null = null;
  const fail = (error: Error) => {
    gone ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', (error) => fail(error));
  child.on('exit', (code, signal) => fail(new Error(`codex app-server exited (${code ?? signal})`)));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== undefined) pending.get(message.id)?.resolve(message);
    } catch {
      // Not a response.
    }
  });
  const close = () => {
    child.stdin.end();
    if (child.exitCode !== null || child.pid === undefined) return;
    if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
    else child.kill();
  };
  let next = 0;
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (gone) return reject(gone);
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: codex app-server gave no answer in ${REQUEST_MS / 1000} s`));
      }, REQUEST_MS);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          pending.delete(id);
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
          else resolve(message.result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await request('initialize', { clientInfo: { name: 'grimoire_test', title: null, version: '0.0.0' } });
  } catch (error) {
    close();
    throw error;
  }
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  return {
    list: async () => hooksOf({ result: (await request('hooks/list', { cwds: [cwd] })) as HooksList['result'] }),
    trust: (hooks: ListedHook[]) =>
      request('config/batchWrite', {
        edits: [{ keyPath: 'hooks.state', value: Object.fromEntries(hooks.map((hook) => [hook.key, { trusted_hash: hook.currentHash }])), mergeStrategy: 'upsert' }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      }),
    close,
  };
}

describe('a live Codex agrees with grimoire about its hook', () => {
  it.skipIf(!codexInstalled)(
    'untrusted is “needs approval”, the /hooks trust write makes it “approved”, under the same key and hash',
    async () => {
      const dir = await makeTempDir('grimoire-codex-trust-');
      try {
        const repo = await realpath(await mkdir(path.join(dir, 'repo'), { recursive: true }).then(() => path.join(dir, 'repo')));
        const home = path.join(dir, 'codex-home');
        await mkdir(path.join(repo, '.codex'), { recursive: true });
        await mkdir(home, { recursive: true });
        await git(repo, ['init', '--quiet']);
        await writeFile(path.join(repo, '.codex', 'config.toml'), blockText());
        // Codex loads a project's .codex/ only once the project is trusted.
        await writeFile(path.join(home, 'config.toml'), `[projects.'${repo}']\ntrust_level = "trusted"\n`);
        const dirs = (await findGitDirs(repo))!;
        const env = { ...process.env, CODEX_HOME: home };
        const codex = await appServer(home, repo);
        try {
          const before = await codex.list();
          const fresh = await codexHookState(repo, dirs, env, null);
          await codex.trust(before);
          const after = await codex.list();
          const approved = await codexHookState(repo, dirs, env, null);

          expect(before).toMatchObject([{ trustStatus: 'untrusted', currentHash: codexHookHash() }]);
          expect(fresh).toMatchObject({ trust: 'needs-approval', declared_hash: codexHookHash(), position: 0 });
          expect(fresh.key!.toLowerCase()).toBe(before[0]!.key.toLowerCase());
          expect(after).toMatchObject([{ trustStatus: 'trusted' }]);
          expect(approved.trust).toBe('approved');
        } finally {
          codex.close();
        }
      } finally {
        await removeDir(dir);
      }
    },
    120_000,
  );
});
