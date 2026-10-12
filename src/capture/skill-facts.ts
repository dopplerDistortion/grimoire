// Skill-read facts (spec §14 Facts: Read, Normalization): which evolved-skill
// versions a bound context actually read, from three signals:
//
// 1. machine-local `skill_read` events (`eventSkillReads`);
// 2. transcript reads of `.grimoire/skills/<name>/SKILL.md`, by a file tool or
//    by shell text (Codex's legacy rollouts carry no `parsed_cmd`, so the
//    command text is what both history modes share; spike F);
// 3. Claude `Skill` calls of `grimoire-<name>`, with no version unless a read
//    of the copy follows.
//
// What a read showed is normalized before it is matched (the BOM, CRLF, the
// Codex response header and truncation marks, Claude's `N\t` line prefixes),
// then matched against every version the ledger records for that skill: the
// version whose whole text it shows, else, for a partial read, the one
// version that contains it, else `unknown`. A read of a stub is no read.
import { normalizeSkillText, STUB_PREFIX } from '../knowledge';
import type { Step, Transcript } from './steps';

/** How a read was seen: a `skill_read` event, a file tool, shell text, or a Claude `Skill` call. */
export type SkillReadVia = 'skill_read' | 'file' | 'shell' | 'skill';

/** One read, as a session record's `skills_read` slice holds it. */
export interface SkillRead {
  readonly name: string;
  /** The version read; `unknown` when no recorded version matches what was shown; null for a `Skill` call alone. */
  readonly version: string | null;
  readonly via: SkillReadVia;
  /** When the read was made: the call's time, or the event's. */
  readonly at: string;
  readonly session: string | null;
  readonly context: string | null;
}

/** Every version the ledger records for each skill: name → version id → its normalized text. */
export type SkillVersionTexts = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The version of a read no recorded version matches. */
export const UNKNOWN_VERSION = 'unknown';

/** Tools that read a file and show its text (Claude Code's `Read`). */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Read']);
/** Tools that run a shell command: Claude Code's, and Codex's in both history modes. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'exec_command', 'shell', 'local_shell', 'shell_command', 'unified_exec']);
/** Claude Code's skill tool. */
const SKILL_TOOL = 'Skill';
/** The shipped chore carrier is no evolved skill. */
const CHORES = `${STUB_PREFIX}chores`;

/** A copy's path in a call's input, in any separator spelling (JSON doubles a backslash). */
const COPY_PATH = /(?<![\w.-])\.grimoire[\\/]+skills[\\/]+([a-z0-9]+(?:-[a-z0-9]+)*)[\\/]+SKILL\.md(?![\w.-])/gi;

/** Codex's truncation marks: the middle cut (`…N tokens truncated…`, `…N chars truncated…`) and the shell's warning line. */
const MIDDLE_CUT = /…\d+ (?:tokens|chars) truncated…/;
const SHELL_WARNING = /^Warning: truncated output \(original token count: \d+\)\n/;
/** A Codex response header line; a header ends with an `Output:` line. */
const HEADER_LINE =
  /^(?:Chunk ID: .*|Wall time: .*|Original token count: .*|Total output lines: .*|Process exited with code -?\d+|Process running with session ID \d+|Exit code: -?\d+)$/;
/** Claude Code's `Read` line prefix: the line number and a tab (older releases: an arrow). */
const LINE_PREFIX = /^ *\d+(?:\t|→)/;

/**
 * The reads in `steps` (a context's window, before any cut, or a subagent's
 * transcript), in the order they were made. `transcript` names the session
 * and context they are credited to.
 */
export function transcriptSkillReads(
  transcript: Pick<Transcript, 'session' | 'context'>,
  steps: readonly Step[],
  versions: SkillVersionTexts,
): SkillRead[] {
  const results = new Map<string, Step & { kind: 'tool_result' }>();
  for (const step of steps) if (step.kind === 'tool_result' && !results.has(step.id)) results.set(step.id, step);
  const who = { session: transcript.session === '' ? null : transcript.session, context: transcript.context === '' ? null : transcript.context };

  const reads: (SkillRead & { index: number })[] = [];
  steps.forEach((step, index) => {
    if (step.kind !== 'tool_call' && step.kind !== 'subagent_launch') return;
    if (step.name === SKILL_TOOL) {
      const skill = (step.input as { skill?: unknown } | null)?.skill;
      if (typeof skill === 'string' && skill.startsWith(STUB_PREFIX) && skill !== CHORES) {
        reads.push({ name: skill.slice(STUB_PREFIX.length), version: null, via: 'skill', at: step.at, ...who, index });
      }
      return;
    }
    if (step.kind !== 'tool_call') return;
    const via = FILE_TOOLS.has(step.name) ? 'file' : SHELL_TOOLS.has(step.name) ? 'shell' : null;
    if (via === null) return;
    const result = results.get(step.id);
    if (!result || result.error) return;
    const shown = normalizeShown(result.text);
    // Nothing shown is no read: a command that only wrote the copy, or named it.
    if (shown.every((part) => part.trim() === '')) return;
    for (const name of copiesNamed(step.input)) {
      reads.push({ name, version: matchVersion(shown, versions.get(name)), via, at: step.at, ...who, index });
    }
  });
  // A `Skill` call has a version only through the read of the copy that follows it.
  return reads
    .filter((read) => read.via !== 'skill' || !reads.some((later) => later.via !== 'skill' && later.name === read.name && later.index > read.index))
    .map(({ index: _index, ...read }) => read);
}

/** A `skill_read` event as the machine-local store keeps it (spec §6, §8). */
export interface SkillReadEventFacts {
  readonly skill?: unknown;
  readonly version?: unknown;
  readonly at: string;
}

/** The reads `skill_read` events record, credited to `who`. */
export function eventSkillReads(
  events: readonly SkillReadEventFacts[],
  who: { readonly session: string | null; readonly context: string | null },
): SkillRead[] {
  const reads: SkillRead[] = [];
  for (const event of events) {
    if (typeof event.skill !== 'string') continue;
    reads.push({
      name: event.skill,
      version: typeof event.version === 'string' ? event.version : UNKNOWN_VERSION,
      via: 'skill_read',
      at: event.at,
      ...who,
    });
  }
  return reads.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The skills whose copy a call's input names, each once. */
function copiesNamed(input: unknown): string[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? null);
  return [...new Set([...text.matchAll(COPY_PATH)].map((match) => match[1]!.toLowerCase()))];
}

/**
 * What a read showed, normalized (spec §14): BOM and CRLF, then the client
 * wrappers. A middle truncation leaves the parts on either side of its mark.
 */
function normalizeShown(text: string): string[] {
  let shown = normalizeSkillText(text);
  shown = stripHeader(shown).replace(SHELL_WARNING, '');
  const lines = shown.split('\n');
  const numbered = lines.filter((line) => line !== '');
  if (numbered.length > 0 && numbered.every((line) => LINE_PREFIX.test(line))) shown = lines.map((line) => line.replace(LINE_PREFIX, '')).join('\n');
  return shown.split(MIDDLE_CUT);
}

function stripHeader(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < Math.min(lines.length, 9); i++) {
    if (lines[i] === 'Output:') return i === 0 ? text : lines.slice(i + 1).join('\n');
    if (!HEADER_LINE.test(lines[i]!)) return text;
  }
  return text;
}

/**
 * The version a read showed: one whose whole text it holds (the longest, when
 * one version's text holds another's); else, for a partial read, the one
 * version holding every part of it, in order; else `unknown`.
 */
function matchVersion(parts: readonly string[], versions: ReadonlyMap<string, string> | undefined): string {
  if (!versions || versions.size === 0) return UNKNOWN_VERSION;
  const candidates = [...versions];
  if (parts.length === 1) {
    const shown = parts[0]!;
    const whole = candidates.filter(([, text]) => text.trim() !== '' && shown.includes(text.trimEnd()));
    const longest = whole.reduce<[string, string] | null>((best, entry) => (best === null || entry[1].length > best[1].length ? entry : best), null);
    if (longest && whole.every(([, text]) => longest[1].includes(text.trimEnd()))) return longest[0];
  }
  const pieces = parts.map((part) => part.trim()).filter((part) => part !== '');
  if (pieces.length === 0) return UNKNOWN_VERSION;
  const holding = candidates.filter(([, text]) => holdsInOrder(text, pieces));
  return holding.length === 1 ? holding[0]![0] : UNKNOWN_VERSION;
}

function holdsInOrder(text: string, pieces: readonly string[]): boolean {
  let from = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}
