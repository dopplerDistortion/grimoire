// Runs machine-local store code in separate Node processes, for the tests that
// need real cross-process races. The child entry (child.ts) is bundled once per
// test file with esbuild, so children run the same source the tests import.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { makeTempDir, removeDir, runCommand } from '#harness';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface ChildBundle {
  readonly file: string;
  cleanup(): Promise<void>;
}

export async function buildChild(): Promise<ChildBundle> {
  const dir = await makeTempDir('grimoire-child-');
  const file = path.join(dir, 'child.mjs');
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [fileURLToPath(new URL('./child.ts', import.meta.url))],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __GRIMOIRE_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  });
  return { file, cleanup: () => removeDir(dir) };
}

/** Runs one child to completion and returns its last stdout line, parsed as JSON. */
export async function runChild(bundle: ChildBundle, args: object): Promise<unknown> {
  const result = await runCommand(process.execPath, [bundle.file, JSON.stringify(args)], {
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    throw new Error(`child exited ${result.code ?? result.signal}\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]!);
}

export interface RunningChild {
  readonly pid: number;
  /** The first stdout line the child printed, parsed as JSON. */
  readonly firstLine: unknown;
  /** Kills the child and waits until it has exited. */
  kill(): Promise<void>;
}

/** Starts a child that keeps running, and waits for its first stdout line. */
export function startChild(bundle: ChildBundle, args: object): Promise<RunningChild> {
  const proc: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [bundle.file, JSON.stringify(args)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', reject);
    proc.once('exit', (code) => reject(new Error(`child exited ${code} early\n${stderr}`)));
    proc.stdout.on('data', function onData(chunk: Buffer) {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      proc.stdout.off('data', onData);
      resolve({
        pid: proc.pid!,
        firstLine: JSON.parse(stdout.slice(0, newline)),
        async kill() {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill();
          await exited;
        },
      });
    });
  });
}
