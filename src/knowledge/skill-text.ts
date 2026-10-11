// Skill text (spec §18 Skill versions, Names; §15 What reaches working agents):
// a skill version is one `SKILL.md` text, identified by the sha256 of its
// normalized form (UTF-8, LF, no BOM). Only `name`, `description` and the body
// survive; grimoire writes the frontmatter itself, so the same skill always has
// the same bytes.
import { createHash } from 'node:crypto';

/** The longest evolved-skill name: `grimoire-<name>` then fits the Agent Skills 64-character limit. */
export const MAX_SKILL_NAME = 55;
/** Stubs carry this prefix, so no evolved skill may (spec §15, Reserved names). */
export const STUB_PREFIX = 'grimoire-';
/** `chores` and every shipped skill name (spec §15). */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['chores']);

/** Kebab-case: lowercase letters and digits in hyphen-separated runs. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `name` can't name an evolved skill, or null when it can. Blocked names are the ledger's to judge. */
export function skillNameProblem(name: string): string | null {
  if (name.length < 1 || name.length > MAX_SKILL_NAME) {
    return `must be 1 to ${MAX_SKILL_NAME} characters, so that its stub name grimoire-<name> stays within 64`;
  }
  if (!KEBAB.test(name)) return 'must be kebab-case: lowercase letters, digits and single hyphens between them';
  if (name.startsWith(STUB_PREFIX)) return `must not start with "${STUB_PREFIX}": that prefix is reserved for grimoire's stubs`;
  if (RESERVED_SKILL_NAMES.has(name)) return `"${name}" is reserved for a skill grimoire ships`;
  return null;
}

/** Strips a byte-order mark and turns CRLF and lone CR into LF (spec §18; ADR 0008). */
export function normalizeSkillText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** The version id of a normalized text: its sha256, in hex. */
export function skillVersionOf(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** One skill's parts: what survives of a `SKILL.md`. */
export interface SkillParts {
  readonly name: string;
  readonly description: string;
  /** Everything after the closing `---` line. */
  readonly body: string;
}

/** A text that isn't a `SKILL.md` grimoire can keep: why, keyed by what is wrong. */
export class SkillTextError extends Error {
  constructor(readonly problem: string) {
    super(problem);
  }
}

/**
 * The parts of a normalized `SKILL.md`: frontmatter between `---` lines holding
 * exactly `name` and `description`, each a one-line YAML scalar (plain, single-
 * or double-quoted), then the body. Throws SkillTextError otherwise.
 */
export function parseSkillText(normalized: string): SkillParts {
  if (!normalized.startsWith('---\n')) {
    throw new SkillTextError('must start with a `---` frontmatter block holding name and description');
  }
  const close = normalized.indexOf('\n---', 3);
  const after = close < 0 ? -1 : close + 4;
  if (close < 0 || (after < normalized.length && normalized[after] !== '\n')) {
    throw new SkillTextError('its frontmatter must end with a `---` line');
  }
  const values = new Map<string, string>();
  for (const line of normalized.slice(4, close).split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!match) throw new SkillTextError(`its frontmatter line ${JSON.stringify(line)} isn't a one-line \`key: value\``);
    const key = match[1]!;
    if (key !== 'name' && key !== 'description') {
      throw new SkillTextError(`only name and description frontmatter survive, so \`${key}\` is not allowed`);
    }
    if (values.has(key)) throw new SkillTextError(`its frontmatter sets ${key} twice`);
    values.set(key, scalar(key, match[2] ?? ''));
  }
  const body = after < normalized.length ? normalized.slice(after + 1) : '';
  return { name: values.get('name') ?? '', description: values.get('description') ?? '', body };
}

/** A one-line YAML scalar's value. */
function scalar(key: string, raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value === 'string') return value;
    } catch {
      // Falls through.
    }
    throw new SkillTextError(`its ${key} is a double-quoted value grimoire can't read; use plain text`);
  }
  if (text.startsWith("'")) {
    const inner = text.slice(1, -1);
    if (text.length >= 2 && text.endsWith("'") && !inner.replace(/''/g, '').includes("'")) return inner.replace(/''/g, "'");
    throw new SkillTextError(`its ${key} is a single-quoted value grimoire can't read; use plain text`);
  }
  if (/^[|>]/.test(text)) throw new SkillTextError(`its ${key} must be on one line`);
  // A plain scalar ends at a comment.
  return text.replace(/\s+#.*$/, '');
}

/** Words YAML would read as something other than text. */
const NOT_TEXT = /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

/** A value as a one-line YAML scalar: plain when that reads back as the same text, else double-quoted. */
function yamlScalar(value: string): string {
  const plain =
    value !== '' &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/: |:$| #|[\u0000-\u001f\u007f]/.test(value) &&
    !NOT_TEXT.test(value);
  return plain ? value : JSON.stringify(value);
}

/** The canonical `SKILL.md`: grimoire's own frontmatter, then the body as it is. */
export function serializeSkillText(parts: SkillParts): string {
  return `---\nname: ${yamlScalar(parts.name)}\ndescription: ${yamlScalar(parts.description)}\n---\n${parts.body}`;
}
