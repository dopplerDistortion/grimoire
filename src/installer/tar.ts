// Unpacks an npm package tarball (gzip + ustar, as `npm pack` writes it) with
// no dependency. Every entry sits under one top folder (`package/`), which is
// dropped. Only regular files and folders are accepted; links, devices and
// any path that would land outside the target are refused.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { GrimoireError } from '../errors';

const BLOCK = 512;

function refuse(why: string): GrimoireError {
  return new GrimoireError('INVALID', `the package tarball can't be unpacked: ${why}`, {});
}

function text(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString('utf8');
}

function size(header: Buffer): number {
  const field = header.subarray(124, 136);
  // Base-256, for sizes past the octal field's 8 GiB.
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const octal = text(header, 124, 12).trim();
  return octal === '' ? 0 : Number.parseInt(octal, 8);
}

/** pax extended header records: `<len> <key>=<value>\n`. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

/** The entry's path below the top folder, or null for the top folder itself. */
function relativePath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || parts.includes('..')) throw refuse(`unsafe path ${JSON.stringify(name)}`);
  if (parts.length <= 1) return null;
  return parts.slice(1).join('/');
}

/** Unpacks `tgz` into `target` (which must exist), dropping the top folder. Returns the files written. */
export async function unpackPackage(tgz: Buffer, target: string): Promise<string[]> {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch {
    throw refuse('it is not gzip data');
  }
  const written: string[] = [];
  let longName: string | null = null;
  let paxPath: string | null = null;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const length = size(header);
    const data = tar.subarray(at + BLOCK, at + BLOCK + length);
    if (data.length < length) throw refuse('it is truncated');
    at += BLOCK + Math.ceil(length / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156]!);
    if (type === 'x') {
      paxPath = paxRecords(data).get('path') ?? paxPath;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = text(data, 0, data.length);
      continue;
    }
    const ustar = text(header, 257, 6) === 'ustar';
    const prefix = ustar ? text(header, 345, 155) : '';
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    paxPath = null;
    longName = null;

    const relative = relativePath(name);
    if (type === '5') {
      if (relative !== null) await mkdir(path.join(target, relative), { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') throw refuse(`${JSON.stringify(name)} is not a regular file`);
    if (relative === null) throw refuse(`${JSON.stringify(name)} is not inside the package folder`);
    const file = path.join(target, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: 'wx' });
    written.push(relative);
  }
  return written;
}
