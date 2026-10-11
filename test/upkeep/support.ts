// Shared setup for upkeep's seam-1 tests (spec Testing Decisions): checkouts
// installed the way `init` writes them, pinned to the version under test.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { makeTempDir, removeDir } from '#harness';
import { desiredEntries, type PointerOptions } from '../../src/installer/pointers';
import { applyFiles, planFiles } from '../../src/installer/writer';
import { VERSION } from '../../src/version';

export const BOTH_CLIENTS: PointerOptions = { clients: ['claude-code', 'codex'], npmScript: false, adapter: 'end' };

/** Writes `.grimoire/config.yml` pinning `pin`, as `init` commits it. */
export async function pin(root: string, version: string = VERSION): Promise<void> {
  await mkdir(path.join(root, '.grimoire'), { recursive: true });
  await writeFile(path.join(root, '.grimoire', 'config.yml'), `version: ${version}\ninstall_format: 1\n`);
}

/** The checkout as `init` leaves it: every pointer file and the manifest, then config.yml pinning `version`. */
export async function installed(root: string, version: string = VERSION, options: Partial<PointerOptions> = {}): Promise<void> {
  await applyFiles(await planFiles(root, desiredEntries({ ...BOTH_CLIENTS, ...options })));
  await pin(root, version);
}

export const read = (root: string, file: string): Promise<string> => readFile(path.join(root, file), 'utf8');

/** `import text from './file?raw'`, as scripts/build.mjs and Vite read it. */
const rawText: esbuild.Plugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)), namespace: 'raw-text' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
};

/** Bundles a script beside this file into a temp dir, at this build's VERSION, for tests that need separate processes. */
export async function bundleScript(entry: string): Promise<{ script: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir('grimoire-upkeep-child-');
  const script = path.join(dir, entry.replace(/\.ts$/, '.mjs'));
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    plugins: [rawText],
    define: { __GRIMOIRE_VERSION__: JSON.stringify(VERSION) },
    logLevel: 'silent',
  });
  return { script, cleanup: () => removeDir(dir) };
}
