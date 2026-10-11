// Bundles the spike-B probe server with the same esbuild settings scripts/build.mjs
// uses for the CLI (one self-contained ESM file for Node 22, a real `require`),
// so what the tests and the cold-start measurement run is what a shipped
// `grimoire mcp` would load.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * @param {string} outDir
 * @param {{ minify?: boolean }} [options]
 * @returns {Promise<string>} the absolute path of the bundled probe
 */
export async function bundleProbe(outDir, options = {}) {
  const outfile = path.join(outDir, options.minify ? 'probe.min.mjs' : 'probe.mjs');
  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [fileURLToPath(new URL('./probe-server.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: options.minify ?? false,
    banner: {
      js: [
        "import { createRequire as __grimoireCreateRequire } from 'node:module';",
        'const require = __grimoireCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'warning',
  });
  return outfile;
}
