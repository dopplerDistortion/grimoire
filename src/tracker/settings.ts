// Store settings, `settings.yml` (spec §3 Layout, §4 Fold rules): one line per
// key, in key order, in the shared line format. Each value is one JSON object
// holding the setting's value and when and by whom it was set:
//
//   link_base: {"value":"https://forge.example/o/r/blob/grimoire/tracker/","at":"2026-10-11T03:15:08.750Z","by":"alice@example.com"}
//
// Keys fold one by one, the later `at` winning (fold-records.ts). Keys and
// lines this release doesn't understand are kept byte for byte.
import { lineValue, parseLines } from './lines';

/** One store setting as it stands. */
export interface StoreSetting {
  readonly value: unknown;
  /** When it was set; empty when the line doesn't say. */
  readonly at: string;
  /** Who set it (an email); empty when the line doesn't say. */
  readonly by: string;
}

/** The raw value text of every line, by key. */
export function settingLines(bytes: Buffer | null): Map<string, string> {
  return new Map(bytes ? parseLines(bytes.toString('utf8')).map(({ key, raw }) => [key, raw]) : []);
}

/** A line's setting, or null when its value isn't a `{value, at, by}` object. */
export function parseSetting(raw: string): StoreSetting | null {
  const entry = lineValue(raw);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !('value' in entry)) return null;
  const { value, at, by } = entry as { value: unknown; at?: unknown; by?: unknown };
  return { value, at: typeof at === 'string' ? at : '', by: typeof by === 'string' ? by : '' };
}

/** A setting's line value: `{"value":…,"at":…,"by":…}`, in that key order. */
export function settingLine(setting: StoreSetting): string {
  return JSON.stringify({ value: setting.value, at: setting.at, by: setting.by });
}

/** `settings.yml` from raw line values: one `key: value` line per key, in key order. */
export function serializeSettings(lines: ReadonlyMap<string, string>): Buffer {
  const keys = [...lines.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return Buffer.from(keys.map((key) => `${key}: ${lines.get(key)}\n`).join(''), 'utf8');
}
