// The `grimoire` bin. esbuild bundles this file into dist/grimoire.mjs; each
// verb's heavy code is a dynamic import, so it loads only for that verb.
// So far: `--version`, the internal `mcp` entry, the `wiki` verbs and the
// detached `sync --background` child; the other verbs arrive with their
// tickets (spec §10). The `wiki` and `sync` branches are interim: the CLI
// surface's dispatcher replaces them (see ./interim.ts).
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../version';

async function main(argv: readonly string[]): Promise<number | null> {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    return 0;
  }
  if (argv[0] === 'mcp') {
    // Runs until the client closes stdin; the process then exits on its own.
    const { runMcp } = await import('../mcp/serve');
    await runMcp(argv.slice(1));
    return null;
  }
  if (argv[0] === 'wiki') {
    const { runWiki } = await import('./interim');
    // This module is the bundle's entry, so its URL is grimoire.mjs's: the sync child runs it.
    return runWiki(argv.slice(1), { bin: fileURLToPath(import.meta.url) });
  }
  if (argv[0] === 'sync') {
    const { runSync } = await import('./interim');
    return runSync(argv.slice(1));
  }
  process.stderr.write(`grimoire ${VERSION}: usage: grimoire --version | grimoire wiki <list | show <slug> | edit <slug>>\n`);
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
