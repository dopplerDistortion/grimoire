// Seam 1 (spec §16 Spawn: "the binary by absolute path (the platform .exe,
// never a .cmd shim)"; spike F: the npm shim only sets package-manager env
// vars, so the runner stores the native binary): which binary `runner enable`
// finds on PATH, and what it refuses to start.
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeExecutable, makeTempDir, removeDir } from '#harness';
import { enableRunner, findBinary } from '../../src/runner';
import { coreTest } from '../core/support';
import { expectError } from './scenario';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('grimoire-runner-bin-');
  onTestFinished(() => removeDir(dir));
  return dir;
}

const pathEnv = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(path.delimiter) });

describe('finding the platform binary on PATH', () => {
  it.skipIf(process.platform !== 'win32')('Windows: an npm codex.cmd shim is followed to its native codex.exe, never run itself', async () => {
    const prefix = await tempDir();
    await writeFile(path.join(prefix, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const native = await fakeExecutable(
      path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin'),
      'codex',
      FAKE_AGENT,
    );

    expect(await findBinary('codex', pathEnv(prefix))).toBe(native);
  });

  it.skipIf(process.platform !== 'win32')('Windows: claude.exe is taken from the first PATH folder that has it', async () => {
    const empty = await tempDir();
    const bin = await tempDir();
    const claude = await fakeExecutable(bin, 'claude', FAKE_AGENT);

    expect(await findBinary('claude', pathEnv(empty, bin))).toBe(claude);
  });

  it.skipIf(process.platform === 'win32')('POSIX: an npm codex script is followed to its native binary', async () => {
    const prefix = await tempDir();
    const pkg = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex');
    await mkdir(path.join(pkg, 'bin'), { recursive: true });
    await writeFile(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
    const native = await fakeExecutable(path.join(pkg, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', 'triple', 'bin'), 'codex', FAKE_AGENT);
    await mkdir(path.join(prefix, 'bin'));
    await symlink(path.join(pkg, 'bin', 'codex.js'), path.join(prefix, 'bin', 'codex'));

    expect(await findBinary('codex', pathEnv(path.join(prefix, 'bin')))).toBe(native);
  });

  it('nothing on PATH: enable says how to fix it', async () => {
    const empty = await tempDir();
    const error = await expectError(findBinary('claude', pathEnv(empty)));
    expect(error.code).toBe('INVALID');
    expect(error.message).toContain('--binary');
  });
});

describe('what the runner refuses to start', () => {
  coreTest.skipIf(process.platform !== 'win32')('a .cmd shim named with --binary is refused before anything runs', async ({ world }) => {
    const dir = await tempDir();
    const shim = path.join(dir, 'claude.cmd');
    await writeFile(shim, '@echo off\r\n');
    const error = await expectError(enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: false, env: {}, binary: shim }));
    expect(error.details).toMatchObject({ fields: { binary: expect.stringContaining('.cmd') } });
  });

  coreTest('a relative binary path is refused', async ({ world }) => {
    const error = await expectError(enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: false, env: {}, binary: 'claude.exe' }));
    expect(error.details).toMatchObject({ fields: { binary: 'must be absolute' } });
  });
});
