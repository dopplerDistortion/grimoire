// The one line format grimoire's own tracker files share (issue frontmatter,
// the `format` marker, `settings.yml`): one `key: <JSON value>` per line. It is
// valid YAML, and every value round-trips exactly.

export interface Line {
  readonly key: string;
  /** The value's text exactly as written (normally JSON). */
  readonly raw: string;
}

const LINE = /^([^\s:][^:]*): (.*)$/;

/** Splits `key: value` lines; blank lines are skipped and malformed lines are dropped. */
export function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const line of text.split('\n')) {
    const match = LINE.exec(line.replace(/\r$/, ''));
    if (match) lines.push({ key: match[1]!, raw: match[2]! });
  }
  return lines;
}

export function formatLine(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)}`;
}

/** The parsed value of a raw line, or the raw text itself when it isn't JSON. */
export function lineValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
