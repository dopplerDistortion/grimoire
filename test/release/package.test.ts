// Release readiness (GOK-172; spec §1, §21): the package manifest, the files
// allowlist as npm applies it, the license and the README's coverage.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { allowlisted, packDryRun } from './support';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifestText = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const manifest = JSON.parse(manifestText) as Record<string, unknown>;

let temp: string | undefined;
afterEach(async () => {
  if (temp) await removeDir(temp);
  temp = undefined;
});

describe('the package manifest', () => {
  test('names, versions and describes @goksening/grimoire 1.0.0, with its license, repository, homepage, bugs and keywords', () => {
    expect(manifest).toMatchObject({
      name: '@goksening/grimoire',
      version: '1.0.0',
      description: expect.stringMatching(/\S/),
      license: 'MIT',
      repository: { type: 'git', url: 'git+https://github.com/dopplerDistortion/grimoire.git' },
      homepage: 'https://github.com/dopplerDistortion/grimoire#readme',
      bugs: { url: 'https://github.com/dopplerDistortion/grimoire/issues' },
      bin: { grimoire: 'dist/grimoire.mjs' },
      engines: { node: '>=22' },
      type: 'module',
    });
    expect(manifest.keywords).toEqual(expect.arrayContaining(['issue-tracker', 'git', 'mcp', 'agents']));
  });

  test('publishes with public access, and no provenance until it is published from CI', () => {
    // Advisor ruling (GOK-172): a local `npm publish` can't produce OIDC provenance; 1.0.1 on publishes from
    // GitHub Actions with npm trusted publishing, and adds it then.
    expect(manifest.publishConfig).toEqual({ access: 'public' });
  });

  test('declares no runtime dependencies of any kind', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      expect(manifest, field).not.toHaveProperty(field);
    }
  });

  test('builds the package before every pack and publish', () => {
    expect(manifest.scripts).toMatchObject({ prepack: 'node scripts/build.mjs' });
  });
});

describe('the files allowlist', () => {
  test('npm packs only the bundle, the dashboard assets, the license notices, the README and the license from a tree full of everything else', async () => {
    temp = await makeTempDir('grimoire-allowlist-');
    const files: Record<string, string> = {
      'package.json': manifestText,
      'README.md': '# grimoire\n',
      LICENSE: 'MIT\n',
      'dist/grimoire.mjs': '',
      'dist/grimoire.mjs.map': '{}',
      'dist/launch.mjs': '',
      'dist/THIRD_PARTY_LICENSES.md': '',
      'dist/chunks/serve-ABC123.mjs': '',
      'dist/chunks/serve-ABC123.mjs.map': '{}',
      'dist/dashboard/index.html': '',
      'dist/dashboard/assets/index-C4fYVZu7.js': '',
      'dist/dashboard/assets/index-C4fYVZu7.js.map': '{}',
      'dist/dashboard/assets/index-Cv9XGOKP.css': '',
      'src/surfaces/cli/main.ts': '',
      'test/build.test.ts': '',
      'test/fixtures/codex/rollout.jsonl': '',
      'test/spikes/codex-skills-role-exec/scripted-responses.mjs': '',
      'docs/research/spikes/mcp-dual-era.md': '',
      'docs/adr/0001.md': '',
      'scripts/build.mjs': '',
      '.agents/skills/tdd/SKILL.md': '',
      'CLAUDE.md': '',
      'GLOSSARY.md': '',
      'tsconfig.json': '{}',
      'vitest.config.ts': '',
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(temp, file)), { recursive: true });
      await writeFile(path.join(temp, file), content);
    }

    expect(packDryRun(temp).files).toEqual(
      [
        'LICENSE',
        'README.md',
        'dist/THIRD_PARTY_LICENSES.md',
        'dist/chunks/serve-ABC123.mjs',
        'dist/dashboard/assets/index-C4fYVZu7.js',
        'dist/dashboard/assets/index-Cv9XGOKP.css',
        'dist/dashboard/index.html',
        'dist/grimoire.mjs',
        'dist/launch.mjs',
        'package.json',
      ].sort(),
    );
  });

  test('npm pack --dry-run of this repository lists only allowlisted files, the README and the license among them', () => {
    const { files } = packDryRun(repoRoot);

    expect(files.filter((file) => !allowlisted(file))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['LICENSE', 'README.md', 'package.json']));
  });
});

describe('the license', () => {
  test('is the MIT license, at the repository root', () => {
    const license = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
    expect(license).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Göksenin Güngör\n/);
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});

describe('the README', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  test.each([
    ['install', 'npx @goksening/grimoire init'],
    ['upgrade', 'init --upgrade'],
    ['uninstall', 'grimoire uninstall'],
    ['leave', 'npx @goksening/grimoire leave'],
    ['Claude Code trust', 'workspace trust'],
    ['Codex trust', '/hooks'],
    ['the excerpt modes', '`excerpts`, `facts` or `none`'],
    ['the stash caveat', 'git stash --all'],
    ['the dashboard', 'grimoire start'],
    ['signing in', 'grimoire open'],
    ['the runner', 'docs/runner.md'],
    ['CI following the pin', 'node .grimoire/run.cjs pin'],
    ['troubleshooting', 'grimoire doctor'],
    ['status', 'grimoire status'],
    ['the release promise', 'The release promise'],
    ['the nine rules', 'Never unpublish a release'],
    ['the cross-pin contract', 'docs/cross-pin-contract.md'],
    ['the Codex verification', 'a scripted model, not a live'],
    ['the provenance follow-up', 'trusted publishing'],
  ])('covers %s', (_topic, text) => {
    expect(readme).toContain(text);
  });

  test('references every spike findings file', () => {
    const spikes = readdirSync(path.join(repoRoot, 'docs', 'research', 'spikes')).filter((name) => name.endsWith('.md'));
    expect(spikes.length).toBeGreaterThan(0);
    for (const name of spikes) expect(readme, name).toContain(`docs/research/spikes/${name}`);
  });
});
