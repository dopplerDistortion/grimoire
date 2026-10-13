// Humans control the evolved-skill set with forward-only changes (spec §18
// Restore, delete, eject, acknowledge; Forks across clones; §15 Eject, Delete
// and delivery off; ADR 0005). Each is a human-only op and one skill ledger
// record, with its actor, the basis `human review`, the surface and the
// versions the person saw:
//
// - `skill_restore` is the only undo: it makes any recorded version current
//   again, checked against the version the person saw. The change it restores
//   away from becomes `undone` (negative evidence); later versions it removes
//   along the way are `dropped` (proposable again). `skill_show` with
//   `restore` lists and diffs them first: the confirmation. It stales pending
//   proposals on the skill, and is never a `git revert`, an inverse patch or
//   a history rewrite. Restoring a deleted skill counts against the cap like
//   a create, and lifts the name's block.
// - `skill_delete` frees a cap slot, adds the deleted text to the repeat
//   check and blocks the name; copies and stubs go everywhere.
// - `skill_eject` writes the current text as ordinary files into both client
//   skill folders of a worktree the person picks (refusing if either exists),
//   records the eject and blocks the name: a hand-written skill from then on,
//   which grimoire never touches.
// - `skill_acknowledge` picks the version that stands after a fork across
//   clones, or settles a contested accept-against-reject.
// - `skill_unblock` lifts a name block.
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError, invalid } from '../errors';
import { registeredWorktrees } from '../installer/worktrees';
import {
  parseSkillText,
  proposalStates,
  readSkills,
  writeSkillChange,
  type ChangeAuthor,
  type LedgerEntry,
  type SkillBook,
  type SkillState,
  type SkillStatus,
} from '../knowledge';
import { shownDiff } from '../knowledge/line-diff';
import { restoreSpan } from '../knowledge/restore';
import { cloneTag, MachineLocalStore } from '../machine-local';
import type { SecretScanner } from '../scanner';
import type { TrackerView } from '../tracker';
import { define, oneLine, writer, type OpEnv } from './op';
import { s } from './schema';
import { storeSetting } from './settings';
import { scanned, servable } from './skills';

/** Every change in v1 is a person's (spec §18). */
const BASIS = 'human review';

const nameInput = s.string({ ...oneLine, description: 'the evolved skill’s name' });
const baseInput = s.nullable(s.string(oneLine), 'the version current when the person looked (null: none); the change commits only while it still is');

/** One change of a skill's ledger, as a restore's confirmation lists it. */
export interface PlannedChange {
  record: string;
  kind: string;
  /** The version it made current (null: none, as a delete). */
  version: string | null;
  by: string;
  at: string;
  proposal?: string;
}

/** What a restore would do (spec §18 Restore): the confirmation a person sees first. */
export interface RestorePlan {
  skill: string;
  /** The version restored. */
  version: string;
  /** The version current now (null: none, as after a delete); what `base` must name. */
  current: string | null;
  status: SkillStatus;
  /** The change restored away from: `undone`, which counts as negative evidence. */
  undone: PlannedChange | null;
  /** The later versions removed along the way: `dropped`, not negative evidence and proposable again; each diffed against the restored version. */
  dropped: (PlannedChange & { diff: string[] })[];
  /** The current text against the restored one. */
  diff: string[];
  /** A deleted skill: the restore lifts its name's block, and counts against the cap like a create. */
  lifts_block: boolean;
  active: number;
  cap: number;
}

function planned(record: LedgerEntry): PlannedChange {
  return {
    record: record.id,
    kind: record.kind,
    version: record.to,
    by: record.by,
    at: record.at,
    ...(record.proposal !== undefined ? { proposal: record.proposal } : {}),
  };
}

/** The skill `name` in `book`, or NOT_FOUND. */
function skillIn(book: SkillBook, name: string): SkillState {
  const state = book.skills.get(name);
  if (!state) throw new GrimoireError('NOT_FOUND', `the skill ledger has no evolved skill named ${name}`, { skill: name });
  return state;
}

/** BASE_MOVED unless `base` is the version current now. */
function checkBase(name: string, base: string | null, current: string | null): void {
  if (base === current) return;
  throw new GrimoireError('BASE_MOVED', `${name} changed since you looked: it is now at ${current ?? 'no version'}; look again before changing it`, {
    name,
    base,
    current,
  });
}

/**
 * The restore of `version` of `name` in `view`, or why it can't be made:
 * NOT_FOUND for an unknown skill; INVALID for a version the skill never had,
 * the current one, a text that can't be served, an ejected skill, or a
 * deleted skill at the cap.
 */
export async function restorePlan(view: TrackerView, scanner: SecretScanner, book: SkillBook, name: string, version: string): Promise<RestorePlan> {
  const state = skillIn(book, name);
  if (state.status === 'ejected') {
    throw invalid({ name: `${name} was ejected: it is a hand-written skill now, which grimoire never touches` });
  }
  if (!state.records.some((record) => record.to === version && record.kind !== 'reject' && record.kind !== 'lapse' && record.kind !== 'dismiss' && record.kind !== 'reconsider')) {
    throw invalid({ version: `was never a version of ${name}; skill show ${name} lists its history` });
  }
  if (version === state.version) throw invalid({ version: `is ${name}'s current version already` });
  const text = await book.text(version);
  if (text === null) throw invalid({ version: `its text is missing from the tracker, so it can't be restored` });
  try {
    if (parseSkillText(text).name !== name) throw invalid({ version: `its text names another skill` });
  } catch (error) {
    if (error instanceof GrimoireError) throw error;
    throw invalid({ version: `its text is not a skill grimoire can serve` });
  }
  scanned(scanner, text);
  servable(text);
  const cap = storeSetting(view, 'skills.max_active') as number;
  const removed = state.version === null;
  if (removed && book.active >= cap) {
    throw invalid({ name: `${book.active} evolved skills are active, the cap (skills.max_active is ${cap}); restoring ${name} counts like a create, so delete one first` });
  }
  const span = restoreSpan(state.records, state.current, version);
  const currentText = state.version === null ? '' : ((await book.text(state.version)) ?? '');
  const dropped: RestorePlan['dropped'] = [];
  for (const record of span.dropped) dropped.push({ ...planned(record), diff: shownDiff(text, (await book.text(record.to!)) ?? '') });
  return {
    skill: name,
    version,
    current: state.version,
    status: state.status,
    undone: span.undone ? planned(span.undone) : null,
    dropped,
    diff: shownDiff(currentText, text),
    lifts_block: state.blocked,
    active: book.active,
    cap,
  };
}

/** Who makes a change, as its ledger record carries it. */
async function authorOf(env: OpEnv): Promise<{ name: string; email: string; change: ChangeAuthor }> {
  const person = writer(env.ctx);
  // Provenance only: machine-local data this release can't write leaves the record's clone unknown.
  const clone = await cloneTag(new MachineLocalStore(env.tracker.location.commonDir).records).catch(() => '');
  return { ...person, change: { actor: env.actor, by: person.email, surface: env.ctx.surface, clone, basis: BASIS } };
}

/** The pending proposals on `skill`. */
async function pendingOn(view: TrackerView, book: SkillBook, skill: string): Promise<string[]> {
  return proposalStates(await view.proposals.records(), book.skills)
    .filter((state) => state.status === 'pending' && state.record.skill === skill)
    .map((state) => state.record.id);
}

export interface SkillRestoreResult {
  name: string;
  version: string;
  from: string | null;
  undone: PlannedChange | null;
  dropped: PlannedChange[];
  /** The name's block was lifted (a deleted skill restored). */
  lifted_block: boolean;
  /** The pending proposals on the skill the restore staled. */
  stale: string[];
  record: string;
}

export const skillRestore = define({
  name: 'skill_restore',
  description:
    'Restore an evolved skill to any version it had: the only undo. The change restored away from becomes undone (negative evidence), later versions removed along the way are dropped (proposable again), and pending proposals on the skill go stale. `skill show <name> --restore <version>` lists and diffs them first. Restoring a deleted skill counts against the cap and lifts its name block. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    name: nameInput,
    version: s.string({ ...oneLine, description: 'the version to make current again, as skill show lists it' }),
    base: baseInput,
  }),
  async run(input, env): Promise<SkillRestoreResult> {
    const { tracker, scanner, requestSync, servedChanged } = env;
    const author = await authorOf(env);
    const write = await tracker.transact<SkillRestoreResult>({ op: 'restore', author, actor: env.actor }, async (draft) => {
      const book = await readSkills(draft, scanner);
      const state = skillIn(book, input.name);
      checkBase(input.name, input.base, state.version);
      const plan = await restorePlan(draft, scanner, book, input.name, input.version);
      const pending = await pendingOn(draft, book, input.name);
      const saw = [...new Set([...(plan.current === null ? [] : [plan.current]), ...plan.dropped.map((d) => d.version!), plan.version])];
      const written = await writeSkillChange(draft, scanner, { kind: 'restore', skill: input.name, to: input.version, saw }, author.change);
      const still = new Set(await pendingOn(draft, await readSkills(draft, scanner), input.name));
      return {
        result: {
          name: input.name,
          version: input.version,
          from: plan.current,
          undone: plan.undone,
          dropped: plan.dropped.map(({ diff: _diff, ...change }) => change),
          lifted_block: plan.lifts_block,
          stale: pending.filter((id) => !still.has(id)),
          record: written.record,
        },
      };
    });
    // A human knowledge change reaches other clones by the automatic sync (spec §4), and this clone's worktrees at once (§15).
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});

export interface SkillDeleteResult {
  name: string;
  /** The version current before the delete. */
  from: string;
  /** The pending proposals on the skill the delete staled. */
  stale: string[];
  record: string;
}

export const skillDelete = define({
  name: 'skill_delete',
  description:
    'Delete an evolved skill: it frees a cap slot, its text joins the repeat check, its copies and stubs go from every worktree, and its name stays blocked until `skill unblock`. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ name: nameInput, base: baseInput }),
  async run(input, env): Promise<SkillDeleteResult> {
    const { tracker, scanner, requestSync, servedChanged } = env;
    const author = await authorOf(env);
    const write = await tracker.transact<SkillDeleteResult>({ op: 'skill-delete', author, actor: env.actor }, async (draft) => {
      const book = await readSkills(draft, scanner);
      const state = skillIn(book, input.name);
      checkBase(input.name, input.base, state.version);
      if (state.version === null) throw invalid({ name: `${input.name} is ${state.status}: there is no current version to delete` });
      const pending = await pendingOn(draft, book, input.name);
      const written = await writeSkillChange(draft, scanner, { kind: 'delete', skill: input.name, to: null, saw: [state.version] }, author.change);
      return { result: { name: input.name, from: state.version, stale: pending, record: written.record } };
    });
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});

export interface SkillUnblockResult {
  name: string;
  record: string;
}

export const skillUnblock = define({
  name: 'skill_unblock',
  description: 'Lift the block on the name of a deleted or ejected evolved skill, so it may be proposed or created again. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ name: nameInput }),
  async run(input, env): Promise<SkillUnblockResult> {
    const { tracker, scanner, requestSync } = env;
    const author = await authorOf(env);
    const write = await tracker.transact<SkillUnblockResult>({ op: 'unblock', author, actor: env.actor }, async (draft) => {
      const state = skillIn(await readSkills(draft, scanner), input.name);
      if (!state.blocked) throw invalid({ name: `${input.name}'s name is not blocked` });
      const written = await writeSkillChange(draft, scanner, { kind: 'unblock', skill: input.name, to: null, saw: [] }, author.change);
      return { result: { name: input.name, record: written.record } };
    });
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});

export interface SkillAcknowledgeResult {
  name: string;
  /** The version that stands now. */
  version: string;
  from: string | null;
  /** The contested decisions it settled, by proposal. */
  settled: string[];
  /** The versions of the fork's other sides: superseded, with no negative evidence. */
  superseded: string[];
  record: string;
}

/** The versions a person may acknowledge: each side of a fork, and for a contested decision the accepted version or the one it replaced. */
function acknowledgeable(state: SkillState): Set<string> {
  const versions = new Set<string>();
  if (state.superseded.length > 0) {
    for (const head of [state.current!, ...state.superseded]) if (head.kind !== 'delete' && head.kind !== 'eject' && head.to !== null) versions.add(head.to);
  }
  for (const contest of state.contested) {
    for (const accept of contest.accepts) {
      if (accept.to !== null) versions.add(accept.to);
      if (accept.from !== null) versions.add(accept.from);
    }
  }
  return versions;
}

export const skillAcknowledge = define({
  name: 'skill_acknowledge',
  description:
    'Pick the version of an evolved skill that stands after a fork across clones (two accepts, or two creates), or settle a contested accept-against-reject: the accepted version, or the one it replaced. A suspicious-contested accept is served nowhere until acknowledged. `skill edit` instead writes a new version. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    name: nameInput,
    version: s.string({ ...oneLine, description: 'the version that stands, as skill show lists the fork’s sides or the contested decision' }),
  }),
  async run(input, env): Promise<SkillAcknowledgeResult> {
    const { tracker, scanner, requestSync, servedChanged } = env;
    const author = await authorOf(env);
    const write = await tracker.transact<SkillAcknowledgeResult>({ op: 'acknowledge', author, actor: env.actor }, async (draft) => {
      const book = await readSkills(draft, scanner);
      const state = skillIn(book, input.name);
      if (state.status === 'deleted' || state.status === 'ejected') {
        throw invalid({ name: `${input.name} is ${state.status}, which beats every other side of a fork; restore a version to bring it back` });
      }
      const choices = acknowledgeable(state);
      if (choices.size === 0) throw invalid({ name: `${input.name} has no fork and no contested decision to acknowledge` });
      if (!choices.has(input.version)) throw invalid({ version: `is not one to acknowledge for ${input.name}: pick one of ${[...choices].sort().join(', ')}` });
      const sides = [...choices].sort();
      const written = await writeSkillChange(
        draft,
        scanner,
        { kind: 'acknowledge', skill: input.name, to: input.version, saw: [...sides.filter((v) => v !== input.version), input.version] },
        author.change,
      );
      return {
        result: {
          name: input.name,
          version: input.version,
          from: state.version,
          settled: state.contested.map((contest) => contest.proposal),
          superseded: state.superseded.length > 0 ? sides.filter((v) => v !== input.version) : [],
          record: written.record,
        },
      };
    });
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});

export interface SkillEjectResult {
  name: string;
  /** The version written out. */
  version: string;
  /** The worktree written into. */
  worktree: string;
  /** The files written, relative to the worktree: commit them. */
  files: string[];
  record: string;
}

const CLIENT_FOLDERS = ['.claude/skills', '.agents/skills'] as const;

function sameDir(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The registered worktree `wanted` names (relative to `root`), or INVALID. */
async function pickedWorktree(env: OpEnv, wanted: string | undefined): Promise<string> {
  const root = env.ctx.repo.root;
  const asked = path.resolve(root, wanted ?? '.');
  const real = await realpath(asked).catch(() => null);
  const { worktrees } = await registeredWorktrees(env.tracker.location.commonDir);
  if (real !== null) for (const worktree of worktrees) if (sameDir(worktree, real)) return worktree;
  throw invalid({ worktree: `${asked} is not a worktree of this clone; git worktree list names them` });
}

export const skillEject = define({
  name: 'skill_eject',
  description:
    'Eject an evolved skill: write its current text as ordinary files into both .claude/skills/<name>/ and .agents/skills/<name>/ of a worktree you pick (refused if either exists), record the eject and block the name. Its stubs go everywhere; commit the ejected files. From then on it is a hand-written skill grimoire never touches. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    name: nameInput,
    worktree: s.optional(s.string({ ...oneLine, description: 'the worktree of this clone to write into: a path, relative to this checkout’s root (default: this checkout)' })),
    base: baseInput,
  }),
  async run(input, env): Promise<SkillEjectResult> {
    const { tracker, scanner, requestSync, servedChanged } = env;
    const author = await authorOf(env);
    const worktree = await pickedWorktree(env, input.worktree);
    const book = await readSkills(await tracker.read(), scanner);
    const state = skillIn(book, input.name);
    checkBase(input.name, input.base, state.version);
    if (state.version === null) throw invalid({ name: `${input.name} is ${state.status}: there is no current version to eject` });
    const version = state.version;
    const text = await book.text(version);
    if (text === null) throw invalid({ name: `the text of ${input.name}'s current version is missing from the tracker` });
    // The ejected files are ordinary files agents read: only a version agents may be served goes out.
    if (state.withheld.has(version)) {
      throw invalid({
        name: `${input.name}'s current version is withheld by a contested decision with a suspicious reject, so it is served nowhere; settle it with skill acknowledge before ejecting`,
      });
    }
    if (state.served?.version !== version) throw invalid({ name: `${input.name}'s current version fails this clone's content checks, so it is served nowhere and can't be ejected` });
    scanned(scanner, text);
    servable(text);
    const files = CLIENT_FOLDERS.map((folder) => `${folder}/${input.name}/SKILL.md`);
    for (const folder of CLIENT_FOLDERS) {
      const target = path.join(worktree, ...folder.split('/'), input.name);
      if ((await lstat(target).catch(() => null)) !== null) {
        throw invalid({ name: `${folder}/${input.name} already exists in ${worktree}; eject writes only new folders` });
      }
    }
    // Written once, before the record; taken back if the record isn't committed.
    const made: string[] = [];
    const takeBack = async () => {
      for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    try {
      for (const folder of CLIENT_FOLDERS) {
        const parent = path.join(worktree, ...folder.split('/'));
        await mkdir(parent, { recursive: true });
        const dir = path.join(parent, input.name);
        await mkdir(dir);
        made.push(dir);
        await writeFile(path.join(dir, 'SKILL.md'), text, { flag: 'wx' });
      }
    } catch (error) {
      await takeBack();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw invalid({ name: `a folder for ${input.name} appeared in ${worktree} meanwhile; nothing was ejected` });
      throw error;
    }
    let write;
    try {
      write = await tracker.transact<SkillEjectResult>({ op: 'eject', author, actor: env.actor }, async (draft) => {
        const now = skillIn(await readSkills(draft, scanner), input.name);
        checkBase(input.name, version, now.version);
        const written = await writeSkillChange(draft, scanner, { kind: 'eject', skill: input.name, to: null, saw: [version] }, author.change);
        return { result: { name: input.name, version, worktree, files, record: written.record } };
      });
    } catch (error) {
      await takeBack();
      throw error;
    }
    if (write.commit) {
      requestSync(write.commit);
      servedChanged();
    }
    return write.result;
  },
});
