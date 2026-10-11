import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
  bin: { grimoire: string };
};

/** The environment a developer's shell would give `npm run build`, minus Vitest's markers. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && !key.startsWith('VITEST')) env[key] = value;
  }
  return env;
}

// One build command, run as `npm run build` runs it, into a temp package root
// laid out like the published package (<root>/dist/...).
describe('the build', () => {
  let packageRoot: string;

  beforeAll(async () => {
    packageRoot = await makeTempDir('grimoire-build-');
    const result = await runCommand(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'build.mjs'), '--out-dir', path.join(packageRoot, 'dist')],
      { cwd: repoRoot, env: buildEnv() },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });
  afterAll(() => removeDir(packageRoot));

  it('produces a self-contained bin that reports the package version', async () => {
    const bin = path.join(packageRoot, pkg.bin.grimoire);
    // Run from the temp root, far from the repo's node_modules.
    const result = await runCommand(process.execPath, [bin, '--version'], { cwd: packageRoot });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: pkg.version });
  });

  it('produces the dashboard as hashed static assets with no inline code', () => {
    const dashboard = path.join(packageRoot, 'dist', 'dashboard');
    const html = readFileSync(path.join(dashboard, 'index.html'), 'utf8');
    const assets = readdirSync(path.join(dashboard, 'assets'));

    const hashed = /^[\w.-]+-[\w-]{8,}\.(js|css)$/;
    expect(assets.filter((name) => name.endsWith('.js')).length).toBeGreaterThan(0);
    expect(assets.filter((name) => name.endsWith('.css')).length).toBeGreaterThan(0);
    for (const name of assets) expect(name).toMatch(hashed);

    const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const ref of referenced) {
      expect(ref).toMatch(/^\/assets\//);
      expect(existsSync(path.join(dashboard, ref))).toBe(true);
    }

    // The CSP allows no inline script or style.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle="/);
  });
});
