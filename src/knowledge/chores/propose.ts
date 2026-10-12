// A Skill Proposer result (spec §16 Results: Skill Proposer; §18 Proposals,
// Mechanical checks, Risk flags; ADR 0005, 0006): at most one proposal, a
// `create` or a `patch` of one evolved skill, or `no_action`. Grimoire checks
// it fail-closed against the tracker as a write round sees it, then writes the
// proposal record itself. The checks give reason codes, never the text found:
//
//   shape               the result isn't the output schema's shape
//   bad_frontmatter     the text isn't name and description frontmatter plus a body
//   name_mismatch       the frontmatter name isn't the target
//   description_too_long, empty_description, empty_body
//   at_cap              a create while skills.max_active skills are active
//   bad_name            not kebab-case, 1-55 characters, or starts with grimoire-
//   reserved_name       a name grimoire ships
//   blocked_name        a name a human deleted or ejected, until the block is lifted
//   name_collision      grimoire-<name> is taken in a client skill folder
//   name_exists         a create of a skill the run was served
//   unknown_skill       a patch of a skill that isn't active and served
//   bad_base            a patch base that was never the skill's version
//   anchor_not_found, anchor_ambiguous
//   no_change           the result is the base
//   too_long            a create over 150 lines or 8,000 characters, or a patch growing past that
//   patch_too_big       a patch changing more than 50% of the skill's lines
//   unserved            a citation (or the patched skill) the run wasn't served
//   too_little_evidence fewer than 1 pattern page, or 3 traces from 2 issues with 2 failing
//   bad_claims          a failure line that is no single line, or a cited fail without one
//   rationale_too_long, claim_too_long
//   duplicate_pending   the same text as a pending proposal
//   repeats_rejected    near-identical to a rejected, undone or deleted change
//   copied              3 or more lines copied from hand-written instructions or skills
//   hygiene, secret, unscanned
//
// A base that moved since the run was served is no reason code but the
// BASE_MOVED error: nothing is refused, and the run may read the skill again.
import { GrimoireError } from '../../errors';
import { checkHygiene, type SecretScanner } from '../../scanner';
import { sortedUnique, type CitedItem, type CitedTrace, type ProposalClaims, type ProposalOp, type RiskFlag, type TrackerView } from '../../tracker';
import type { SkillBook } from '../book';
import { changeLines, diffLines, linesOf, normalizedLines, similarity } from '../line-diff';
import { proposalStates } from '../proposals';
import { normalizeSkillText, parseSkillText, RESERVED_SKILL_NAMES, skillNameProblem, skillVersionOf, SkillTextError } from '../skill-text';
import { Problems, type Rejection } from './compile';
import type { OpenRun, ServedLog } from './runs';

/** A create's limits, and how far a patch may grow a skill (spec §18 Size). */
export const MAX_SKILL_LINES = 150;
export const MAX_SKILL_CHARS = 8_000;
/** The most of a skill's lines one patch may change. */
export const MAX_CHANGED_SHARE = 0.5;
/** Normalized line-diff similarity at which a change repeats a rejected one. */
export const REPEAT_SIMILARITY = 0.9;
/** The evidence minimum (spec §18). */
export const EVIDENCE = { pages: 1, traces: 3, issues: 2, fails: 2 } as const;
export const RATIONALE_LIMIT = 600;
const CLAIM_LIMIT = 600;
const UNVERIFIED_LIMIT = 64;
/** Copying: this many consecutive lines, each at least COPY_LINE characters. */
const COPY_RUN = 3;
const COPY_LINE = 20;

export interface ProposeContext {
  readonly view: TrackerView;
  readonly run: OpenRun;
  readonly served: ServedLog;
  readonly scanner: SecretScanner;
  readonly book: SkillBook;
  /** skills.max_active and skills.description_max. */
  readonly maxActive: number;
  readonly descriptionMax: number;
  /** The hand-written instructions' and skills' texts (the copying check). */
  readonly handwritten: readonly string[];
  /** Whether `grimoire-<name>` is taken in a client skill folder of the checkout. */
  readonly collides: (name: string) => Promise<boolean>;
  /** Whether a trace may still be served (not purged, not quarantined). */
  readonly servableTrace: (trace: string) => Promise<boolean>;
  /** Whether a page may still be served (not quarantined). */
  readonly servablePage: (slug: string) => boolean;
  /**
   * The checks at accept (spec §18 Mechanical checks): the proposal as it was
   * drafted. Duplicates of other pending proposals are tolerated then (after a
   * merge, accepting one stales the rest), and the claims are judged against
   * the traces as they stood at drafting; the evidence minimum is the
   * caller's live red flag, never a lapse.
   */
  readonly drafted?: { readonly traces: readonly CitedTrace[] };
}

/** An accepted proposal, ready to write. */
export interface ProposalPlan {
  readonly action: 'create' | 'patch';
  readonly skill: string;
  readonly base: string | null;
  readonly baseText: string;
  readonly after: readonly string[];
  readonly text: string;
  readonly version: string;
  readonly ops: readonly ProposalOp[];
  readonly citations: readonly string[];
  readonly served: readonly CitedItem[];
  readonly pages: readonly string[];
  readonly traces: readonly CitedTrace[];
  readonly claims: ProposalClaims;
  readonly unverified: { readonly client: string | null; readonly model: string | null };
  /** The lines the proposal adds (a create: all of them), and their indexes in `text`. */
  readonly added: readonly string[];
  readonly addedAt: ReadonlySet<number>;
  /** The share of the base's lines a patch changes (a create: 1). */
  readonly changedShare: number;
}

export interface NoActionPlan {
  readonly action: 'no_action';
  readonly unverified: { readonly client: string | null; readonly model: string | null };
}

export type ProposeCheck = { readonly ok: true; readonly plan: ProposalPlan | NoActionPlan } | { readonly ok: false; readonly rejection: Rejection };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

interface Shape {
  readonly action: 'create' | 'patch' | 'no_action';
  readonly target: string;
  readonly base: string | null;
  readonly text: string | null;
  readonly ops: readonly ProposalOp[];
  readonly citations: readonly string[];
  readonly claims: ProposalClaims | null;
  readonly client: string | null;
  readonly model: string | null;
}

const FIELDS = ['action', 'target', 'base_version', 'text', 'ops', 'citations', 'claims', 'client', 'model'];

/** The result's shape, as the output schema gives it; null (with `shape` problems) when it isn't. */
function shapeOf(result: unknown, p: Problems): Shape | null {
  if (!isObject(result)) {
    p.add('shape', 'result', 'must be an object with an action');
    return null;
  }
  for (const key of Object.keys(result)) if (!FIELDS.includes(key)) p.add('shape', `result.${key}`, 'is not a known field');
  const action = result.action;
  if (action !== 'create' && action !== 'patch' && action !== 'no_action') {
    p.add('shape', 'action', 'must be create, patch or no_action');
    return null;
  }
  const reported = (key: 'client' | 'model'): string | null => {
    const value = result[key];
    if (value === undefined || value === null) return null;
    if (!isString(value)) {
      p.add('shape', key, 'must be a string');
      return null;
    }
    return [...value.replace(/[\r\n]+/g, ' ')].slice(0, UNVERIFIED_LIMIT).join('').trim() || null;
  };
  const client = reported('client');
  const model = reported('model');
  if (action === 'no_action') {
    return p.empty ? { action, target: '', base: null, text: null, ops: [], citations: [], claims: null, client, model } : null;
  }
  if (!isString(result.target) || result.target.trim() === '') p.add('shape', 'target', 'is required: the skill name');
  let base: string | null = null;
  let text: string | null = null;
  const ops: ProposalOp[] = [];
  if (action === 'create') {
    if (result.base_version !== undefined && result.base_version !== null) p.add('shape', 'base_version', 'must be null for a create');
    if (result.ops !== undefined) p.add('shape', 'ops', 'is for a patch; a create gives the whole text');
    if (!isString(result.text)) p.add('shape', 'text', 'is required for a create: the whole SKILL.md');
    else text = result.text;
  } else {
    if (!isString(result.base_version) || result.base_version.trim() === '') p.add('shape', 'base_version', 'is required for a patch: the version you were served');
    else base = result.base_version.trim().toLowerCase();
    if (result.text !== undefined) p.add('shape', 'text', 'is for a create; a patch gives ops');
    if (!Array.isArray(result.ops) || result.ops.length === 0) p.add('shape', 'ops', 'is required for a patch: one or more anchored edits');
    else {
      result.ops.forEach((op: unknown, i) => {
        const at = `ops[${i}]`;
        if (!isObject(op) || (op.op !== 'append' && op.op !== 'replace' && op.op !== 'insert-after')) return p.add('shape', at, 'must be an append, replace or insert-after op');
        for (const key of Object.keys(op)) if (!['op', 'anchor', 'text'].includes(key)) return p.add('shape', `${at}.${key}`, 'is not a known field');
        if (!isString(op.text)) return p.add('shape', `${at}.text`, 'is required, as a string');
        if (op.op === 'append') {
          if (op.anchor !== undefined) return p.add('shape', `${at}.anchor`, 'an append has no anchor');
          return ops.push({ op: op.op, text: op.text });
        }
        if (!isString(op.anchor) || op.anchor === '') return p.add('shape', `${at}.anchor`, 'is required: text that occurs exactly once in the skill');
        ops.push({ op: op.op, anchor: op.anchor, text: op.text });
      });
    }
  }
  const citations: string[] = [];
  if (!Array.isArray(result.citations) || !result.citations.every(isString)) p.add('shape', 'citations', 'is required: the ids of served items the proposal rests on');
  else citations.push(...result.citations.map((c) => c.trim()));
  let claims: ProposalClaims | null = null;
  const c = result.claims;
  if (!isObject(c)) p.add('shape', 'claims', 'is required: rationale, failures, expected_signal and provenance');
  else {
    for (const key of Object.keys(c)) if (!['rationale', 'failures', 'expected_signal', 'provenance'].includes(key)) p.add('shape', `claims.${key}`, 'is not a known field');
    for (const key of ['rationale', 'expected_signal', 'provenance']) if (!isString(c[key])) p.add('shape', `claims.${key}`, 'is required, as a string');
    const failures: { trace: string; line: string }[] = [];
    if (!Array.isArray(c.failures)) p.add('shape', 'claims.failures', 'is required: one line per cited failure');
    else {
      c.failures.forEach((f: unknown, i) => {
        if (!isObject(f) || !isString(f.trace) || !isString(f.line) || Object.keys(f).some((key) => key !== 'trace' && key !== 'line')) {
          return p.add('shape', `claims.failures[${i}]`, 'must be {trace, line}');
        }
        failures.push({ trace: f.trace.trim(), line: f.line });
      });
    }
    if (p.empty) {
      claims = { rationale: c.rationale as string, failures, expected_signal: c.expected_signal as string, provenance: c.provenance as string };
    }
  }
  if (!p.empty) return null;
  return { action, target: (result.target as string).trim(), base, text, ops, citations, claims, client, model };
}

/** How often `anchor` occurs in `text` (stops at 2), and where first. */
function occurrences(text: string, anchor: string): { count: number; at: number } {
  const at = text.indexOf(anchor);
  if (at < 0) return { count: 0, at };
  return { count: text.indexOf(anchor, at + 1) < 0 ? 1 : 2, at };
}

/** The base with the ops applied in order, or null (with problems) when an anchor doesn't match exactly once. */
function applyOps(base: string, ops: readonly ProposalOp[], p: Problems): string | null {
  let out = base;
  for (const [i, op] of ops.entries()) {
    if (op.op === 'append') {
      out = out === '' || out.endsWith('\n') ? out + op.text : `${out}\n${op.text}`;
      continue;
    }
    const { count, at } = occurrences(out, op.anchor!);
    if (count !== 1) {
      p.add(count === 0 ? 'anchor_not_found' : 'anchor_ambiguous', `ops[${i}].anchor`, count === 0 ? 'occurs nowhere in the skill' : 'occurs more than once in the skill; make it longer');
      return null;
    }
    const end = at + op.anchor!.length;
    out = op.op === 'replace' ? out.slice(0, at) + op.text + out.slice(end) : out.slice(0, end) + op.text + out.slice(end);
  }
  return out;
}

/** The secret scan, and for text that may be committed, the hygiene checks too. */
function scanText(text: string, field: string, p: Problems, scanner: SecretScanner): void {
  const scan = scanner.scan(text);
  if (scan.status !== 'scanned') return p.add('unscanned', field, 'could not be scanned for secrets');
  if (scan.hits.length > 0) {
    for (const hit of scan.hits) p.rules.add(hit.rule);
    return p.add('secret', field, `holds what looks like a secret (${sortedUnique(scan.hits.map((hit) => hit.rule)).join(', ')})`);
  }
  const report = checkHygiene(text);
  if (report.status !== 'checked') return p.add('hygiene', field, 'could not be checked for hygiene');
  if (report.findings.length > 0) {
    p.add('hygiene', field, `fails the hygiene checks (${sortedUnique(report.findings.map((f) => f.check)).join(', ')})`);
  }
}

/**
 * The secret scan over every string the raw result holds, field names
 * included, before any check may return: whatever else refuses it, a secret
 * still marks the rejection, so no result text is kept (spec §16 Failures).
 */
function scanRaw(value: unknown, field: string, p: Problems, scanner: SecretScanner): void {
  const scan = (text: string, at: string) => {
    const found = scanner.scan(text);
    if (found.status !== 'scanned') return p.add('unscanned', at, 'could not be scanned for secrets');
    if (found.hits.length === 0) return;
    for (const hit of found.hits) p.rules.add(hit.rule);
    p.add('secret', at, `holds what looks like a secret (${sortedUnique(found.hits.map((hit) => hit.rule)).join(', ')})`);
  };
  if (typeof value === 'string') return scan(value, field);
  if (Array.isArray(value)) return value.forEach((item, i) => scanRaw(item, `${field}[${i}]`, p, scanner));
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = field === '' ? key : `${field}.${key}`;
    scan(key, field === '' ? 'result' : field);
    scanRaw(item, at, p, scanner);
  }
}

/** The trace a cited item belongs to, or null when it is no trace part. */
function traceOfItem(item: string): string | null {
  const match = /^(?:trace|issue|debrief):(.+)$/.exec(item) ?? /^excerpt:([^/]+)\//.exec(item);
  return match ? match[1]! : null;
}

/** Consecutive non-blank lines as the copying check keys them: three trimmed lines, each long enough. */
function copyKeys(text: string): Set<string> {
  const lines = linesOf(text).map((line) => line.trim()).filter((line) => line !== '');
  const keys = new Set<string>();
  for (let i = 0; i + COPY_RUN <= lines.length; i++) {
    const run = lines.slice(i, i + COPY_RUN);
    if (run.every((line) => line.length >= COPY_LINE)) keys.add(run.join('\n'));
  }
  return keys;
}

/** Whether a run of COPY_RUN long non-blank lines of `text`, one of them added, appears in a hand-written text. */
function copied(text: string, addedAt: ReadonlySet<number>, sources: readonly Set<string>[]): boolean {
  const lines = linesOf(text)
    .map((line, i) => ({ line: line.trim(), added: addedAt.has(i) }))
    .filter((entry) => entry.line !== '');
  for (let i = 0; i + COPY_RUN <= lines.length; i++) {
    const run = lines.slice(i, i + COPY_RUN);
    if (!run.some((entry) => entry.added) || !run.every((entry) => entry.line.length >= COPY_LINE)) continue;
    const key = run.map((entry) => entry.line).join('\n');
    if (sources.some((keys) => keys.has(key))) return true;
  }
  return false;
}

/**
 * The changes a new proposal may not repeat (spec §18 Repeats), for the skill
 * `name`: each rejected proposal's change, each change a restore undid, and
 * each text a delete removed.
 */
async function negativeEvidence(name: string, cx: ProposeContext): Promise<{ changes: string[][]; texts: string[][] }> {
  const { book, view } = cx;
  const state = book.skills.get(name);
  const records = state?.records ?? [];
  const changes: string[][] = [];
  const texts: string[][] = [];
  const textOf = async (version: string | null) => (version === null ? '' : ((await book.text(version)) ?? ''));
  for (const proposal of proposalStates(await view.proposals.records(), book.skills)) {
    if (proposal.record.skill !== name || proposal.status !== 'rejected') continue;
    const before = await textOf(proposal.record.base);
    changes.push(changeLines(before, proposal.record.text));
    texts.push(normalizedLines(linesOf(proposal.record.text)));
  }
  for (const restore of records.filter((record) => record.kind === 'restore' && record.from !== null)) {
    const maker = records.find((record) => record.to === restore.from && record.kind !== 'restore');
    if (!maker) continue;
    const after = await textOf(maker.to);
    changes.push(changeLines(await textOf(maker.from), after));
    texts.push(normalizedLines(linesOf(after)));
  }
  for (const removal of records.filter((record) => (record.kind === 'delete' || record.kind === 'eject') && record.from !== null)) {
    texts.push(normalizedLines(linesOf(await textOf(removal.from))));
  }
  return { changes, texts };
}

/**
 * Checks a Skill Proposer result against the tracker as `cx.view` holds it,
 * what the run was served and the hand-written texts (spec §18 Mechanical
 * checks). Throws BASE_MOVED when the target moved since the run was served.
 */
export async function checkProposal(result: unknown, cx: ProposeContext): Promise<ProposeCheck> {
  const p = new Problems();
  const shape = shapeOf(result, p);
  // After the shape (which judges an empty Problems), before every check that may return early.
  scanRaw(result, '', p, cx.scanner);
  if (!shape) return { ok: false, rejection: p.rejection() };
  for (const key of ['client', 'model'] as const) if (shape[key] !== null) scanText(shape[key], key, p, cx.scanner);
  const unverified = { client: shape.client, model: shape.model };
  if (shape.action === 'no_action') return p.empty ? { ok: true, plan: { action: 'no_action', unverified } } : { ok: false, rejection: p.rejection() };

  const { book, view } = cx;
  const served = new Map(cx.served.items.map((entry) => [entry.item, entry.hash]));
  const name = shape.target;
  const state = book.skills.get(name);

  // The target and its base.
  let baseText = '';
  if (shape.action === 'create') {
    const problem = skillNameProblem(name);
    if (problem !== null) p.add(RESERVED_SKILL_NAMES.has(name) ? 'reserved_name' : 'bad_name', 'target', problem);
    else if (state?.status === 'active') {
      if (!served.has(`skill:${name}`)) {
        throw new GrimoireError('BASE_MOVED', `the evolved skill ${name} was created since this run was served; read the skills again`, { skill: name, current: state.version });
      }
      p.add('name_exists', 'target', 'names an evolved skill that exists: patch it instead');
    } else if (state?.blocked) p.add('blocked_name', 'target', 'names a skill a human deleted or ejected; the name stays blocked until a human lifts it');
    else if (await cx.collides(name)) p.add('name_collision', 'target', `grimoire-${name} is taken in a client skill folder of this checkout`);
    if (book.active >= cx.maxActive) p.add('at_cap', 'action', `${book.active} evolved skills are active, the cap (skills.max_active): only patches are proposed now`);
  } else {
    const current = state?.status === 'active' && state.served?.version === state.version ? state.version : null;
    if (current === null) p.add('unknown_skill', 'target', 'names no evolved skill agents are served: create it instead');
    else if (!served.has(`skill:${name}`)) p.add('unserved', 'target', 'names a skill this run was not served: read it with chore_read first');
    else if (shape.base !== current) {
      if (state!.records.some((record) => record.to === shape.base)) {
        throw new GrimoireError('BASE_MOVED', `the evolved skill ${name} moved off ${shape.base} since this run was served; read it again`, {
          skill: name,
          base: shape.base,
          current,
        });
      }
      p.add('bad_base', 'base_version', 'was never a version of this skill: give the version you were served');
    } else baseText = (await book.text(current)) ?? '';
  }
  if (!p.empty && (p.reasons.has('unknown_skill') || p.reasons.has('bad_base') || (shape.action === 'patch' && p.reasons.has('unserved')))) {
    return { ok: false, rejection: p.rejection() };
  }

  // The proposed text.
  const raw = shape.action === 'create' ? shape.text! : applyOps(baseText, shape.ops, p);
  if (raw === null) return { ok: false, rejection: p.rejection() };
  const text = normalizeSkillText(raw);
  const version = skillVersionOf(text);
  try {
    const parts = parseSkillText(text);
    if (parts.name !== name) p.add('name_mismatch', 'text', `its frontmatter name must be ${JSON.stringify(name)}`);
    if (parts.description.trim() === '') p.add('empty_description', 'text', 'needs a description: trigger words first');
    if ([...parts.description].length > cx.descriptionMax) {
      p.add('description_too_long', 'text', `its description is over ${cx.descriptionMax} characters (skills.description_max)`);
    }
    if (parts.body.trim() === '') p.add('empty_body', 'text', 'needs a body: the procedure itself');
  } catch (error) {
    if (!(error instanceof SkillTextError)) throw error;
    p.add('bad_frontmatter', 'text', error.problem);
  }
  if (shape.action === 'patch' && version === shape.base) p.add('no_change', 'ops', 'leave the skill as it is');

  // Size.
  const lines = linesOf(text).length;
  const chars = [...text].length;
  const diff = diffLines(baseText, text);
  if (shape.action === 'create') {
    if (lines > MAX_SKILL_LINES || chars > MAX_SKILL_CHARS) p.add('too_long', 'text', `is ${lines} lines and ${chars} characters; a create is at most ${MAX_SKILL_LINES} lines and ${MAX_SKILL_CHARS} characters`);
  } else {
    const baseLines = linesOf(baseText).length;
    const baseChars = [...baseText].length;
    if ((lines > MAX_SKILL_LINES && lines > baseLines) || (chars > MAX_SKILL_CHARS && chars > baseChars)) {
      p.add('too_long', 'ops', `would grow the skill to ${lines} lines and ${chars} characters, past ${MAX_SKILL_LINES} lines or ${MAX_SKILL_CHARS} characters`);
    }
    if (diff.changedShare > MAX_CHANGED_SHARE) p.add('patch_too_big', 'ops', `changes ${Math.round(diff.changedShare * 100)}% of the skill's lines; a patch changes at most ${MAX_CHANGED_SHARE * 100}%`);
  }

  // Citations and the evidence minimum: only served items count.
  const citations = sortedUnique(shape.citations);
  const pages = new Set<string>();
  const traces = new Map<string, { trace: string; issue: string; outcome: string; wiki_exposed: boolean }>();
  for (const [i, item] of shape.citations.entries()) {
    if (!served.has(item)) {
      p.add('unserved', `citations[${i}]`, 'names an item this run was not served: read it with chore_read first');
      continue;
    }
    const page = /^(?:page:([^/]+)|side:([^/]+)\/.+)$/.exec(item);
    if (page) {
      const slug = (page[1] ?? page[2])!;
      if (cx.servablePage(slug) && (await view.wiki.page(slug))) pages.add(slug);
      continue;
    }
    const trace = traceOfItem(item);
    if (trace === null || traces.has(trace) || !(await cx.servableTrace(trace))) continue;
    const attempt = view.attempt(trace)!;
    traces.set(trace, {
      trace,
      issue: attempt.issue,
      outcome: attempt.outcome?.verdict ?? 'none',
      wiki_exposed: attempt.start.wiki_exposed || (attempt.end?.wiki_exposed ?? false),
    });
  }
  const counted = [...traces.values()].filter((t) => t.outcome === 'pass' || t.outcome === 'fail');
  const issues = new Set(counted.map((t) => t.issue)).size;
  const fails = counted.filter((t) => t.outcome === 'fail');
  if (pages.size < EVIDENCE.pages || counted.length < EVIDENCE.traces || issues < EVIDENCE.issues || fails.length < EVIDENCE.fails) {
    p.add(
      'too_little_evidence',
      'citations',
      `cite at least ${EVIDENCE.pages} pattern page and ${EVIDENCE.traces} traces from ${EVIDENCE.issues} issues, ${EVIDENCE.fails} of them failing now (served, with an outcome, not quarantined); counted ${pages.size} page${pages.size === 1 ? '' : 's'}, ${counted.length} traces from ${issues} issues, ${fails.length} failing`,
    );
  }

  // The claims.
  const claims = shape.claims!;
  if ([...claims.rationale].length > RATIONALE_LIMIT) p.add('rationale_too_long', 'claims.rationale', `is over ${RATIONALE_LIMIT} characters`);
  for (const key of ['expected_signal', 'provenance'] as const) {
    if ([...claims[key]].length > CLAIM_LIMIT) p.add('claim_too_long', `claims.${key}`, `is over ${CLAIM_LIMIT} characters`);
  }
  for (const [i, failure] of claims.failures.entries()) {
    if (failure.line.trim() === '' || /[\r\n]/.test(failure.line) || [...failure.line].length > CLAIM_LIMIT) {
      p.add('bad_claims', `claims.failures[${i}].line`, 'must be one non-empty line');
    }
    if (!traces.has(failure.trace) && !citations.some((item) => traceOfItem(item) === failure.trace)) p.add('bad_claims', `claims.failures[${i}].trace`, 'is not a cited trace');
  }
  const lined = new Set(claims.failures.map((f) => f.trace));
  const unlined = (cx.drafted ? cx.drafted.traces.filter((t) => t.outcome === 'fail') : fails).filter((t) => !lined.has(t.trace));
  if (unlined.length > 0) p.add('bad_claims', 'claims.failures', `give one line for each cited failing trace; missing: ${unlined.map((t) => t.trace).join(', ')}`);

  // Repeats.
  for (const pending of cx.drafted ? [] : proposalStates(await view.proposals.records(), book.skills)) {
    if (pending.status === 'pending' && pending.record.skill === name && pending.record.version === version) {
      p.add('duplicate_pending', 'text', `is the text of the pending proposal ${pending.record.id}`);
    }
  }
  const negative = await negativeEvidence(name, cx);
  if (shape.action === 'patch') {
    const change = changeLines(baseText, text);
    if (negative.changes.some((other) => other.length > 0 && similarity(change, other) >= REPEAT_SIMILARITY)) {
      p.add('repeats_rejected', 'ops', 'is near-identical to a change of this skill that was rejected or undone');
    }
  } else {
    const mine = normalizedLines(linesOf(text));
    if (negative.texts.some((other) => similarity(mine, other) >= REPEAT_SIMILARITY)) {
      p.add('repeats_rejected', 'text', 'is near-identical to text for this name that was rejected, undone or deleted');
    }
  }

  // Copying from hand-written instructions and skills.
  const addedAt = shape.action === 'create' ? new Set(linesOf(text).map((_, i) => i)) : diff.addedAt;
  if (copied(text, addedAt, cx.handwritten.map(copyKeys))) {
    p.add('copied', 'text', `copies ${COPY_RUN} or more lines from hand-written instructions or skills; point to them instead of repeating them`);
  }

  // Hygiene and the secret scan over the text and every free-text field.
  scanText(text, 'text', p, cx.scanner);
  for (const [i, op] of shape.ops.entries()) {
    if (op.anchor !== undefined) scanText(op.anchor, `ops[${i}].anchor`, p, cx.scanner);
    scanText(op.text, `ops[${i}].text`, p, cx.scanner);
  }
  scanText(claims.rationale, 'claims.rationale', p, cx.scanner);
  scanText(claims.expected_signal, 'claims.expected_signal', p, cx.scanner);
  scanText(claims.provenance, 'claims.provenance', p, cx.scanner);
  for (const [i, failure] of claims.failures.entries()) scanText(failure.line, `claims.failures[${i}].line`, p, cx.scanner);

  if (!p.empty) return { ok: false, rejection: p.rejection() };
  const added = shape.action === 'create' ? linesOf(text) : diff.added;
  return {
    ok: true,
    plan: {
      action: shape.action,
      skill: name,
      base: shape.action === 'patch' ? shape.base : null,
      baseText,
      after: state?.heads ?? [],
      text,
      version,
      ops: shape.ops,
      citations,
      served: citations.map((item) => ({ item, hash: served.get(item)! })),
      pages: [...pages].sort(),
      traces: [...traces.values()],
      claims,
      unverified,
      added,
      addedAt,
      changedShare: shape.action === 'create' ? 1 : diff.changedShare,
    },
  };
}

// ---------------------------------------------------------------------------
// Risk flags (spec §18): computed from the proposal, shown, never rejecting.

/** A token the proposal adds whose origin is traced. */
export interface AddedToken {
  readonly token: string;
  readonly kind: 'command' | 'url' | 'package' | 'path';
}

/** The most tokens one proposal's origins are traced for. */
export const TOKEN_LIMIT = 40;

const URL_PATTERN = /\b(?:https?|ftps?):\/\/[^\s'"`<>()[\]{}]+/gi;
const PATH_PATTERN = /(?<![\w@:/.~-])(?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)+\/?/g;
const INSTALL = /^(?:npx\s+)?(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b(.*)$|^(?:pip3?|pipx|uv\s+pip)\s+install\b(.*)$|^(?:cargo\s+add|go\s+get|gem\s+install|brew\s+install|apt(?:-get)?\s+install|choco\s+install|winget\s+install)\b(.*)$/i;

const trimPunctuation = (token: string) => token.replace(/[.,;:!?]+$/, '');

/** The commands, URLs, packages and paths the proposal's added lines hold. */
export function addedTokens(plan: Pick<ProposalPlan, 'text' | 'addedAt'>): AddedToken[] {
  const tokens = new Map<string, AddedToken>();
  const add = (token: string, kind: AddedToken['kind']) => {
    const clean = token.trim();
    if (clean === '' || clean.length > 200 || tokens.has(`${kind}\n${clean}`)) return;
    tokens.set(`${kind}\n${clean}`, { token: clean, kind });
  };
  const command = (raw: string) => {
    const cmd = raw.trim().replace(/^\$\s+/, '').replace(/^>\s+/, '');
    if (cmd === '') return;
    add(cmd, 'command');
    const install = INSTALL.exec(cmd);
    const args = install ? (install[1] ?? install[2] ?? install[3] ?? '') : '';
    for (const arg of args.split(/\s+/)) if (arg !== '' && !arg.startsWith('-')) add(arg, 'package');
  };
  let fenced = false;
  linesOf(plan.text).forEach((line, i) => {
    const fence = /^\s*(?:```|~~~)/.test(line);
    if (fence) {
      fenced = !fenced;
      return;
    }
    if (!plan.addedAt.has(i)) return;
    if (fenced) {
      command(line);
      return;
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) command(match[1]!);
    for (const match of line.matchAll(URL_PATTERN)) add(trimPunctuation(match[0]), 'url');
    const prose = line.replace(URL_PATTERN, ' ').replace(/`[^`\n]+`/g, ' ');
    for (const match of prose.matchAll(PATH_PATTERN)) if (/[a-z]/i.test(match[0])) add(trimPunctuation(match[0]), 'path');
  });
  return [...tokens.values()].slice(0, TOKEN_LIMIT);
}

const DANGEROUS: readonly { flag: string; pattern: RegExp; detail: string }[] = [
  {
    flag: 'pipe_to_shell',
    pattern: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|python3?|node|pwsh|powershell|invoke-expression)\b/i,
    detail: 'pipes a download into a shell',
  },
  { flag: 'sudo', pattern: /\bsudo\b/, detail: 'runs a command with sudo' },
  {
    flag: 'disables_checks',
    pattern: /--no-verify\b|\bHUSKY=0\b|core\.hooksPath|--skip-?tests?\b|-DskipTests\b|\b(?:it|test|describe)\.skip\b|\bxit\(|\bSKIP_TESTS\b|\b(?:disable|skip|bypass)(?:s|d)?\s+(?:the\s+)?(?:git\s+)?(?:hooks?|tests?|checks?|ci)\b/i,
    detail: 'disables hooks or tests',
  },
  { flag: 'ci_edit', pattern: /\.github[\\/]workflows|\.gitlab-ci\.yml|azure-pipelines\.yml|\.circleci[\\/]|\bJenkinsfile\b|\.buildkite[\\/]/i, detail: 'edits CI configuration' },
  {
    flag: 'credential_path',
    pattern: /\.ssh[\\/]|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws[\\/]credentials|(?<![\w-])\.npmrc\b|(?<![\w-])\.netrc\b|(?<![\w-])\.pypirc\b|\.docker[\\/]config\.json|\.kube[\\/]config|\.git-credentials|\bcredentials\.json\b/i,
    detail: 'touches a credential path',
  },
];
const AI_ADDRESSED =
  /\b(?:you are an? (?:ai|assistant|language model|llm|agent)\b|as an ai\b|ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules)|disregard (?:the |all )?(?:previous|prior|above|earlier)|system prompt|the user (?:has )?(?:approved|approves|authorized|authorizes|consented))/i;
const INSTRUCTION_FILES = /\b(?:CLAUDE|AGENTS(?:\.override)?)\.md\b|(?<![\w.-])\.(?:claude|codex|agents|cursor)[\\/]/i;
const BROAD_TRIGGER = /\b(?:always|every(?:thing| task| request| time| change)|any (?:task|request|question|change|time|work)|all (?:tasks|requests|questions|changes|work|code)|whenever|no matter what)\b/i;
/** A patch changing this share of the lines or more reads as a near-rewrite; one leaving less than BIG_SHRINK of the text as a big shrink. */
const NEAR_REWRITE = 0.4;
const BIG_SHRINK = 0.7;

/** The risk flags of a proposal, token origins aside (spec §18 Risk flags). */
export function riskFlags(plan: ProposalPlan): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const added = plan.added.join('\n');
  for (const { flag, pattern, detail } of DANGEROUS) if (pattern.test(added)) flags.push({ flag, severity: 'red', detail: `the proposal ${detail}` });
  if (AI_ADDRESSED.test(added)) flags.push({ flag: 'ai_addressed', severity: 'red', detail: 'the proposal holds text addressed to the AI' });
  if (INSTRUCTION_FILES.test(added)) flags.push({ flag: 'instruction_files', severity: 'amber', detail: 'the proposal mentions instruction files or client folders' });
  let description = '';
  try {
    description = parseSkillText(plan.text).description;
  } catch {
    description = '';
  }
  if (BROAD_TRIGGER.test(description)) flags.push({ flag: 'broad_trigger', severity: 'amber', detail: 'the description triggers broadly' });
  if (plan.action === 'patch') {
    if (plan.changedShare >= NEAR_REWRITE) flags.push({ flag: 'near_rewrite', severity: 'amber', detail: `the patch changes ${Math.round(plan.changedShare * 100)}% of the skill's lines` });
    const before = [...plan.baseText].length;
    if (before > 0 && [...plan.text].length < before * BIG_SHRINK) flags.push({ flag: 'big_shrink', severity: 'amber', detail: 'the patch shrinks the skill by more than 30%' });
  }
  return flags;
}
