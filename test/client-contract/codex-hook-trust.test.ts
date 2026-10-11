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

  it('reads trust written inline under [hooks.state] too, and ignores other tables', () => {
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

const codexInstalled = spawnSync('codex --version', { shell: true, encoding: 'utf8', windowsHide: true, timeout: 30_000 }).status === 0;

/** A `codex app-server` over stdio, as the TUI's `/hooks` screen talks to it. */
async function appServer(codexHome: string, cwd: string) {
  const child = spawn('codex app-server', { cwd, env: { ...process.env, CODEX_HOME: codexHome }, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== undefined) pending.get(message.id)?.(message);
    } catch {
      // Not a response.
    }
  });
  let next = 0;
  const request = async (method: string, params: unknown) => {
    const id = next++;
    const answer = new Promise<{ result?: unknown; error?: unknown }>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const message = await answer;
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return message.result;
  };
  await request('initialize', { clientInfo: { name: 'grimoire_test', title: null, version: '0.0.0' } });
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
    close: () => {
      child.stdin.end();
      child.kill();
    },
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
