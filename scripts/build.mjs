// Builds the publishable package (spec §1):
//   dist/grimoire.mjs  the CLI/server entry (the bin), bundled by esbuild, self-contained
//   dist/launch.mjs    a version copy's entry: the launcher imports it (spec §11, frozen)
//   dist/chunks/       their lazily imported chunks (one verb's code loads only for that verb)
//   dist/dashboard/    the Preact dashboard, built by Vite into hashed static assets
//   dist/THIRD_PARTY_LICENSES.md  the license notices of every package bundled into the above
//
//   node scripts/build.mjs [cli|dashboard] [--out-dir <dir>] [--version <semver>]   (default: both, into dist/)
//
//   --version builds the package as another version than package.json's (tests
//   pack copies of several versions to exercise pins, joins and upgrades).
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  return Object.keys(result.metafile.inputs);
}

/** @param {string} dir */
async function buildDashboard(dir) {
  const result = await viteBuild({
    configFile: path.join(repoRoot, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: dir, emptyOutDir: true },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((build) => ('output' in build ? build.output : []));
  return outputs.flatMap((output) => (output.type === 'chunk' ? output.moduleIds : []));
}

/**
 * The package folder (`…/node_modules/<name>` or `…/node_modules/@scope/<name>`)
 * a bundled module came from, or null for grimoire's own code.
 * @param {string} file
 */
function packageDirOf(file) {
  const parts = path.resolve(repoRoot, file.replace(/^\0/, '').replace(/\?.*$/, '')).split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  const name = at < 0 ? undefined : parts[at + 1];
  if (name === undefined) return null;
  return parts.slice(0, at + (name.startsWith('@') ? 3 : 2)).join(path.sep);
}

/**
 * `dist/THIRD_PARTY_LICENSES.md`: every package bundled into dist/, with its
 * version, its declared license and its license (and NOTICE) files whole. The
 * bundles carry other packages' code, and their licenses ask for the notices.
 * @param {Iterable<string>} modules  the bundled modules' paths
 */
async function writeNotices(modules) {
  const dirs = new Set();
  for (const file of modules) {
    const dir = packageDirOf(file);
    if (dir) dirs.add(dir);
  }
  const sections = [];
  for (const dir of dirs) {
    const { name, version, license } = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const files = (await readdir(dir)).filter((entry) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(entry)).sort();
    const texts = await Promise.all(files.map(async (entry) => (await readFile(path.join(dir, entry), 'utf8')).replace(/\r\n/g, '\n').trim()));
    const declared = typeof license === 'string' ? license : 'see its license file';
    const body = texts.length > 0 ? texts.join('\n\n') : `${name} ships no license file; its package.json declares ${declared}.`;
    sections.push({ name, text: `## ${name}@${version} (${declared})\n\n${body}\n` });
  }
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const head = '# Third-party licenses\n\ngrimoire bundles the code of these packages into `dist/`. Each one is listed with its version and license, followed by its license text.\n';
  await writeFile(path.join(outDir, 'THIRD_PARTY_LICENSES.md'), [head, ...sections.map((section) => section.text)].join('\n'));
}

if (target === 'all') await rm(outDir, { recursive: true, force: true });
/** Every bundled module, for the license notices. */
const bundled = [];
if (target === 'all' || target === 'cli') bundled.push(...(await buildCli(outDir)));
if (target === 'all' || target === 'dashboard') bundled.push(...(await buildDashboard(path.join(outDir, 'dashboard'))));
// A dashboard-only build leaves the notices alone: they would lose the CLI's packages.
if (target !== 'dashboard') await writeNotices(bundled);
