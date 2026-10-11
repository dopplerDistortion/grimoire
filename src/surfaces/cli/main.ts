// The `grimoire` bin. esbuild bundles this file into dist/grimoire.mjs; each
// verb's heavy code is a dynamic import, so it loads only for that verb:
// `--version` loads nothing, `mcp` loads the MCP surface, every other verb
// loads the CLI surface and the core (spec §10).
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
  const { runCli } = await import('./run');
  // This module is the bundle's entry, so its URL is grimoire.mjs's: the sync child runs it.
  return runCli(argv, { bin: fileURLToPath(import.meta.url) });
}

const code = await main(process.argv.slice(2));
if (code !== null) {
  process.exitCode = code;
  // Everything was awaited; a handle left open by mistake must not keep the process alive.
  setTimeout(() => process.exit(), 5_000).unref();
}
