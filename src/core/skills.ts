// Evolved skills (spec §8 skill_list / skill_read, §15, §18): agents list and
// read the served skills; a human creates or edits one with `skill_edit`
// (behind `grimoire skill edit <name>`), and looks at them with `skill_show`.
import { GrimoireError, invalid } from '../errors';
import {
  normalizeSkillText,
  parseSkillText,
  proposalStates,
  readSkills,
  restoreFates,
  serializeSkillText,
  skillNameProblem,
  skillVersionOf,
  SkillTextError,
  STUB_PREFIX,
  targetedPatterns,
  writeSkillChange,
  type LedgerEntry,
  type RestoreFate,
  type ServedSkill,
  type SkillParts,
  type SkillStatus,
} from '../knowledge';
import { runGit } from '../git/run';
import { cloneTag, MachineLocalStore } from '../machine-local';
import { checkHygiene, type SecretScanner } from '../scanner';
import type { DeliveryState, OfferedSkill, TrackerView } from '../tracker';
import { ledgerFile } from '../tracker/layout';
import { readCopyState } from '../generated/copy-state';
import { offeredSkills } from '../generated/offered';
import { registeredWorktrees } from '../installer/worktrees';
import { deriveScorecards, type AttentionFlag, type Scorecard, type TargetedPattern, type TraceFacts } from '../knowledge/scorecards';
import { traceCapture } from './capture';
import { decodeCursor, encodeCursor, jsonBytes, longestPrefix, RESULT_BUDGET } from './budget';
import { define, oneLine, writer, type OpEnv } from './op';
import { s } from './schema';
import { storeSetting } from './settings';
import { acknowledgeable, restorePlan, type RestorePlan } from './skill-changes';

/** The machine-local records kind of pending `skill_read` events (spec §6). */
export const SKILL_READS = 'skill-reads';

export function deliveryOn(view: Pick<TrackerView, 'settings'>): boolean {
  return storeSetting(view, 'skills.delivery') !== false;
}

/** What `start.md` records of evolved skills at an attempt's opening (spec §3, §14 Facts, Offered). */
export interface OpeningSkillFacts {
  delivery: DeliveryState;
  /** Absent when the checkout couldn't be read: nothing is known of what it offered. */
  skills_offered?: OfferedSkill[];
}

/**
 * The delivery switch in `view`, and the evolved skills the opening checkout
 * `worktree` offered, matched against every version the ledger records. Never
 * throws: what can't be read is left out.
 */
export async function openingSkillFacts(view: TrackerView, scanner: SecretScanner, worktree: string): Promise<OpeningSkillFacts> {
  const delivery: DeliveryState = deliveryOn(view) ? 'on' : 'off';
  try {
    const book = await readSkills(view, scanner);
    const known = new Map<string, Set<string>>();
    for (const state of book.skills.values()) {
      known.set(state.name, new Set(state.records.map((record) => record.to).filter((version): version is string => version !== null)));
    }
    return { delivery, skills_offered: await offeredSkills(worktree, known) };
  } catch {
    return { delivery };
  }
}

/** The skills agents get from `view`: none while delivery is off. */
async function servedSkills(view: TrackerView, scanner: SecretScanner): Promise<readonly ServedSkill[]> {
  if (!deliveryOn(view)) return [];
  return (await readSkills(view, scanner)).served;
}

export interface SkillListResult {
  /** The active evolved skills agents get, by name; empty while delivery is off. */
  skills: { name: string; description: string }[];
}

export const skillList = define({
  name: 'skill_list',
  description:
    "List the evolved skills grimoire serves in this repo, each one's name and description: procedures learned from working past issues. Read one with skill_read. The repo's own instructions and hand-written skills outrank them.",
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({}),
  async run(_input, { tracker, scanner }): Promise<SkillListResult> {
    const skills = await servedSkills(await tracker.read(), scanner);
    return { skills: skills.map(({ name, description }) => ({ name, description })) };
  },
});

export interface SkillReadResult {
  name: string;
  /** The served version: the sha256 of its text. */
  version: string;
  /** The version's whole `SKILL.md` text (or the next part of it, after a cursor). */
  text: string;
  /** The text was cut to fit: pass `cursor` back for the rest. */
  truncated?: true;
  cursor?: string;
}

/** Appends the machine-local read event `{skill, version, at, actor, nonce}`; a failure is swallowed (spec §8). */
async function recordRead(env: OpEnv, skill: string, version: string): Promise<void> {
  try {
    const records = new MachineLocalStore(env.tracker.location.commonDir).records;
    await records.append(SKILL_READS, {
      skill,
      version,
      at: env.tracker.now().toISOString(),
      actor: { ...env.actor },
      nonce: env.ctx.nonce,
    });
  } catch {
    // Best effort: a read never fails for want of its event.
  }
}

export const skillRead = define({
  name: 'skill_read',
  description:
    "Read one evolved skill grimoire serves in this repo, by name: its current SKILL.md text, learned from working past issues. Follow it unless the repo's own instructions or hand-written skills say otherwise.",
  kind: 'read',
  policy: 'agent',
  replay: 'none',
  input: s.object({
    name: s.string({ ...oneLine, description: 'the skill’s name, as skill_list gives it' }),
    cursor: s.optional(s.string({ ...oneLine, description: 'a cursor from an earlier skill_read of this skill' })),
  }),
  async run(input, env): Promise<SkillReadResult> {
    const view = await env.tracker.read();
    if (!deliveryOn(view)) {
      throw new GrimoireError('NOT_FOUND', 'evolved-skill delivery is off in this repo, so no evolved skill is served', {
        delivery: 'off',
      });
    }
    // A stub's own name works too: no evolved skill's name starts with the stub prefix.
    const name = input.name.startsWith(STUB_PREFIX) ? input.name.slice(STUB_PREFIX.length) : input.name;
    const skill = (await servedSkills(view, env.scanner)).find((served) => served.name === name);
    if (!skill) {
      throw new GrimoireError('NOT_FOUND', `grimoire serves no evolved skill named ${input.name}; skill_list lists the ones it does`, {
        skill: input.name,
      });
    }
    let offset = 0;
    if (input.cursor === undefined) await recordRead(env, skill.name, skill.version);
    else {
      const state = decodeCursor(input.cursor, 'skill_read') as { n?: unknown; v?: unknown; o?: unknown } | null;
      if (state?.n !== skill.name || typeof state.o !== 'number' || !Number.isInteger(state.o) || state.o < 0) {
        throw invalid({ cursor: `is not a cursor from a skill_read of ${skill.name}` });
      }
      if (state.v !== skill.version) {
        throw invalid({ cursor: 'is stale: the skill changed since that skill_read; read it again from the start' });
      }
      offset = state.o;
    }
    const rest = skill.text.slice(offset);
    const result: SkillReadResult = { name: skill.name, version: skill.version, text: rest };
    if (jsonBytes(result) <= RESULT_BUDGET) return result;
    const room = encodeCursor('skill_read', { n: skill.name, v: skill.version, o: skill.text.length }).length + 32;
    const part = longestPrefix(rest, (prefix) => jsonBytes({ ...result, text: prefix, truncated: true }) + room <= RESULT_BUDGET);
    return {
      ...result,
      text: part,
      truncated: true,
      cursor: encodeCursor('skill_read', { n: skill.name, v: skill.version, o: offset + part.length }),
    };
  },
});

/** One ledger record as `skill_show` lists it. */
export interface ShownChange {
  record: string;
  kind: string;
  /** The version it made current (null: none). */
  version: string | null;
  by: string;
  at: string;
}

/**
 * A decision made in this clone, one that arrived from another clone, or
 * `unknown`: the record carries no clone tag (machine-local data this release
 * couldn't use when it was made), or this clone's own tag can't be read.
 */
export type SkillOrigin = 'local' | 'other-clone' | 'unknown';

/** Where the current version came from (spec §18, The skill ledger). */
export interface SkillProvenance extends ShownChange {
  origin: SkillOrigin;
  actor: Record<string, unknown>;
  /** The tracker commit that added the record; null when this clone can't tell. */
  commit: string | null;
}

export interface ShownSkill {
  name: string;
  status: SkillStatus;
  /** The served version's description, else the current one's. */
  description: string | null;
  /** The version the ledger makes current. */
  current: string | null;
  /** The version agents get: the current one unless withheld or failing the content checks. */
  served: string | null;
  /** Deleted or ejected, and the name's block not lifted. */
  blocked: boolean;
  /** Fork losers: superseded until a human acknowledges one. */
  superseded: ShownChange[];
  /** An accept against a reject of one proposal; `withheld` when a reject was `suspicious`. */
  contested: { proposal: string; accepted: string[]; rejected: string[]; withheld: boolean }[];
  provenance: SkillProvenance | null;
  /** Watch-only scorecards (spec §18): one per version the ledger records, newest first, each with the version before it. */
  scorecards: Scorecard[];
  /** The attention flags of the version the ledger makes current. */
  attention: AttentionFlag[];
  /** With `name`: the current version's text. */
  text?: string | null;
  /** The versions an acknowledgement may pick (a fork's sides, a contested decision's); empty when there is nothing to acknowledge. */
  acknowledge: string[];
  /** How many versions the ledger has made current. */
  versions: number;
  /** The latest record of the skill (by time), or null. */
  last_change: ShownChange | null;
  /** The pending proposal on this skill or name, or null. */
  pending_proposal: string | null;
  /** With `name`: this clone's worktrees, the ones an eject may write into. */
  worktrees?: string[];
  /** With `name`: the version each worktree's copy holds, against the served one. */
  copies?: CopyStateRow[];
  /** With `name`: every record of the skill, each after the ones it follows. */
  history?: (ShownChange & { from: string | null; origin: SkillOrigin; proposal?: string; reason?: string; fate?: RestoreFate })[];
}

/** A worktree's copy of a skill (spec §20 Skills: per-worktree copy states). */
export interface CopyStateRow {
  worktree: string;
  /** The version grimoire last put in (or found in) the copy; null for none. */
  version: string | null;
  /** `current`: the served version; `behind`: another version (a refresh puts the served one back); `none`: no copy. */
  state: 'current' | 'behind' | 'none';
}

export interface SkillShowResult {
  skills: ShownSkill[];
  /** Active skills, and the cap (skills.max_active). */
  active: number;
  cap: number;
  /** More skills are active than the cap allows: creates past it after a merge are allowed, and flagged here. */
  over_cap: boolean;
  delivery: 'on' | 'off';
  /** With `name` and `restore`: what restoring that version would do, the confirmation a person sees before `skill restore`. */
  restore?: RestorePlan;
}

function shownChange(record: LedgerEntry): ShownChange {
  return { record: record.id, kind: record.kind, version: record.to, by: record.by, at: record.at };
}

/** The latest of `records` by time (the last one listed at a tie), shown; null for none. */
function latestOf(records: readonly LedgerEntry[]): ShownChange | null {
  const latest = records.reduce<LedgerEntry | null>((found, record) => (found === null || record.at >= found.at ? record : found), null);
  return latest === null ? null : shownChange(latest);
}

/**
 * The tracker commit that added each ledger record. Records are write-once, so
 * a commit's combined diff lists one only where it is new against every
 * parent: the write that made it, not a fold that brought it over.
 */
async function addingCommits(root: string, records: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (records.length === 0) return found;
  const run = await runGit(root, [
    'log',
    '-c',
    '--name-only',
    '--format=%x00%H',
    '--glob=refs/grimoire/tracke[r]',
    '--glob=refs/remotes/*/grimoire/tracker',
    '--',
    ...records.map(ledgerFile),
  ]);
  if (run.code !== 0) return found;
  for (const chunk of run.stdout.toString('utf8').split('\0')) {
    const [commit, ...files] = chunk.split(/\r?\n/).filter((line) => line !== '');
    if (!commit) continue;
    for (const file of files) {
      const id = /([0-9a-f]{64})\.md$/.exec(file)?.[1];
      if (id && !found.has(id)) found.set(id, commit);
    }
  }
  return found;
}

export const skillShow = define({
  name: 'skill_show',
  description:
    'Show the evolved skills: each one’s status, current and served versions, forks, contested decisions and provenance; with `name`, its text and ledger history. Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({
    name: s.optional(s.string({ ...oneLine, description: 'show only this skill, with its text and history' })),
    restore: s.optional(s.string({ ...oneLine, description: 'with name: a version to restore; shows what the restore would undo and drop, each diffed' })),
  }),
  async run(input, { tracker, scanner }): Promise<SkillShowResult> {
    const view = await tracker.read();
    const book = await readSkills(view, scanner);
    if (input.name !== undefined && !book.skills.has(input.name)) {
      throw new GrimoireError('NOT_FOUND', `the skill ledger has no evolved skill named ${input.name}`, { skill: input.name });
    }
    if (input.restore !== undefined && input.name === undefined) throw invalid({ restore: 'goes with name: the skill to restore' });
    const plan = input.restore !== undefined ? await restorePlan(view, scanner, book, input.name!, input.restore) : undefined;
    const states = [...book.skills.values()].filter((state) => input.name === undefined || state.name === input.name);
    // No tag yet means no record was made here; a tag that can't be read means this clone can't tell.
    const local = await new MachineLocalStore(tracker.location.commonDir).records.read<string>('clone', 'tag').then(
      (tag) => ({ readable: true, tag }),
      () => ({ readable: false, tag: undefined }),
    );
    const origin = (record: LedgerEntry): SkillOrigin =>
      !local.readable || record.clone === '' ? 'unknown' : record.clone === local.tag ? 'local' : 'other-clone';
    const commits = await addingCommits(
      tracker.location.root,
      states.map((state) => state.current?.id).filter((id): id is string => id !== undefined),
    );
    const skills: ShownSkill[] = [];
    const traces = states.length === 0 ? [] : await traceFacts(view);
    const pendingOf = new Map<string, string>();
    for (const state of proposalStates(await view.proposals.records(), book.skills)) {
      if (state.status === 'pending' && !pendingOf.has(state.record.skill)) pendingOf.set(state.record.skill, state.record.id);
    }
    const machine = new MachineLocalStore(tracker.location.commonDir);
    const worktrees = input.name === undefined ? [] : (await registeredWorktrees(tracker.location.commonDir).catch(() => ({ worktrees: [] as string[] }))).worktrees;
    for (const state of states) {
      const descriptionOf = async (version: string | null) => {
        const text = version === null ? null : await book.text(version);
        if (text === null) return null;
        try {
          return parseSkillText(text).description;
        } catch {
          return null;
        }
      };
      const shown: ShownSkill = {
        name: state.name,
        status: state.status,
        description: (await descriptionOf(state.served?.version ?? null)) ?? (await descriptionOf(state.version)),
        current: state.version,
        served: state.served?.version ?? null,
        blocked: state.blocked,
        superseded: state.superseded.map(shownChange),
        contested: state.contested.map((c) => ({
          proposal: c.proposal,
          accepted: c.accepts.map((a) => a.to).filter((v): v is string => v !== null),
          rejected: c.rejects.map((r) => r.reason ?? ''),
          withheld: c.withheld,
        })),
        provenance: state.current
          ? { ...shownChange(state.current), origin: origin(state.current), actor: { ...state.current.actor }, commit: commits.get(state.current.id) ?? null }
          : null,
        scorecards: deriveScorecards(state.name, state.records, traces, { patternOf: patternOf(await targetedPatterns(view, state.records)) }),
        attention: [],
        acknowledge: state.status === 'deleted' || state.status === 'ejected' ? [] : [...acknowledgeable(state)].sort(),
        versions: new Set(state.records.map((record) => record.to).filter((version) => version !== null)).size,
        last_change: latestOf(state.records),
        pending_proposal: pendingOf.get(state.name) ?? null,
      };
      shown.attention = [...(shown.scorecards.find((card) => card.version === state.version)?.attention ?? [])];
      if (input.name !== undefined) {
        const served = shown.served;
        shown.worktrees = [...worktrees];
        shown.copies = [];
        for (const worktree of worktrees) {
          const version = (await readCopyState(machine, worktree).catch(() => ({}) as Record<string, string>))[state.name] ?? null;
          shown.copies.push({ worktree, version, state: version === null ? 'none' : version === served ? 'current' : 'behind' });
        }
        shown.text = state.version === null ? null : await book.text(state.version);
        const fates = restoreFates(state.records);
        shown.history = state.records.map((record) => ({
          ...shownChange(record),
          from: record.from,
          origin: origin(record),
          ...(record.proposal !== undefined ? { proposal: record.proposal } : {}),
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
          ...(fates.has(record.id) ? { fate: fates.get(record.id)! } : {}),
        }));
      }
      skills.push(shown);
    }
    const cap = storeSetting(view, 'skills.max_active') as number;
    return {
      skills,
      active: book.active,
      cap,
      over_cap: book.active > cap,
      delivery: deliveryOn(view) ? 'on' : 'off',
      ...(plan ? { restore: plan } : {}),
    };
  },
});

export interface SkillEditResult {
  name: string;
  /** The version now current. */
  version: string;
  /** The version current before the edit (null: a new skill). */
  from: string | null;
  /** True when the edit made a new skill. */
  created: boolean;
  /** False when the text was already current: nothing was written. */
  changed: boolean;
}

/** The one line of `text` that holds offset `at`, counted from 1. */
function lineAt(text: string, at: number): number {
  return text.slice(0, at).split('\n').length;
}

/** A human's draft as a canonical `SKILL.md`, or INVALID naming what is wrong with it. */
export function draftParts(name: string, draft: string): SkillParts {
  let parts: SkillParts;
  try {
    parts = parseSkillText(normalizeSkillText(draft));
  } catch (error) {
    if (error instanceof SkillTextError) throw invalid({ text: error.problem });
    throw error;
  }
  if (parts.name !== name) {
    throw invalid({ text: `its frontmatter name is ${JSON.stringify(parts.name)}, not ${JSON.stringify(name)}` });
  }
  if (parts.description.trim() === '') throw invalid({ text: 'its frontmatter needs a description: when an agent should use the skill' });
  if (parts.body.trim() === '') throw invalid({ text: 'its body is empty: write the procedure below the frontmatter' });
  return parts;
}

/**
 * INVALID unless the text passes the content checks agents are served through
 * (src/knowledge/book.ts): a git conflict marker would leave the version
 * current but never served, so it is refused here instead.
 */
export function servable(text: string): void {
  const hygiene = checkHygiene(text);
  if (hygiene.status !== 'checked') throw invalid({ text: 'could not be checked for conflict markers, so it is not committed' });
  const marker = hygiene.findings.find((finding) => finding.check === 'conflict-marker');
  if (marker) {
    throw invalid({
      text: `has a git conflict marker on line ${lineAt(text, marker.start)}, and agents are never served a skill with one; resolve it, or indent the example`,
    });
  }
}

/** INVALID unless the secret scan ran and found nothing (spec §18, Secrets): a hit blocks the commit. */
export function scanned(scanner: SecretScanner, text: string): void {
  const scan = scanner.scan(text);
  if (scan.status !== 'scanned') throw invalid({ text: 'could not be secret-scanned, so it is not committed' });
  const [hit] = scan.hits;
  if (hit) {
    throw invalid({ text: `holds what looks like a secret (${hit.rule}) on line ${lineAt(text, hit.start)}; remove it` });
  }
}

export const skillEdit = define({
  name: 'skill_edit',
  description:
    'Create or edit an evolved skill: commit a new skill version from the whole SKILL.md text, checked against the version the edit started from. Human-only; `grimoire skill edit <name>` opens the editor.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    name: s.string(oneLine),
    text: s.string({ description: 'the whole SKILL.md: name and description frontmatter, then the body' }),
    base: s.nullable(s.string(oneLine), 'the version the edit started from; null for a new skill'),
    replace: s.optional(
      s.nullable(
        s.string(oneLine),
        'the version shown when `base` had moved, which the human confirmed replacing ("Replace with my draft"); null for none. The edit commits only while it is still current',
      ),
    ),
  }),
  async run(input, { ctx, tracker, actor, scanner, requestSync, servedChanged }): Promise<SkillEditResult> {
    const problem = skillNameProblem(input.name);
    if (problem) throw invalid({ name: problem });
    const author = writer(ctx);
    const parts = draftParts(input.name, input.text);
    const text = serializeSkillText(parts);
    scanned(scanner, text);
    servable(text);
    const version = skillVersionOf(text);
    // Provenance only: machine-local data this release can't write leaves the record's clone unknown.
    const clone = await cloneTag(new MachineLocalStore(tracker.location.commonDir).records).catch(() => '');
    const write = await tracker.transact({ op: 'skill-edit', author, actor }, async (draft) => {
      const limit = storeSetting(draft, 'skills.description_max') as number;
      if ([...parts.description].length > limit) {
        throw invalid({ text: `its description is ${[...parts.description].length} characters; the limit is ${limit} (skills.description_max)` });
      }
      const book = await readSkills(draft, scanner);
      const state = book.skills.get(input.name);
      const current = state?.version ?? null;
      if (version === current) {
        return { result: { name: input.name, version, from: current, created: false, changed: false } };
      }
      if (current === null) {
        if (state?.blocked) {
          throw invalid({
            name: `${input.name} was deleted or ejected, and its name stays blocked until a human lifts the block (grimoire skill unblock ${input.name})`,
          });
        }
        const cap = storeSetting(draft, 'skills.max_active') as number;
        if (book.active >= cap) {
          throw invalid({ name: `${book.active} evolved skills are active, the cap (skills.max_active is ${cap}); delete one before creating another` });
        }
      }
      // The compare-and-set: against the version the human confirmed replacing, else the one the edit started from.
      const expected = input.replace !== undefined ? input.replace : input.base;
      if (expected !== current) {
        throw new GrimoireError(
          'BASE_MOVED',
          `${input.name} changed since the edit started: it is now at ${current ?? 'no version'}; redo the edit on the current text, or replace it with the draft`,
          { name: input.name, base: input.base, current },
        );
      }
      const saw = [...new Set([input.base, current].filter((v): v is string => v !== null))];
      await writeSkillChange(draft, scanner, { kind: 'edit', skill: input.name, text, saw }, { actor, by: author.email, surface: ctx.surface, clone });
      return { result: { name: input.name, version, from: current, created: current === null, changed: true } };
    });
    // A human knowledge edit reaches other clones by the automatic sync (spec §4), and this clone's worktrees at once (§15).
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});

/** What scorecards need of every sealed trace in `view` (spec §18): its start and end facts, outcome, and captured reads. */
/** A scorecard option from the targeted patterns of a skill's versions. */
export function patternOf(patterns: ReadonlyMap<string, TargetedPattern>): (version: string) => TargetedPattern | null {
  return (version) => patterns.get(version) ?? null;
}

/** What scorecards need of every sealed trace in `view`. */
export async function traceFacts(view: TrackerView): Promise<TraceFacts[]> {
  const traces: TraceFacts[] = [];
  for (const attempt of view.allAttempts()) {
    if (attempt.end === null) continue;
    const capture = await traceCapture(view, attempt.id);
    const reads = capture.contexts.flatMap((context) =>
      context.skills_read.flatMap((read) => {
        const { name, version } = (read ?? {}) as { name?: unknown; version?: unknown };
        return typeof name === 'string' ? [{ name, version: typeof version === 'string' ? version : null }] : [];
      }),
    );
    traces.push({
      attempt: attempt.id,
      workerKind: attempt.end.worker_kind,
      delivery: attempt.start.delivery ?? null,
      wikiExposed: attempt.end.wiki_exposed,
      offered: attempt.start.skills_offered ?? null,
      reads,
      factsComplete: capture.facts_complete,
      outcome: attempt.outcome ? { verdict: attempt.outcome.verdict, reason: attempt.outcome.reason } : null,
      endedAt: attempt.end.at,
    });
  }
  return traces;
}
