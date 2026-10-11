// Spike F (GOK-131): copies a captured Codex artifact into test/fixtures/,
// sanitized as test/fixtures/README.md asks: the Windows user name becomes
// `USER` (a plain substring replace, so every escaping of it changes) and the
// machine's IANA time zone becomes `Etc/UTC`. Nothing else changes; in
// particular the package name `@goksening/grimoire`, which contains the user
// name, is kept. With --mcp-log=<n>, the input is stub-mcp.mjs's log and the
// output is a c2s.jsonl: the messages Codex sent to the n-th server process it
// started (0-based, in order of first message), one per line.
//
//   node sanitize.mjs <user-name> <time-zone> <src> <dst> [--mcp-log=<n>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [userName = '', timeZone = '', src = '', dst = '', mode] = process.argv.slice(2);
if (!userName || !timeZone || !src || !dst) {
  console.error('usage: node sanitize.mjs <user-name> <time-zone> <src> <dst> [--mcp-log=<n>]');
  process.exit(2);
}
let text = readFileSync(src, 'utf8');
if (mode?.startsWith('--mcp-log=')) {
  /** @type {{ pid: number, msg: unknown }[]} */
  const entries = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const pid = [...new Set(entries.map((e) => e.pid))][Number(mode.slice('--mcp-log='.length))];
  text = entries
    .filter((e) => e.pid === pid)
    .map((e) => `${JSON.stringify(e.msg)}\n`)
    .join('');
}
const KEEP = ['@goksening/grimoire'];
/** @param {number} i */
const token = (i) => `\u0000KEEP${i}\u0000`;
KEEP.forEach((k, i) => (text = text.replaceAll(k, token(i))));
text = text.replaceAll(userName, 'USER').replaceAll(timeZone, 'Etc/UTC');
const leftovers = text.match(new RegExp(userName, 'gi'));
KEEP.forEach((k, i) => (text = text.replaceAll(token(i), k)));
if (leftovers) {
  console.error(`${src}: ${leftovers.length} leftover match(es) of the user name`);
  process.exit(1);
}
mkdirSync(path.dirname(dst), { recursive: true });
writeFileSync(dst, text);
console.log(`${dst} (${Buffer.byteLength(text)} bytes)`);
