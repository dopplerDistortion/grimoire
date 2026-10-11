// The `grimoire` bin. esbuild bundles this file into dist/grimoire.mjs; each
// verb's heavy code is a dynamic import, so it loads only for that verb:
// `--version` loads nothing, `mcp` loads the MCP surface, every other verb
// loads the CLI surface and the core (spec §10). Run directly (npx, a global
// install), it first hands the verb to the checkout's pinned copy
// (../delegate.ts); agent-client entries and the shell shim reach a copy's
// dist/launch.mjs through the launcher instead, never this file.
import { fileURLToPath } from 'node:url';
import { exitWith, runEntry } from '../entry';
import { VERSION } from '../../version';

// This module is the bundle's entry, so its URL is grimoire.mjs's: the sync child runs it.
const bin = fileURLToPath(import.meta.url);

async function main(argv: readonly string[]): Promise<number | null> {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    return 0;
  }
  const { delegate } = await import('../delegate');
  const delegated = await delegate(argv, { bin, cwd: process.cwd() });
  if (delegated === 'launched') return null;
  if (delegated !== 'local') return delegated;
  return runEntry(argv, { bin });
}

exitWith(await main(process.argv.slice(2)));
