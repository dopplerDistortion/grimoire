// Seam 2 (spec Testing Decisions; §21 Codex re-approval; spike E finding 6),
// live: where the pinned `codex` binary is installed, a real `codex
// app-server` (started, then its process tree killed) agrees with
// grimoire's trust reading. In the slow project: it runs a real client.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';
import { git, makeTempDir, removeDir } from '#harness';
import { codexHookState } from '../../src/installer/codex-trust';
import { codexHookHash } from '../../src/installer/pointers';
import { findGitDirs } from '../../src/machine-local';
import { blockText, hooksOf, type HooksList, type ListedHook } from './codex-hook-trust-support';

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
