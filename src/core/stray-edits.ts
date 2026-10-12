// Stray edits (spec §15 Stray edits; §7 the human-only gate; GLOSSARY: stray
// edit): a change someone made to a generated copy, which upkeep or the
// SessionStart fast path saved into the machine-local stray-edit store before
// putting the served text back (src/generated/stray.ts). It reaches agents
// only when a human vouches for it:
//
// - `skill_strays` (human-read) lists them, each with the agent attempts that
//   were open on this machine when it appeared;
// - `skill_record` (human-only) makes one a new skill version. It checks its
//   base, the version the copy held when it was edited: when the current
//   version moved since, it refuses with BASE_MOVED and a three-way diff
//   (current, base, the stray edit), and commits only with `replace` naming
//   the current version the human saw, so a newer version is never dropped
//   silently;
// - `skill_discard` (human-only) drops one, every one of a skill, or all.
//
// Nothing records a stray edit automatically.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GrimoireError, invalid } from '../errors';
import { dropStrayEdit, listStrayEdits, openAttemptsOf, readStrayEdit, strayEditNotice, type StrayEditEntry } from '../generated/stray';
import { runGit } from '../git/run';
import { readSkills, serializeSkillText, skillVersionOf, writeSkillChange } from '../knowledge';
import { cloneTag, MachineLocalStore } from '../machine-local';
import type { TrackerView } from '../tracker';
import { worktreeKey } from '../upkeep/checkout';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import { storeSetting } from './settings';
import { draftParts, scanned, servable } from './skills';

const strayInput = s.string({ ...oneLine, description: 'the stray edit’s id, as skill_strays lists it' });

/** One stray edit as `skill_strays` shows it. */
export interface ShownStrayEdit {
  /** What `skill record` and `skill discard` name. */
  id: string;
  skill: string;
  worktree: string;
  /** The copy's path in the worktree. */
  path: string;
  /** The text the copy held. */
  text: string;
  /** The version the edit was made on; null when unknown. */
  base: string | null;
  /** The version the worktree was served when grimoire found it. */
  served: string | null;
  /** The skill's current version now. */
  current: string | null;
  /** When grimoire found it, and when the copy was last written. */
  at: string;
  edited_at: string | null;
  /** The agent attempts open on this machine when it appeared. */
  open_attempts: string[];
  /** "stray edit to <skill> in <worktree>: Record or Discard". */
  notice: string;
}

export interface SkillStraysResult {
  stray_edits: ShownStrayEdit[];
}

function storeOf(commonDir: string): MachineLocalStore {
  return new MachineLocalStore(commonDir);
}

/** The stray edits of this clone as shown, against `view` (null: the tracker couldn't be read, so no attempts or current versions). */
export async function showStrayEdits(edits: readonly StrayEditEntry[], view: TrackerView | null, currentOf: (skill: string) => string | null, root: string): Promise<ShownStrayEdit[]> {
  const own = await worktreeKey(root);
  const shown: ShownStrayEdit[] = [];
  for (const edit of edits) {
    const elsewhere = (await worktreeKey(edit.worktree)) !== own;
    shown.push({
      id: edit.id,
      skill: edit.skill,
      worktree: edit.worktree,
      path: edit.path,
      text: edit.text,
      base: edit.base,
      served: edit.served,
      current: currentOf(edit.skill),
      at: edit.at,
      edited_at: edit.edited_at ?? null,
      open_attempts: view ? openAttemptsOf(view, edit) : [],
      notice: strayEditNotice(edit.skill, elsewhere ? edit.worktree : null),
    });
  }
  return shown;
}

export const skillStrays = define({
  name: 'skill_strays',
  description:
    'List the stray edits waiting for a human: changes made to generated skill copies, which grimoire set aside and put the served text back over, each with the agent attempts open on this machine when it appeared. Record one with skill record, or discard it with skill discard. Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({ skill: s.optional(s.string({ ...oneLine, description: 'only this skill’s stray edits' })) }),
  async run(input, { ctx, tracker, scanner }): Promise<SkillStraysResult> {
    const edits = (await listStrayEdits(storeOf(tracker.location.commonDir))).filter((edit) => input.skill === undefined || edit.skill === input.skill);
    if (edits.length === 0) return { stray_edits: [] };
    const view = await tracker.read();
    const book = await readSkills(view, scanner);
    return { stray_edits: await showStrayEdits(edits, view, (skill) => book.skills.get(skill)?.version ?? null, ctx.repo.root) };
  },
});

export interface SkillRecordResult {
  /** The stray edit recorded (it is dropped from the store). */
  stray: string;
  name: string;
  /** The version now current: the stray edit's text. */
  version: string;
  /** The version current before (null: none). */
  from: string | null;
  /** False when the stray edit's text was current already: nothing was written. */
  changed: boolean;
}

/** The three-way diff of a moved base, as `git merge-file --diff3` shows it: the current version, the base, and the stray edit. */
async function threeWayDiff(current: { version: string | null; text: string }, base: { version: string | null; text: string }, stray: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grimoire-stray-'));
  try {
    await writeFile(path.join(dir, 'current'), current.text);
    await writeFile(path.join(dir, 'base'), base.text);
    await writeFile(path.join(dir, 'stray'), stray);
    const labels = [`current ${current.version ?? '(none)'}`, `base ${base.version ?? '(unknown)'}`, 'stray edit'];
    const run = await runGit(dir, ['merge-file', '-p', '--diff3', ...labels.flatMap((label) => ['-L', label]), 'current', 'base', 'stray']);
    return run.stdout.toString('utf8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Thrown out of a write round on a moved base: the three-way diff is made outside the round. */
class Moved {
  constructor(readonly current: string | null) {}
}

export const skillRecord = define({
  name: 'skill_record',
  description:
    'Record a stray edit as a new version of its evolved skill. It checks the edit’s base: when the current version moved since, it refuses with BASE_MOVED and a three-way diff, and records only with `replace` naming the current version shown. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    stray: strayInput,
    replace: s.optional(
      s.nullable(
        s.string(oneLine),
        'the current version shown in the three-way diff of a moved base, which the human confirmed replacing; the record commits only while it is still current',
      ),
    ),
  }),
  async run(input, { ctx, tracker, actor, scanner, requestSync, servedChanged }): Promise<SkillRecordResult> {
    const author = writer(ctx);
    const store = storeOf(tracker.location.commonDir);
    const edit = await readStrayEdit(store, input.stray);
    if (!edit) throw new GrimoireError('NOT_FOUND', `there is no stray edit ${input.stray}; skill strays lists them`, { stray: input.stray });
    const parts = draftParts(edit.skill, edit.text);
    const text = serializeSkillText(parts);
    scanned(scanner, text);
    servable(text);
    const version = skillVersionOf(text);
    const clone = await cloneTag(store.records).catch(() => '');
    let write;
    try {
      write = await tracker.transact({ op: 'record', author, actor }, async (draft) => {
        const limit = storeSetting(draft, 'skills.description_max') as number;
        if ([...parts.description].length > limit) {
          throw invalid({ stray: `its description is ${[...parts.description].length} characters; the limit is ${limit} (skills.description_max)` });
        }
        const book = await readSkills(draft, scanner);
        const state = book.skills.get(edit.skill);
        const current = state?.version ?? null;
        if (version === current) return { result: { stray: edit.id, name: edit.skill, version, from: current, changed: false } };
        if (current === null) {
          // Recording over no version creates the skill again: the checks a create gets.
          if (state?.blocked) {
            throw invalid({
              stray: `${edit.skill} was deleted or ejected, and its name stays blocked until a human lifts the block (grimoire skill unblock ${edit.skill})`,
            });
          }
          const cap = storeSetting(draft, 'skills.max_active') as number;
          if (book.active >= cap) {
            throw invalid({ stray: `${book.active} evolved skills are active, the cap (skills.max_active is ${cap}); delete one before recording another` });
          }
        }
        // `replace` (null included: no version) names what the human confirmed replacing; else the edit's base must still be current.
        const confirmed = input.replace !== undefined ? input.replace === current : edit.base !== null && edit.base === current;
        if (!confirmed) throw new Moved(current);
        const saw = [...new Set([edit.base, current].filter((v): v is string => v !== null))];
        await writeSkillChange(draft, scanner, { kind: 'record', skill: edit.skill, text, saw }, { actor, by: author.email, surface: ctx.surface, clone });
        return { result: { stray: edit.id, name: edit.skill, version, from: current, changed: true } };
      });
    } catch (error) {
      if (!(error instanceof Moved)) throw error;
      const book = await readSkills(await tracker.read(), scanner);
      const textOf = async (v: string | null) => (v === null ? '' : ((await book.text(v)) ?? ''));
      const diff = await threeWayDiff({ version: error.current, text: await textOf(error.current) }, { version: edit.base, text: await textOf(edit.base) }, edit.text);
      throw new GrimoireError(
        'BASE_MOVED',
        `${edit.skill} changed since the stray edit was made: it was made on ${edit.base ?? 'an unknown version'}, and ${edit.skill} is now at ${error.current ?? 'no version'}. Read the three-way diff, then record with replace: ${error.current ?? 'null'} to replace the current version, or discard the stray edit`,
        { stray: edit.id, name: edit.skill, base: edit.base, current: error.current, diff },
      );
    }
    // Recorded (or current already): the store keeps it no longer. The record stands if the drop fails.
    await dropStrayEdit(store, edit.id).catch(() => false);
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});

export interface SkillDiscardResult {
  /** The ids of the stray edits dropped. */
  discarded: string[];
}

export const skillDiscard = define({
  name: 'skill_discard',
  description: 'Discard stray edits: one by its id, every one of a skill (`skill`), or all of them (`all: true`). Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    stray: s.optional(strayInput),
    skill: s.optional(s.string({ ...oneLine, description: 'discard every stray edit of this skill' })),
    all: s.optional(s.boolean('discard every stray edit')),
  }),
  async run(input, { tracker }): Promise<SkillDiscardResult> {
    const given = [input.stray !== undefined, input.skill !== undefined, input.all === true].filter(Boolean).length;
    if (given !== 1) throw invalid({ stray: 'name one stray edit, or a skill, or all: true' });
    const store = storeOf(tracker.location.commonDir);
    let chosen: StrayEditEntry[];
    if (input.stray !== undefined) {
      const edit = await readStrayEdit(store, input.stray);
      if (!edit) throw new GrimoireError('NOT_FOUND', `there is no stray edit ${input.stray}; skill strays lists them`, { stray: input.stray });
      chosen = [edit];
    } else {
      chosen = (await listStrayEdits(store)).filter((edit) => input.all === true || edit.skill === input.skill);
    }
    const discarded: string[] = [];
    for (const edit of chosen) if (await dropStrayEdit(store, edit.id)) discarded.push(edit.id);
    return { discarded };
  },
});
