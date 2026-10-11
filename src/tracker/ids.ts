// Issue ids (spec §3, Ids and ordering): `gr-` + lowercase Crockford base32,
// crypto-random, 5 characters (more only after repeated clashes). A cross-clone
// collision found at a fold keeps both records, each under `<id>~<hash4>`.
import { randomBytes } from 'node:crypto';
import { GrimoireError, invalid } from '../errors';

export const ID_PREFIX = 'gr-';
/** Crockford base32, lowercase: no i, l, o or u. */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_LENGTH = 5;
export const MAX_ID_LENGTH = 8;
/** How grimoire finds an id inside any text (a link, a sentence): the detection regex of spec §3. */
export const ID_PATTERN = /\bgr-[0-9a-hjkmnp-tv-z]{5,8}\b/g;
/** What a read finds in text: an id with its collision suffix when it has one, so a link can name one side of a collision. */
const READ_REF_PATTERN = /\bgr-[0-9a-hjkmnp-tv-z]{5,8}(?:~[0-9a-f]{4})?\b/g;
/** `~<hash4>`: which side of a cross-clone id collision a record is. */
const COLLISION_SUFFIX = /~[0-9a-f]{4}$/;
/** Reads resolve a prefix only from this many suffix characters on. */
export const MIN_PREFIX = 3;

/** `length` crypto-random Crockford characters. */
export function randomIdSuffix(length: number): string {
  // 32 divides 256, so masking a byte to 5 bits is unbiased.
  return [...randomBytes(length)].map((byte) => ID_ALPHABET[byte & 31]).join('');
}

const ALIASES: Readonly<Record<string, string>> = { i: '1', l: '1', o: '0' };
const BARE_TOKEN = /^(?:gr-)?[0-9a-z]+(?:~[0-9a-f]{4})?$/;

/**
 * The suffix a bare id token names and its collision suffix (`~<hash4>`, or
 * empty), or null when `input` isn't one: case folded, the `gr-` prefix
 * optional, and the Crockford aliases i/l → 1, o → 0. Throws INVALID for a
 * token with a character outside the alphabet.
 */
function bareSuffix(input: string, field: string): { suffix: string; side: string } | null {
  const token = input.trim().toLowerCase();
  if (!BARE_TOKEN.test(token)) return null;
  const side = COLLISION_SUFFIX.exec(token)?.[0] ?? '';
  const suffix = [...token.slice(0, token.length - side.length).replace(/^gr-/, '')].map((c) => ALIASES[c] ?? c).join('');
  if ([...suffix].some((c) => !ID_ALPHABET.includes(c))) {
    throw invalid({ [field]: `"${input}" is not a grimoire id (gr- and Crockford base32)` });
  }
  return { suffix, side };
}

/**
 * The full id a write names (spec §3: writes need the full id). Accepts any
 * case, the aliases and an omitted prefix, but never a shorter prefix.
 */
export function parseWriteRef(input: string, field: string): string {
  const token = bareSuffix(input, field);
  if (token === null || token.suffix.length < ID_LENGTH || token.suffix.length > MAX_ID_LENGTH) {
    throw invalid({ [field]: `"${input}" is not a full issue id; writes need the full id, like gr-${'x'.repeat(ID_LENGTH)}` });
  }
  return ID_PREFIX + token.suffix + token.side;
}

/** The records a collision kept apart under the bare `id`, sorted; empty when there was none. */
export function collisionSides(id: string, ids: Iterable<string>): string[] {
  return [...ids].filter((other) => other !== id && bareId(other) === id).sort();
}

/** What ids that left the live view say: deleted ones, and bare ids a forwarding record maps to a record. */
export interface RetiredIds {
  /** The record a forwarding record (`forwards/<id>.md`) maps the bare id to, or undefined. */
  forwardOf(id: string): string | undefined;
  /** The delete tombstone that retired the id, or undefined. */
  deletion(id: string): { readonly by: string; readonly at: string } | undefined;
}

const NONE_RETIRED: RetiredIds = { forwardOf: () => undefined, deletion: () => undefined };

/**
 * The live record a full id names: itself, or the side its forwarding record
 * names, or the one side of a collision. A forwarding record is final: when
 * its record was deleted the id is NOT_FOUND ("deleted"), never the other
 * side. Several unforwarded sides give AMBIGUOUS_REF (until `resolve`), and a
 * deleted or unknown id NOT_FOUND.
 */
function liveRecord(input: string, id: string, ids: ReadonlySet<string>, retired: RetiredIds, field: string): string {
  if (ids.has(id)) return id;
  const forward = retired.forwardOf(id);
  if (forward !== undefined) {
    if (ids.has(forward)) return forward;
    throw notFound(field, id, retired.deletion(forward) ?? retired.deletion(id));
  }
  const sides = collisionSides(id, ids);
  if (sides.length === 1) return sides[0]!;
  if (sides.length > 1) throw ambiguous(input, sides);
  throw notFound(field, id, retired.deletion(id));
}

/**
 * The live id a write names among `ids`. A bare id whose records a
 * cross-clone collision kept apart gives AMBIGUOUS_REF, until `resolve`
 * writes its forwarding record; with no forwarding record and only one of
 * them left, it names that one, as for reads. Writes store and act on the id
 * this returns.
 */
export function resolveWriteRef(input: string, ids: ReadonlySet<string>, field: string, retired = NONE_RETIRED): string {
  return liveRecord(input, parseWriteRef(input, field), ids, retired, field);
}

/**
 * The id a read names among `ids`: a full id, a unique prefix of at least
 * three characters, or any text (a link, say) holding exactly one full id.
 */
export function resolveReadRef(input: string, ids: ReadonlySet<string>, field: string, retired = NONE_RETIRED): string {
  const token = bareSuffix(input, field);
  if (token === null) {
    const found = [...new Set(input.toLowerCase().match(READ_REF_PATTERN) ?? [])];
    if (found.length === 0) {
      throw invalid({ [field]: `"${input}" names no issue; use an id like gr-${'x'.repeat(ID_LENGTH)} or a prefix of at least ${MIN_PREFIX} characters` });
    }
    if (found.length > 1) throw ambiguous(input, found);
    return liveRecord(input, found[0]!, ids, retired, field);
  }
  if (token.suffix.length < MIN_PREFIX) {
    throw invalid({ [field]: `"${input}" is too short; a prefix needs at least ${MIN_PREFIX} characters` });
  }
  const full = ID_PREFIX + token.suffix + token.side;
  if (ids.has(full)) return full;
  // A forwarded bare id names its record, whatever records its prefix matches.
  if (retired.forwardOf(full) !== undefined) return liveRecord(input, full, ids, retired, field);
  const matches = [...ids].filter((id) => id.startsWith(full)).sort();
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    // Every match a side of one collision: its forwarding record, if any, picks the record.
    const bare = bareId(matches[0]!);
    const forward = matches.every((id) => bareId(id) === bare) ? retired.forwardOf(bare) : undefined;
    if (forward !== undefined && ids.has(forward)) return forward;
    throw ambiguous(input, matches);
  }
  if (full.length >= ID_PREFIX.length + ID_LENGTH) return liveRecord(input, full, ids, retired, field);
  throw notFound(field, full);
}

/** NOT_FOUND for an id no live record has; a deleted one says so (its id is never reused). */
export function notFound(field: string, id: string, deleted?: { readonly by: string; readonly at: string }): GrimoireError {
  if (deleted) {
    const { by, at } = deleted;
    return new GrimoireError('NOT_FOUND', `${id} was deleted by ${by || 'someone'}${at ? ` at ${at}` : ''}; deleted ids are never reused`, {
      field,
      ref: id,
      deleted: { by, at },
    });
  }
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

/** The id a record was minted as: `gr-xxxxx~<hash4>` (a cross-clone collision kept apart) without its suffix. */
export function bareId(id: string): string {
  const tilde = id.indexOf('~');
  return tilde < 0 ? id : id.slice(0, tilde);
}
