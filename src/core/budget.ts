// The result budget (spec §8): every result stays under ~24 KB of JSON and is
// cut well-formed by grimoire, with `truncated` and a cursor to the rest.
import { invalid } from '../errors';

/** Bytes of UTF-8 JSON a result may take: under the ~24 KB cut, with room for the envelope. */
export const RESULT_BUDGET = 24_000;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The longest prefix of `text` for which `fits` holds, never splitting a
 * surrogate pair. `fits` must be monotonic (true for every shorter prefix).
 */
export function longestPrefix(text: string, fits: (prefix: string) => boolean): string {
  if (fits(text)) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(safePrefix(text, mid))) low = mid;
    else high = mid - 1;
  }
  return safePrefix(text, low);
}

function safePrefix(text: string, length: number): string {
  const code = text.charCodeAt(length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, length - 1) : text.slice(0, length);
}

/** An opaque cursor for `kind` holding `state`. */
export function encodeCursor(kind: string, state: unknown): string {
  return Buffer.from(JSON.stringify([kind, state]), 'utf8').toString('base64url');
}

/** The state an `encodeCursor(kind, …)` cursor holds, or INVALID when it isn't one. */
export function decodeCursor(cursor: string, kind: string, field = 'cursor'): unknown {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(decoded) && decoded.length === 2 && decoded[0] === kind) return decoded[1];
  } catch {
    // Falls through to INVALID.
  }
  throw invalid({ [field]: `is not a cursor from ${kind}; pass the cursor a previous result returned` });
}
