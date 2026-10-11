// Spike E (GOK-130): copies a captured Codex artifact into test/fixtures/,
// sanitized the way test/fixtures/README.md asks: the Windows user name becomes
// `USER` (in every escaping, since it is replaced as a plain substring) and the
// machine's IANA time zone becomes `Etc/UTC`. Nothing else changes.
//
// A `.zst` file is decoded with Node's zstd, sanitized, and re-encoded at
// level 3 (Codex's own level), because the sanitized bytes can't keep Codex's
// original frame.
//
//   node sanitize.mjs <user-name> <time-zone> <src> <dst>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [userName, timeZone, src, dst] = process.argv.slice(2);
if (userName === undefined || timeZone === undefined || src === undefined || !dst) {
  console.error('usage: node sanitize.mjs <user-name> <time-zone> <src> <dst>');
  process.exit(2);
}

/** @param {string} text */
const sanitize = (text) => text.replaceAll(userName, 'USER').replaceAll(timeZone, 'Etc/UTC');

const raw = readFileSync(src);
const zst = src.endsWith('.zst');
const text = sanitize((zst ? zlib.zstdDecompressSync(raw) : raw).toString('utf8'));
const leftovers = text.match(new RegExp(userName.slice(2), 'gi'));
if (leftovers) {
  console.error(`${src}: ${leftovers.length} leftover match(es) of the user name`);
  process.exit(1);
}
const out = zst
  ? zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    })
  : Buffer.from(text, 'utf8');
mkdirSync(path.dirname(dst), { recursive: true });
writeFileSync(dst, out);
console.log(`${dst} (${out.length} bytes)`);
