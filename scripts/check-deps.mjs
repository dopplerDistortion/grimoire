// The zero-runtime-dependencies check: grimoire ships everything bundled, so a
// copy installed under the git common directory is self-contained (spec §1).
//
//   node scripts/check-deps.mjs [path/to/package.json]
//
// Exits 1, naming the offending entries, if the manifest declares any runtime
// dependency field at all (even an empty one). devDependencies are fine.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RUNTIME_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

const manifestPath = path.resolve(process.argv[2] ?? 'package.json');
/** @type {Record<string, unknown>} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const problems = RUNTIME_FIELDS.filter((field) => field in manifest).map((field) => {
  const value = manifest[field];
  const names = Array.isArray(value) ? value : Object.keys(value ?? {});
  return `  ${field}: ${names.length > 0 ? names.join(', ') : '(empty entry)'}`;
});

if (problems.length > 0) {
  process.stderr.write(
    `${manifestPath} declares runtime dependencies; grimoire must have none (bundle them, or use devDependencies):\n${problems.join('\n')}\n`,
  );
  process.exit(1);
}
