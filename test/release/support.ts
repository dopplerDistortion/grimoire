// Shared by the release-readiness tests (GOK-172): what the published package
// may contain, and `npm pack --dry-run` as npm itself lists it.
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { npmCli } from '../installer/support';

/**
 * The files allowlist (spec §1; GOK-172): the CLI/server bundle and its chunks,
 * the built dashboard's hashed assets, the bundled code's license notices, the
 * README, the license and the manifest. Nothing else: no sources, tests,
 * fixtures, spike scaffolding, docs or source maps.
 */
const ALLOWED: readonly RegExp[] = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/grimoire\.mjs$/,
  /^dist\/launch\.mjs$/,
  /^dist\/THIRD_PARTY_LICENSES\.md$/,
  /^dist\/chunks\/[\w-]+\.mjs$/,
  /^dist\/dashboard\/index\.html$/,
  /^dist\/dashboard\/assets\/[\w-]+\.(js|css|woff2?|svg|png)$/,
];

/** Whether a packed path (POSIX, relative to the package root) is on the allowlist. */
export function allowlisted(file: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(file));
}

export interface DryRun {
  readonly files: readonly string[];
  /** The tarball's size, bytes. */
  readonly size: number;
  readonly unpackedSize: number;
}

/** `npm pack --dry-run` in `packageDir`, without lifecycle scripts: the files npm would publish. */
export function packDryRun(packageDir: string): DryRun {
  const result = spawnSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  expect(result.status, result.stderr).toBe(0);
  const [packed] = JSON.parse(result.stdout) as { files: { path: string }[]; size: number; unpackedSize: number }[];
  return { files: packed!.files.map((file) => file.path).sort(), size: packed!.size, unpackedSize: packed!.unpackedSize };
}
