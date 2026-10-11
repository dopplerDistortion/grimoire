// Records of ids gone from the live view but never reused (spec §3): the
// delete tombstone `deleted/<id>.md` {by, at}, and the forwarding record
// `forwards/<id>.md` {to, by, at} that `resolve` writes for an id collision,
// mapping the bare id to the record that keeps it. Both are frontmatter in the
// shared line format; keys this release doesn't know are kept.
import { formatLine, lineValue, parseLines } from './lines';

/** A delete tombstone: who deleted the issue, and when. */
export interface Tombstone {
  readonly by: string;
  readonly at: string;
  readonly extra: Readonly<Record<string, string>>;
}

/** A forwarding record: the bare id now names the record `to` (`<id>~<hash4>`). */
export interface Forward {
  readonly to: string;
  readonly by: string;
  readonly at: string;
  readonly extra: Readonly<Record<string, string>>;
}

function frontmatter(bytes: Buffer, known: ReadonlySet<string>): { values: Map<string, unknown>; extra: Record<string, string> } {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const values = new Map<string, unknown>();
  const extra: Record<string, string> = {};
  for (const { key, raw } of close < 0 ? [] : parseLines(text.slice(4, close))) {
    if (known.has(key)) values.set(key, lineValue(raw));
    else extra[key] = raw;
  }
  return { values, extra };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function serialize(lines: string[], extra: Readonly<Record<string, string>>): Buffer {
  for (const key of Object.keys(extra).sort()) lines.push(`${key}: ${extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

const TOMBSTONE_KEYS = new Set(['by', 'at']);

export function serializeTombstone(tombstone: Tombstone): Buffer {
  return serialize([formatLine('by', tombstone.by), formatLine('at', tombstone.at)], tombstone.extra);
}

export function parseTombstone(bytes: Buffer): Tombstone {
  const { values, extra } = frontmatter(bytes, TOMBSTONE_KEYS);
  return { by: text(values.get('by')), at: text(values.get('at')), extra };
}

const FORWARD_KEYS = new Set(['to', 'by', 'at']);

export function serializeForward(forward: Forward): Buffer {
  return serialize([formatLine('to', forward.to), formatLine('by', forward.by), formatLine('at', forward.at)], forward.extra);
}

export function parseForward(bytes: Buffer): Forward {
  const { values, extra } = frontmatter(bytes, FORWARD_KEYS);
  return { to: text(values.get('to')), by: text(values.get('by')), at: text(values.get('at')), extra };
}
