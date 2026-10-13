import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const checkDeps = path.join(repoRoot, 'scripts', 'check-deps.mjs');

describe('the zero-runtime-dependencies check', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempDir('grimoire-deps-');
  });
  afterEach(() => removeDir(tmp));

  async function checkManifest(manifest: object) {
    const file = path.join(tmp, 'package.json');
    await writeFile(file, JSON.stringify(manifest, null, 2));
    return runCommand(process.execPath, [checkDeps, file]);
  }

  it('passes for the repo’s own package.json', async () => {
    const result = await runCommand(process.execPath, [checkDeps], { cwd: repoRoot });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('passes for a manifest with devDependencies only', async () => {
    const result = await checkManifest({ name: 'x', devDependencies: { vitest: '^5.0.0' } });
    expect(result.code).toBe(0);
  });

  it.each([
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ])('fails when the manifest declares %s', async (field) => {
    const value = field.startsWith('bundle') ? ['left-pad'] : { 'left-pad': '^1.3.0' };
    const result = await checkManifest({ name: 'x', [field]: value });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(field);
    expect(result.stderr).toContain('left-pad');
  });

  it('fails on an empty dependencies entry too', async () => {
    const result = await checkManifest({ name: 'x', dependencies: {} });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dependencies');
  });
});
