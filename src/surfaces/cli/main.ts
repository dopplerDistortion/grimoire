// The `grimoire` bin. esbuild bundles this file into dist/grimoire.mjs.
// Only `--version` exists so far; the verbs arrive with their tickets (spec §10).
import { VERSION } from '../../version';

function main(argv: readonly string[]): number {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${JSON.stringify({ version: VERSION })}\n`);
    return 0;
  }
  process.stderr.write(`grimoire ${VERSION}: usage: grimoire --version\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
