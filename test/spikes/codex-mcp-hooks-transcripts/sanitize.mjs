// Spike E (GOK-130): copies a captured Codex artifact into test/fixtures/,
// sanitized the way test/fixtures/README.md asks: the Windows user name becomes
// `USER` (in every escaping, since it is replaced as a plain substring).
// Nothing else changes; the time zone Codex wrote is kept.
//
// Before writing, it refuses any leftover: the user name or its first five
// characters (PowerShell shortens long paths, e.g. `C:\Users\goks...`), and any
// `Users\<name>` path segment whose name isn't `USER`.
//
// A `.zst` file is decoded to check it. If nothing needed replacing, its bytes
// are copied unchanged, so Codex's own zstd frame is kept; otherwise the
// sanitized text is re-encoded at level 3 (Codex's level), and a warning says so.
//
//   node sanitize.mjs <user-name> <src> <dst>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

/** @param {string} s */
const literal = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

/**
 * Every `Users` path segment (in any escaping, `\`, `\\`, `/`) followed by a
 * name other than the `USER` placeholder.
 * @param {string} text
 * @returns {string[]}
 */
export function foreignUserPaths(text) {
  return text.match(/[Uu]sers(?:\\+|\/+)(?!USER(?![\w-]))[^\\/"'\s:*?<>|]+/g) ?? [];
}

/**
 * Whatever in `text` could still name the user: the name itself, its first
 * five characters (case-insensitive, ignoring the `USER` placeholder), and
 * foreign `Users` paths.
 * @param {string} text
 * @param {string} userName
 * @returns {string[]}
 */
export function userNameLeftovers(text, userName) {
  const withoutPlaceholder = text.replaceAll('USER', '');
  const probes = [...new Set([userName, userName.slice(0, 5)])].filter(Boolean);
  return [...probes.flatMap((p) => withoutPlaceholder.match(literal(p)) ?? []), ...foreignUserPaths(text)];
}

/**
 * @param {string} text
 * @param {string} userName
 */
export const sanitizeText = (text, userName) => text.replaceAll(userName, 'USER');

/** @param {string[]} argv */
function main(argv) {
  const [userName, src, dst] = argv;
  if (!userName || src === undefined || !dst) {
    console.error('usage: node sanitize.mjs <user-name> <src> <dst>');
    process.exit(2);
  }
  const raw = readFileSync(src);
  const zst = src.endsWith('.zst');
  const original = (zst ? zlib.zstdDecompressSync(raw) : raw).toString('utf8');
  const text = sanitizeText(original, userName);
  const leftovers = userNameLeftovers(text, userName);
  if (leftovers.length > 0) {
    console.error(`${src}: leftovers that may name the user: ${JSON.stringify(leftovers.slice(0, 5))}`);
    process.exit(1);
  }
  let out = Buffer.from(text, 'utf8');
  if (zst && text === original) out = raw;
  else if (zst) {
    out = zlib.zstdCompressSync(out, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
    console.warn(`${src}: re-encoded with Node's zstd; the frame is no longer Codex's`);
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, out);
  console.log(`${dst} (${out.length} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
