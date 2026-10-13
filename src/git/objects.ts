// Git objects built in-process: hashing, tree and commit encoding, and loose
// object writes. A write therefore costs no git process per object (ADR 0007:
// spawning git per object is too slow on Windows with dozens of writers).
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export type ObjectFormat = 'sha1' | 'sha256';
export type ObjectType = 'blob' | 'tree' | 'commit';

export const TREE_MODE = '40000';
export const BLOB_MODE = '100644';

export interface TreeEntry {
  /** The mode exactly as git stores it (`40000`, `100644`, `100755`, …). */
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function zeroOid(format: ObjectFormat): string {
  return '0'.repeat(format === 'sha1' ? 40 : 64);
}

function frame(type: ObjectType, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${content.length}\0`, 'utf8'), content]);
}

/** The oid git gives an object, computed in memory: nothing is written. */
export function hashObject(format: ObjectFormat, type: ObjectType, content: Uint8Array): string {
  return createHash(format).update(frame(type, content)).digest('hex');
}

function sortKey(entry: TreeEntry): Buffer {
  // git orders a tree's entries by name bytes, comparing a subtree as if its name ended in '/'.
  return Buffer.from(entry.mode === TREE_MODE ? `${entry.name}/` : entry.name, 'utf8');
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return Buffer.concat(
    sorted.flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
      Buffer.from(entry.oid, 'hex'),
    ]),
  );
}

export function decodeTree(format: ObjectFormat, content: Buffer): TreeEntry[] {
  const oidBytes = format === 'sha1' ? 20 : 32;
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const nul = content.indexOf(0x00, space);
    if (space < 0 || nul < 0) throw new Error('malformed tree object');
    entries.push({
      mode: content.toString('utf8', at, space),
      name: content.toString('utf8', space + 1, nul),
      oid: content.toString('hex', nul + 1, nul + 1 + oidBytes),
    });
    at = nul + 1 + oidBytes;
  }
  return entries;
}

export interface Signature {
  name: string;
  email: string;
  /** The instant of the signature. */
  when: Date;
}

/** git refuses these in identities; strip them like `git commit` does. */
function cleanIdentityPart(value: string): string {
  return value.replace(/[<>\r\n]/g, '').trim();
}

function formatSignature(signature: Signature): string {
  const seconds = Math.floor(signature.when.getTime() / 1000);
  const offsetMinutes = -signature.when.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${cleanIdentityPart(signature.name)} <${cleanIdentityPart(signature.email)}> ${seconds} ${tz}`;
}

export interface CommitFields {
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  /** The full message, ending in a newline. Unsigned: no gpgsig header is ever written. */
  message: string;
}

export function encodeCommit(fields: CommitFields): Buffer {
  const lines = [
    `tree ${fields.tree}`,
    ...fields.parents.map((parent) => `parent ${parent}`),
    `author ${formatSignature(fields.author)}`,
    `committer ${formatSignature(fields.committer)}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface CommitHeader {
  tree: string;
  parents: string[];
}

export function decodeCommitHeader(content: Buffer): CommitHeader {
  const text = content.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  if (!tree) throw new Error('malformed commit object');
  return { tree, parents };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes one loose object into `objectsDir` (skipped when it is already there)
 * and returns its oid. The same bytes `git hash-object -w --no-filters` writes:
 * a zlib-deflated `<type> <size>\0<content>`, placed by temp file plus rename.
 */
export async function writeLooseObject(
  objectsDir: string,
  format: ObjectFormat,
  type: ObjectType,
  content: Uint8Array,
): Promise<string> {
  const framed = frame(type, content);
  const oid = hashObject(format, type, content);
  const dir = path.join(objectsDir, oid.slice(0, 2));
  const file = path.join(dir, oid.slice(2));
  if (await exists(file)) return oid;
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `tmp_obj_${randomBytes(6).toString('hex')}`);
  await writeFile(temp, deflateSync(framed));
  try {
    await rename(temp, file);
  } catch (error) {
    // Another writer placed the same object first (Windows refuses to rename over it).
    await unlink(temp).catch(() => {});
    if (!(await exists(file))) throw error;
  }
  return oid;
}
