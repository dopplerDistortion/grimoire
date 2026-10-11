// The manifest, `.grimoire/manifest.yml` (spec §11): every file and entry
// `init` wrote, so later runs refresh exactly those, `doctor` checks them and
// `uninstall` removes them. Its format is frozen by the cross-pin contract
// (removal reads only frozen lists): it may only gain fields.
//
//   # grimoire's manifest: …
//   format: 1
//   entries:
//     - {"path":".mcp.json","kind":"json-key","key":["mcpServers","grimoire"],"hash":"sha256:…","created":true,"client":"claude-code"}
//
// One entry per line, each a JSON object (valid YAML flow mappings), so the
// file reads without a YAML parser.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readTextIfExists } from '../machine-local';

/** Where the manifest lives, relative to the checkout root. */
export const MANIFEST_PATH = '.grimoire/manifest.yml';

/** The manifest's own format. */
export const MANIFEST_FORMAT = 1;

/** The closed, frozen set of entry kinds. */
export const ENTRY_KINDS = ['file', 'json-key', 'json-array-item', 'toml-table', 'marker-block', 'npm-script', 'seeded-file'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** The agent clients `init` writes pointer files for. */
export type ClientName = 'claude-code' | 'codex';
export const CLIENTS: readonly ClientName[] = ['claude-code', 'codex'];

/** One manifest entry. Fields may only be added. */
export interface ManifestEntry {
  /** POSIX path relative to the checkout root. */
  readonly path: string;
  readonly kind: EntryKind;
  /** json-key, json-array-item: the JSON path; npm-script: `["scripts", <name>]`. */
  readonly key?: readonly string[];
  /** json-array-item: the item itself when it is a plain value (an allow rule, a server name). */
  readonly item?: string;
  /** json-array-item: the hook verb whose group this is. */
  readonly hook?: string;
  /** marker-block, toml-table: the block's marker name. */
  readonly marker?: string;
  /** The normalized hash of what grimoire wrote (no BOM, LF; JSON and TOML hash their parsed values). */
  readonly hash: string;
  /** Whether grimoire created the file. */
  readonly created: boolean;
  /** The client the entry serves; absent for the dotfolder's own files and the docs. */
  readonly client?: ClientName;
  /** A grant (an allow rule, an enabled server, an approval mode): drift is reported and kept, never rewritten. */
  readonly permission?: boolean;
}

/** sha256 of text, `sha256:<hex>`. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Text as the manifest hashes it: no byte order mark, LF line endings. */
export function normalizedText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** JSON with every object's keys sorted, so equal values serialize alike. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}

/** The hash of text content. */
export function textHash(text: string): string {
  return sha256(normalizedText(text));
}

/** The hash of a parsed value (JSON values, TOML tables). */
export function valueHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** What identifies an entry within the manifest: two entries with one identity are the same target. */
export function entryIdentity(entry: Pick<ManifestEntry, 'path' | 'kind' | 'key' | 'item' | 'hook' | 'marker'>): string {
  return JSON.stringify([entry.path, entry.kind, entry.key ?? null, entry.item ?? null, entry.hook ?? null, entry.marker ?? null]);
}

export interface Manifest {
  /** The entries, as recorded; entries of kinds this release doesn't know are kept as they are. */
  readonly entries: readonly ManifestEntry[];
  /** Whether the file exists. */
  readonly exists: boolean;
}

/** The checkout's manifest; an empty one when there is none. Lines that don't parse are skipped. */
export async function readManifest(root: string): Promise<Manifest> {
  const text = await readTextIfExists(path.join(root, MANIFEST_PATH));
  if (text === undefined) return { entries: [], exists: false };
  const entries: ManifestEntry[] = [];
  for (const line of normalizedText(text).split('\n')) {
    const match = /^\s*-\s+(\{.*\})\s*$/.exec(line);
    if (!match) continue;
    try {
      const entry = JSON.parse(match[1]!) as ManifestEntry;
      if (typeof entry?.path === 'string' && typeof entry.kind === 'string') entries.push(entry);
    } catch {
      // A line that isn't one JSON object is no entry.
    }
  }
  return { entries, exists: true };
}

/** The manifest file's text. */
export function serializeManifest(entries: readonly ManifestEntry[]): string {
  const lines = [
    "# grimoire's manifest: every file and entry `grimoire init` wrote, so grimoire can refresh and remove them. Commit it; never edit it.",
    `format: ${MANIFEST_FORMAT}`,
    'entries:',
    ...entries.map((entry) => `  - ${JSON.stringify(entry)}`),
  ];
  return `${lines.join('\n')}\n`;
}
