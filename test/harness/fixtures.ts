import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Home of the client-contract fixtures (seam 2): real, sanitized client
 * artifacts only. See test/fixtures/README.md for the rule and the layout.
 */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

/**
 * Absolute path of a fixture, given its path relative to test/fixtures
 * (forward slashes work on every platform). Throws if the fixture is missing
 * or the path leaves the fixture directory.
 */
export function fixturePath(relPath: string): string {
  const resolved = path.resolve(FIXTURES_DIR, relPath);
  const relative = path.relative(FIXTURES_DIR, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`fixture path ${relPath} is outside ${FIXTURES_DIR}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`no fixture at test/fixtures/${relPath} (${resolved})`);
  }
  return resolved;
}

/** A fixture's exact bytes (use this for .zst and other binary artifacts). */
export function readFixtureBytes(relPath: string): Buffer {
  return readFileSync(fixturePath(relPath));
}

/** A fixture as UTF-8 text, bytes untouched (no BOM or CRLF normalization). */
export function readFixture(relPath: string): string {
  return readFixtureBytes(relPath).toString('utf8');
}

/** A JSON fixture, parsed. */
export function readFixtureJson<T = unknown>(relPath: string): T {
  return JSON.parse(readFixture(relPath)) as T;
}
