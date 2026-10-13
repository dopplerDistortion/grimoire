// The TOML grimoire reads and writes in `.codex/config.toml` (spec §11): its
// own marked block, compared by parsed value, and the few facts about the rest
// of the file that decide whether the block can be appended. Not a general
// TOML parser: it reads what grimoire writes (tables, arrays of tables,
// strings, integers, booleans and arrays of those) and throws on anything
// else, which counts as drift.

/** A TOML string, written as a basic string: JSON's escapes are TOML's. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export class TomlSyntaxError extends Error {
  override readonly name = 'TomlSyntaxError';
}

type Table = Record<string, unknown>;

/** Parses a key path (`a.b."c d"`) into its parts. */
function keyPath(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest !== '') {
    let part: string;
    if (rest.startsWith('"')) {
      const end = closingQuote(rest, 0);
      part = JSON.parse(rest.slice(0, end + 1)) as string;
      rest = rest.slice(end + 1).trim();
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) throw new TomlSyntaxError(`unterminated key in ${text}`);
      part = rest.slice(1, end);
      rest = rest.slice(end + 1).trim();
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) throw new TomlSyntaxError(`bad key ${text}`);
      part = match[0];
      rest = rest.slice(part.length).trim();
    }
    parts.push(part);
    if (rest === '') break;
    if (!rest.startsWith('.')) throw new TomlSyntaxError(`bad key ${text}`);
    rest = rest.slice(1).trim();
  }
  if (parts.length === 0) throw new TomlSyntaxError('empty key');
  return parts;
}

/** The index of the `"` that closes the basic string opening at `start`. */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  throw new TomlSyntaxError('unterminated string');
}

/** Reads one value at the start of `text`; returns it and what follows. */
function readValue(text: string): [unknown, string] {
  const rest = text.trimStart();
  if (rest.startsWith('"')) {
    if (rest.startsWith('"""')) throw new TomlSyntaxError('multi-line strings are not read here');
    const end = closingQuote(rest, 0);
    return [JSON.parse(rest.slice(0, end + 1).replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))), rest.slice(end + 1)];
  }
  if (rest.startsWith("'")) {
    if (rest.startsWith("'''")) throw new TomlSyntaxError('multi-line strings are not read here');
    const end = rest.indexOf("'", 1);
    if (end < 0) throw new TomlSyntaxError('unterminated literal string');
    return [rest.slice(1, end), rest.slice(end + 1)];
  }
  if (rest.startsWith('[')) {
    const items: unknown[] = [];
    let inner = rest.slice(1);
    for (;;) {
      inner = skipBlank(inner);
      if (inner.startsWith(']')) return [items, inner.slice(1)];
      const [item, after] = readValue(inner);
      items.push(item);
      inner = skipBlank(after);
      if (inner.startsWith(',')) inner = inner.slice(1);
      else if (!inner.startsWith(']')) throw new TomlSyntaxError('bad array');
    }
  }
  const scalar = /^(true|false|[+-]?\d[\d_]*)(?=\s|,|\]|#|$)/.exec(rest);
  if (scalar) {
    const word = scalar[1]!;
    const value = word === 'true' ? true : word === 'false' ? false : Number(word.replaceAll('_', ''));
    return [value, rest.slice(word.length)];
  }
  throw new TomlSyntaxError(`unsupported value: ${rest.slice(0, 20)}`);
}

/** Skips whitespace, newlines and comments (inside arrays). */
function skipBlank(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^[ \t\r\n]+/, '');
    if (trimmed.startsWith('#')) {
      const newline = trimmed.indexOf('\n');
      rest = newline < 0 ? '' : trimmed.slice(newline + 1);
      continue;
    }
    return trimmed;
  }
}

function child(table: Table, key: string): Table {
  const existing = table[key];
  if (existing === undefined) {
    const created: Table = {};
    table[key] = created;
    return created;
  }
  if (Array.isArray(existing)) {
    const last = existing.at(-1);
    if (last === null || typeof last !== 'object') throw new TomlSyntaxError(`${key} is not a table`);
    return last as Table;
  }
  if (typeof existing !== 'object' || existing === null) throw new TomlSyntaxError(`${key} is not a table`);
  return existing as Table;
}

/** Parses the subset of TOML grimoire writes into plain values. */
export function parseToml(text: string): Table {
  const root: Table = {};
  let current = root;
  let rest = text.replace(/\r\n/g, '\n');
  while (rest !== '') {
    rest = skipBlank(rest);
    if (rest === '') break;
    const newline = rest.indexOf('\n');
    const line = (newline < 0 ? rest : rest.slice(0, newline)).trim();
    if (line.startsWith('[[')) {
      const end = line.indexOf(']]');
      if (end < 0) throw new TomlSyntaxError(`bad header ${line}`);
      const parts = keyPath(line.slice(2, end));
      let table = root;
      for (const part of parts.slice(0, -1)) table = child(table, part);
      const last = parts.at(-1)!;
      const array = (table[last] ??= []) as unknown;
      if (!Array.isArray(array)) throw new TomlSyntaxError(`${last} is not an array of tables`);
      current = {};
      array.push(current);
      rest = newline < 0 ? '' : rest.slice(newline + 1);
      continue;
    }
    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end < 0) throw new TomlSyntaxError(`bad header ${line}`);
      let table = root;
      for (const part of keyPath(line.slice(1, end))) table = child(table, part);
      current = table;
      rest = newline < 0 ? '' : rest.slice(newline + 1);
      continue;
    }
    const eq = rest.indexOf('=');
    if (eq < 0 || (newline >= 0 && eq > newline)) throw new TomlSyntaxError(`bad line ${line}`);
    const parts = keyPath(rest.slice(0, eq));
    const [value, after] = readValue(rest.slice(eq + 1));
    let table = current;
    for (const part of parts.slice(0, -1)) table = child(table, part);
    const last = parts.at(-1)!;
    if (Object.hasOwn(table, last)) throw new TomlSyntaxError(`${last} is defined twice`);
    table[last] = value;
    const tail = after.replace(/^[ \t]*/, '');
    if (tail.startsWith('#')) {
      const end = tail.indexOf('\n');
      rest = end < 0 ? '' : tail.slice(end + 1);
    } else if (tail.startsWith('\n') || tail === '') {
      rest = tail.slice(1);
    } else {
      throw new TomlSyntaxError(`trailing text after ${parts.join('.')}`);
    }
  }
  return root;
}

/** The header lines of a TOML text: `[a.b]` or `[[a.b]]` with their parsed key paths, and the lines' indexes. */
function headers(lines: readonly string[]): { index: number; path: string[]; array: boolean }[] {
  const found: { index: number; path: string[]; array: boolean }[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (!match) return;
    try {
      found.push({ index, path: keyPath(match[2]!), array: match[1] === '[[' });
    } catch {
      // Not a header grimoire can name.
    }
  });
  return found;
}

/**
 * Why appending grimoire's block to this TOML (outside the block) would
 * clash, or null: an `[mcp_servers.grimoire]` defined elsewhere, or
 * `hooks.SessionStart` defined as a plain array (an array of tables can't be
 * appended to it).
 */
export function tomlClash(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let table: string[] = [];
  for (const [index, line] of lines.entries()) {
    const header = headers([line])[0];
    if (header) {
      table = header.path;
      if (table[0] === 'mcp_servers' && table[1] === 'grimoire') return `[${table.join('.')}] is already defined (line ${index + 1})`;
      continue;
    }
    const assignment = /^\s*([^=#[]+?)\s*=/.exec(line);
    if (!assignment) continue;
    let key: string[];
    try {
      key = [...table, ...keyPath(assignment[1]!)];
    } catch {
      continue;
    }
    if (key[0] === 'mcp_servers' && (key.length === 1 || key[1] === 'grimoire')) {
      return `mcp_servers.grimoire is already defined (line ${index + 1})`;
    }
    if (key[0] === 'hooks' && (key.length === 1 || (key.length === 2 && key[1] === 'SessionStart'))) {
      return `hooks${key.length > 1 ? '.SessionStart' : ''} is defined inline (line ${index + 1}), so a [[hooks.SessionStart]] group can't follow it`;
    }
  }
  return null;
}

/** How many `[[hooks.SessionStart]]` groups the text declares. */
export function sessionStartGroups(text: string): number {
  return headers(text.replace(/\r\n/g, '\n').split('\n')).filter(
    (header) => header.array && header.path.length === 2 && header.path[0] === 'hooks' && header.path[1] === 'SessionStart',
  ).length;
}
