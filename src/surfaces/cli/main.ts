// The `grimoire` bin. esbuild bundles this file into dist/grimoire.mjs; each
// verb's heavy code is a dynamic import, so it loads only for that verb.
// So far: `--version` and the internal `mcp` entry; the other verbs arrive with
// their tickets (spec §10).
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
  process.stderr.write(`grimoire ${VERSION}: usage: grimoire --version\n`);
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
