// Issue ids (spec §3, Ids and ordering): `gr-` + lowercase Crockford base32,
// crypto-random, 5 characters (more only after repeated clashes).
import { randomBytes } from 'node:crypto';
import { GrimoireError, invalid } from '../errors';

export const ID_PREFIX = 'gr-';
/** Crockford base32, lowercase: no i, l, o or u. */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_LENGTH = 5;
export const MAX_ID_LENGTH = 8;
/** How grimoire finds an id inside any text (a link, a sentence). */
export const ID_PATTERN = /\bgr-[0-9a-hjkmnp-tv-z]{5,8}\b/g;
/** Reads resolve a prefix only from this many suffix characters on. */
export const MIN_PREFIX = 3;

/** `length` crypto-random Crockford characters. */
export function randomIdSuffix(length: number): string {
  // 32 divides 256, so masking a byte to 5 bits is unbiased.
  return [...randomBytes(length)].map((byte) => ID_ALPHABET[byte & 31]).join('');
}

const ALIASES: Readonly<Record<string, string>> = { i: '1', l: '1', o: '0' };
const BARE_TOKEN = /^(?:gr-)?[0-9a-z]+$/;

/**
 * The suffix a bare id token names, or null when `input` isn't one: case
 * folded, the `gr-` prefix optional, and the Crockford aliases i/l → 1, o → 0.
 * Throws INVALID for a token with a character outside the alphabet.
 */
function bareSuffix(input: string, field: string): string | null {
  const token = input.trim().toLowerCase();
  if (!BARE_TOKEN.test(token)) return null;
  const suffix = [...token.replace(/^gr-/, '')].map((c) => ALIASES[c] ?? c).join('');
  if ([...suffix].some((c) => !ID_ALPHABET.includes(c))) {
    throw invalid({ [field]: `"${input}" is not a grimoire id (gr- and Crockford base32)` });
  }
  return suffix;
}

/**
 * The full id a write names (spec §3: writes need the full id). Accepts any
 * case, the aliases and an omitted prefix, but never a shorter prefix.
 */
export function parseWriteRef(input: string, field: string): string {
  const suffix = bareSuffix(input, field);
  if (suffix === null || suffix.length < ID_LENGTH || suffix.length > MAX_ID_LENGTH) {
    throw invalid({ [field]: `"${input}" is not a full issue id; writes need the full id, like gr-${'x'.repeat(ID_LENGTH)}` });
  }
  return ID_PREFIX + suffix;
}

/**
 * The id a read names among `ids`: a full id, a unique prefix of at least
 * three characters, or any text (a link, say) holding exactly one full id.
 */
export function resolveReadRef(input: string, ids: ReadonlySet<string>, field: string): string {
  const suffix = bareSuffix(input, field);
  if (suffix === null) {
    const found = [...new Set(input.toLowerCase().match(ID_PATTERN) ?? [])];
    if (found.length === 0) {
      throw invalid({ [field]: `"${input}" names no issue; use an id like gr-${'x'.repeat(ID_LENGTH)} or a prefix of at least ${MIN_PREFIX} characters` });
    }
    if (found.length > 1) throw ambiguous(input, found);
    const id = found[0]!;
    if (!ids.has(id)) throw notFound(field, id);
    return id;
  }
  if (suffix.length < MIN_PREFIX) {
    throw invalid({ [field]: `"${input}" is too short; a prefix needs at least ${MIN_PREFIX} characters` });
  }
  const full = ID_PREFIX + suffix;
  if (ids.has(full)) return full;
  const matches = [...ids].filter((id) => id.startsWith(full)).sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw ambiguous(input, matches);
  throw notFound(field, full);
}

export function notFound(field: string, id: string): GrimoireError {
  return new GrimoireError('NOT_FOUND', `no issue ${id}`, { field, ref: id });
}

function ambiguous(input: string, candidates: readonly string[]): GrimoireError {
  return new GrimoireError('AMBIGUOUS_REF', `"${input}" matches several issues: ${candidates.join(', ')}`, {
    candidates: [...candidates],
  });
}

/** The two shard levels of an id: the first two characters of its suffix. */
export function shardOf(id: string): [string, string] {
  const suffix = id.slice(ID_PREFIX.length);
  return [suffix[0]!, suffix[1]!];
}
