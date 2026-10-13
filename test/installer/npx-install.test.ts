// The seam-3 helper that installs a packed tarball the way npx does must
// install into its own folder, whatever folders above it hold.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { npmPack, npxInstall, reportingPackage } from './support';

let outer: string | undefined;
afterEach(async () => {
  if (outer) await removeDir(outer);
});

describe('npxInstall', () => {
  test('installs into its prefix even when a folder above it is an npm project', { timeout: 120_000 }, async () => {
    outer = await makeTempDir('grimoire-npx-outer-');
    const projectManifest = `${JSON.stringify({ name: 'outer-project', private: true })}\n`;
    await writeFile(path.join(outer, 'package.json'), projectManifest);
    const { tarball } = npmPack(await reportingPackage(outer, '1.0.0-test.3'), outer);
    const prefix = path.join(outer, 'prefix');
    await mkdir(prefix);

    const bin = npxInstall(tarball, prefix);

    expect(bin).toBe(path.join(prefix, 'node_modules', '@goksening', 'grimoire', 'dist', 'grimoire.mjs'));
    expect(existsSync(path.join(prefix, 'node_modules', '@goksening', 'grimoire', 'package.json'))).toBe(true);
    expect(existsSync(path.join(outer, 'node_modules'))).toBe(false);
    expect(await readFile(path.join(outer, 'package.json'), 'utf8')).toBe(projectManifest);
  });
});
