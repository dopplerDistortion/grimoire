// Builds the publishable package (spec §1):
//   dist/grimoire.mjs  the CLI/server entry (the bin), bundled by esbuild, self-contained
//   dist/launch.mjs    a version copy's entry: the launcher imports it (spec §11, frozen)
//   dist/chunks/       their lazily imported chunks (one verb's code loads only for that verb)
//   dist/dashboard/    the Preact dashboard, built by Vite into hashed static assets
//
//   node scripts/build.mjs [cli|dashboard] [--out-dir <dir>] [--version <semver>]   (default: both, into dist/)
//
//   --version builds the package as another version than package.json's (tests
//   pack copies of several versions to exercise pins, joins and upgrades).
import { readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'out-dir': { type: 'string' }, version: { type: 'string' } },
});
const target = positionals[0] ?? 'all';
if (!['all', 'cli', 'dashboard'].includes(target) || positionals.length > 1) {
  process.stderr.write('usage: node scripts/build.mjs [cli|dashboard] [--out-dir <dir>] [--version <semver>]\n');
  process.exit(2);
}
const outDir = path.resolve(values['out-dir'] ?? path.join(repoRoot, 'dist'));

/**
 * `import text from './file?raw'` gives the file's text, as Vite does: the
 * launcher and the shell shim are written out by `init` from their sources.
 * @type {esbuild.Plugin}
 */
const rawText = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

/** @param {string} dir */
async function buildCli(dir) {
  const version = values.version ?? JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
  // Chunk names are content hashes: drop the previous build's, so none goes stale.
  await rm(path.join(dir, 'chunks'), { recursive: true, force: true });
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { grimoire: 'src/surfaces/cli/main.ts', launch: 'src/surfaces/launch.ts' },
    plugins: [rawText],
    outdir: dir,
    outExtension: { '.js': '.mjs' },
    // Dynamic imports become chunks, so a verb loads only its own code: the MCP
    // SDK never loads for the other verbs, and `mcp` answers its opening before
    // the core, tracker and git modules load (spec §8, cold start).
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: [
        '#!/usr/bin/env node',
        // Bundled CommonJS code may require() Node builtins; give it a real require.
        "import { createRequire as __grimoireCreateRequire } from 'node:module';",
        'const require = __grimoireCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    define: { __GRIMOIRE_VERSION__: JSON.stringify(version) },
    metafile: true,
    logLevel: 'warning',
  });

  // Self-contained: the only imports left in the bundle are Node builtins.
  const builtins = new Set(builtinModules);
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !imported.path.startsWith('node:') && !builtins.has(imported.path)) {
        throw new Error(`${file} imports ${imported.path} at runtime; bundle it instead`);
      }
    }
  }
}

/** @param {string} dir */
async function buildDashboard(dir) {
  await viteBuild({
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: dir, emptyOutDir: true },
  });
}

if (target === 'all') await rm(outDir, { recursive: true, force: true });
if (target === 'all' || target === 'cli') await buildCli(outDir);
if (target === 'all' || target === 'dashboard') await buildDashboard(path.join(outDir, 'dashboard'));
