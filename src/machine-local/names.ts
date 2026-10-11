import { createHash } from 'node:crypto';

// File names for caller-chosen keys. A key that is already a safe, lowercase
// name is used as is; anything else (upper case, separators, paths, very long
// keys, Windows device names) becomes `~` plus a hash. Lower case only, so two
// keys never collide on a case-insensitive file system. The original key is
// always stored inside the file, so listings never depend on decoding names.

const SAFE = /^[a-z0-9_-][a-z0-9._-]{0,79}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;

export function fileNameForKey(key: string): string {
  const base = key.split('.')[0] ?? '';
  if (SAFE.test(key) && !key.endsWith('.') && !WINDOWS_DEVICE.test(base)) return key;
  return `~${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 40)}`;
}

const KIND = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Kinds are code-chosen folder names: lowercase letters, digits and dashes. */
export function assertKind(kind: string): void {
  if (!KIND.test(kind)) {
    throw new TypeError(`machine-local kind must match ${KIND.source}: ${JSON.stringify(kind)}`);
  }
}
