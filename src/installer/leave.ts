// Leave (spec §21 Leave; glossary: Leave): a person removes grimoire from one
// clone on their own machine, the inverse of a join. It never changes the
// host repo, its tracker branch, the remote-tracking ref or user-level client
// files.
//
// 1. Refuses while live grimoire processes run in the clone (process records,
//    detached sync children included, and the `start` lock), and when a
//    record or the lock can't be read: it fails closed.
// 2. Read-only preflight, with its offers: release the open attempts held
//    from this machine; cut the bound contexts still uncut (which consumes
//    pending `skill_read` events); list the stray edits, saved and unsaved,
//    so the person can stop and record them first; push the unpushed tracker
//    commits (always under auto-sync, else only on an explicit yes), purging
//    their excerpt text first if asked.
// 3. One typed confirmation. Nothing changes before it.
// 4. The accepted offers, then a final sync: a push when allowed, else a
//    fetch only. Contexts the cut left uncut, or a process started since the
//    preflight, stop it here with a report (what it committed stays).
// 5. Removal, reading only what the cross-pin contract freezes (rule 7), so
//    any later release removes any install: the generated output of every
//    registered worktree (the generated-path list, plus every `grimoire-*`
//    stub folder and copy folder carrying grimoire's `.gitignore`); the whole
//    machine-local store, then `pkg/` and the launcher; the clone's
//    `grimoire.*` git config keys; the control channel's secret and sockets;
//    and `refs/grimoire/tracker` with its reflog, only when the final sync
//    showed the remote holds its tip. Otherwise the ref stays and the report
//    prints `git update-ref -d`.
import { lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SEEN_HERE, type SeenHereRow } from '../capture/seen-here';
import { stripExcerptText } from '../capture/session-record';
import { actorOf, type CallContext } from '../core/context';
import { createCore, type CaptureOptions } from '../core';
import { readCheckoutConfig } from '../core/host';
import { storeExcerptMode } from '../core/settings';
import { sweepContexts } from '../core/sweep';
import { autoSyncOn, EXPLICIT_STEP_TIMEOUT_MS, syncNow, syncRequestOf } from '../core/sync';
import { GrimoireError } from '../errors';
import {
  comparablePath,
  COPY_ROOT,
  existingFolders,
  GENERATED_GITIGNORE,
  listStrayEdits,
  MOVED_ASIDE,
  readPathList,
  servedSetOf,
  setAsideStrayEdit,
  SKILL_FILE,
  STUB_ROOTS,
  type ServedSet,
} from '../generated';
import { runGit } from '../git/run';
import { normalizeSkillText, skillVersionOf, STUB_PREFIX } from '../knowledge';
import { cloneId, findGitDirs, MachineLocalStore, readTextIfExists, retryTransient, runningStart, type ProcessRecord } from '../machine-local';
import { linkedComponent, readCheckoutText } from '../safe-write';
import { removeControlFiles } from '../surfaces/start/control';
import { openTracker, TRACKER_REF, type SyncOutcome, type TextPolicy, type TrackerStore, type TrackerView } from '../tracker';
import { registeredWorktrees } from './worktrees';

/** What the person types to confirm. */
export const LEAVE_CONFIRMATION = 'leave';

/** The purge of unpushed excerpt text: every session record's text goes, whatever the mode. */
const PURGE_TEXT: TextPolicy = { forbidsText: () => true, stripText: stripExcerptText };

/** How long the cut of every uncut context may take, all told. */
const CUT_BUDGET_MS = 30_000;

export interface LeavePrompter {
  /** Asks one question at the terminal; null when the person closed the prompt. */
  ask(question: string): Promise<string | null>;
}

export interface LeaveOptions {
  /** Any checkout of the clone. */
  readonly root: string;
  /** The person's call context (the CLI at a terminal): the writes leave makes are theirs. */
  readonly ctx: CallContext;
  readonly prompter: LeavePrompter;
  /** Lines the person reads (the plan, the offers' lists). */
  readonly say: (text: string) => void;
  /** Where the control channel's folders are found (default: this process's). */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the cuts find transcripts (default: the clients' own folders). */
  readonly capture?: CaptureOptions;
  /** How long the cut of every uncut context may take, all told (default 30 s). */
  readonly cutBudgetMs?: number;
  /** Runs between the removal and its re-check (a test seam: a session that starts while leave removes). */
  readonly afterRemoval?: () => Promise<void>;
}

/** A live grimoire process that makes leave refuse. */
export interface LiveProcess {
  readonly pid: number;
  readonly role: string;
  readonly client: string | null;
  readonly worktree: string | null;
  readonly pin: string;
}

export interface LeaveReport {
  /** False when leave stopped before the removal: nothing was removed (what it committed to the tracker stays). */
  readonly left: boolean;
  /**
   * Why it stopped: to record stray edits or copy out folders moved aside
   * first; contexts the cut left uncut (the person stopped so a later leave
   * cuts them); or a grimoire process that started after the preflight.
   */
  readonly stopped?: 'stray-edits' | 'moved-aside' | 'uncut' | 'busy';
  /** With `stopped: 'busy'`: the live processes (empty when leave couldn't tell; see `problems`). */
  readonly processes?: LiveProcess[];
  /** Open attempts released as abandoned. */
  readonly released: { id: string; attempt: string }[];
  /** Contexts cut, the session records attached, and the contexts left uncut (over the cut's budget, or failed). */
  cut: { contexts: number; attached: number; uncut: number } | null;
  /** Unpushed commits written again without their excerpt text. */
  purged: number;
  /** The final sync: whether it pushed, and whether the remote holds the local tip. */
  sync: { state: SyncOutcome['state']; remote: string | null; pushed: boolean; reason?: string } | null;
  readonly removed: {
    /** Generated folders, by worktree (POSIX paths relative to it). */
    generated: { worktree: string; path: string }[];
    /** The machine-local store's folder, when it existed. */
    machine_local: string | null;
    copies: string[];
    launcher: boolean;
    git_config: string[];
    control: string[];
    /** The local tracker tip whose ref (and reflog) went. */
    tracker_ref: string | null;
  };
  readonly kept: {
    /** Generated folders leave didn't touch, and why. */
    generated: { worktree: string; path: string; why: string }[];
    /** The local tracker ref, kept because the remote doesn't hold its tip; `command` deletes it. */
    tracker_ref: { tip: string; why: string; command: string } | null;
  };
  /** Stray edits listed by the preflight (saved ones by id). */
  readonly stray_edits: { id: string | null; skill: string; worktree: string; path: string }[];
  readonly warnings: string[];
  /** Steps that failed; leave may be run again. */
  readonly problems: string[];
}

function yes(answer: string | null, byDefault = false): boolean {
  if (answer === null) return false;
  const text = answer.trim().toLowerCase();
  if (text === '') return byDefault;
  return text === 'y' || text === 'yes';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the liveness check found: the live processes, or what it couldn't read (so it can't tell). */
type ProcessCheck = { readonly live: LiveProcess[]; readonly unreadable: null } | { readonly live: null; readonly unreadable: string };

function errorCodeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * The live processes that make leave refuse, by client, worktree and pid. It
 * fails closed: a process record or `start` lock it can't read is named
 * instead, since leave can't tell whether its process still runs.
 */
async function checkProcesses(store: MachineLocalStore): Promise<ProcessCheck> {
  const unreadable = (what: string, error: unknown): ProcessCheck => ({ live: null, unreadable: `${what} (${messageOf(error)})` });
  const dir = path.join(store.dir, 'processes');
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    // No store, or no records yet: nothing runs.
    if (errorCodeOf(error) !== 'ENOENT' && errorCodeOf(error) !== 'ENOTDIR') return unreadable(dir, error);
  }
  for (const name of names.sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    try {
      await readTextIfExists(path.join(dir, name));
    } catch (error) {
      return unreadable(path.join(dir, name), error);
    }
  }
  let records: ProcessRecord[];
  try {
    records = await store.processes.live();
  } catch (error) {
    return unreadable(`the process records in ${dir}`, error);
  }
  const live: LiveProcess[] = records
    .filter((record) => !(record.pid === process.pid && record.host === store.host))
    .map(({ pid, role, client, worktree, pin }) => ({ pid, role, client, worktree, pin }));
  let start: Awaited<ReturnType<typeof runningStart>>;
  try {
    start = await runningStart(store);
  } catch (error) {
    return unreadable('the `start` lock', error);
  }
  if (start && !live.some((entry) => entry.pid === start.pid)) live.push({ pid: start.pid, role: 'start', client: null, worktree: null, pin: '?' });
  return { live, unreadable: null };
}

function describeProcess(entry: LiveProcess): string {
  return `${entry.client ?? 'grimoire'} ${entry.role} (pid ${entry.pid}${entry.worktree ? `, ${entry.worktree}` : ''})`;
}

/** Why leave can't go on (`after`: what that means at this point), or null when nothing runs. */
function busyText(check: ProcessCheck, after: string): string | null {
  if (check.live === null) {
    return `grimoire can’t tell whether grimoire processes run in this clone: it can’t read ${check.unreadable}, so it won’t remove the store under them. Make that readable (or remove it once no grimoire process runs), then run leave again; ${after}`;
  }
  if (check.live.length === 0) return null;
  return `grimoire processes still run in this clone: ${check.live.map(describeProcess).join('; ')}. End those sessions (and stop \`grimoire start\`), then run leave again; ${after}`;
}

/** Throws BUSY while grimoire processes run in the clone, or when leave can't tell. */
async function refuseLive(store: MachineLocalStore): Promise<void> {
  const check = await checkProcesses(store);
  const busy = busyText(check, 'nothing changed');
  if (busy === null) return;
  throw new GrimoireError('BUSY', busy, check.live === null ? { unreadable: check.unreadable } : { processes: check.live.map((entry) => ({ ...entry })) });
}

/** An open attempt this machine's agents bound, held by the person. */
interface HeldHere {
  readonly id: string;
  readonly attempt: string;
  readonly title: string;
}

/** A copy that holds text grimoire never served, not yet set aside. */
interface UnsavedStray {
  readonly skill: string;
  readonly worktree: string;
  readonly path: string;
  readonly text: string;
}

interface Preflight {
  readonly tracker: TrackerStore;
  readonly view: TrackerView | null;
  readonly localTip: string | null;
  readonly held: HeldHere[];
  /** Seen-here rows of open attempts. */
  readonly uncut: SeenHereRow[];
  readonly saved: Awaited<ReturnType<typeof listStrayEdits>>;
  readonly unsaved: UnsavedStray[];
  readonly served: ServedSet | null;
  readonly unpushed: { commits: number; withText: number } | null;
  readonly worktrees: string[];
  readonly installed: string[];
  /** Folders upkeep moved into the store earlier (someone's `grimoire-*` folders): they go with it. */
  readonly movedAside: string[];
  readonly warnings: string[];
}

async function localTipOf(root: string): Promise<string | null> {
  const run = await runGit(root, ['rev-parse', '--verify', '--quiet', TRACKER_REF]);
  return run.code === 0 ? run.stdout.toString('utf8').trim() : null;
}

/** Copies in `worktree` holding text the ledger never had for their skill (a copy git tracks loses nothing). */
async function unsavedStrays(worktree: string, served: ServedSet): Promise<UnsavedStray[]> {
  const found: UnsavedStray[] = [];
  const listed = await runGit(worktree, ['ls-files', '-z', '--', COPY_ROOT]);
  const tracked = new Set(listed.code === 0 ? listed.stdout.toString('utf8').split('\0').filter((file) => file !== '') : []);
  for (const { folder, skill, kind } of await existingFolders(worktree)) {
    if (kind.kind !== 'copy') continue;
    const file = `${folder}/${SKILL_FILE}`;
    if (tracked.has(file)) continue;
    if ((await linkedComponent(worktree, file)) !== null) continue;
    const text = await readCheckoutText(path.join(worktree, ...file.split('/'))).catch(() => null);
    if (text?.state !== 'text') continue;
    if (served.known.get(skill)?.has(skillVersionOf(normalizeSkillText(text.text)))) continue;
    found.push({ skill, worktree, path: file, text: text.text });
  }
  return found;
}

async function preflight(root: string, commonDir: string, store: MachineLocalStore, ctx: CallContext): Promise<Preflight> {
  const warnings: string[] = [];
  const tracker = await openTracker(root);
  const localTip = await localTipOf(root);
  let view: TrackerView | null = null;
  const tips = await tracker.tips().catch(() => ({ local: null, remote: null }));
  if (tips.local !== null || tips.remote !== null) {
    try {
      view = await tracker.read();
    } catch (error) {
      warnings.push(`grimoire can't read this clone's tracker (${messageOf(error)}), so it can't offer to release attempts, cut contexts or check stray edits`);
    }
  }
  const { worktrees, unreachable } = await registeredWorktrees(commonDir);
  for (const away of unreachable) warnings.push(`${away} is registered but can't be reached now: its generated output stays`);

  const email = ctx.person.email?.toLowerCase() ?? null;
  const rows = (await store.coordination.list<SeenHereRow>(SEEN_HERE).catch(() => [])).map((entry) => entry.value).filter((row) => typeof row?.handle === 'string');
  const held: HeldHere[] = [];
  const uncut: SeenHereRow[] = [];
  if (view) {
    for (const row of rows) {
      const attempt = view.attempt(row.handle);
      if (!attempt || attempt.end !== null) continue;
      uncut.push(row);
      if (email === null || attempt.start.assignee.toLowerCase() !== email || held.some((entry) => entry.attempt === attempt.id)) continue;
      held.push({ id: attempt.issue, attempt: attempt.id, title: view.issue(attempt.issue)?.title ?? '' });
    }
  }

  const saved = await listStrayEdits(store).catch(() => []);
  let served: ServedSet | null = null;
  const unsaved: UnsavedStray[] = [];
  if (view) {
    try {
      served = await servedSetOf(view);
      for (const worktree of worktrees) unsaved.push(...(await unsavedStrays(worktree, served)));
    } catch (error) {
      warnings.push(`grimoire couldn't compare the generated copies with the served text (${messageOf(error)})`);
    }
  }

  const unpushed = localTip === null ? null : await tracker.unpushed(PURGE_TEXT).catch(() => null);
  const installed: string[] = [];
  for (const worktree of worktrees) {
    if (await readCheckoutConfig(worktree).then((config) => config !== null, () => true)) installed.push(worktree);
  }
  const asideDir = path.join(store.dir, MOVED_ASIDE);
  const movedAside = (await readdir(asideDir).catch(() => [] as string[])).sort().map((name) => path.join(asideDir, name));
  return { tracker, view, localTip, held, uncut, saved, unsaved, served, unpushed, worktrees, installed, movedAside, warnings };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Runs leave in the clone `options.root` is a checkout of. Throws BUSY while
 * grimoire processes run in it (or it can't tell), and INVALID when the typed
 * confirmation doesn't match; both before anything changed. Once the accepted
 * offers have committed, a stop is a report (`left: false`), never an error.
 */
export async function runLeave(options: LeaveOptions): Promise<LeaveReport> {
  const { ctx, prompter, say } = options;
  const env = options.env ?? process.env;
  const dirs = await findGitDirs(options.root);
  if (!dirs) throw new GrimoireError('NO_REPO', `${options.root} is not inside a git checkout`, { root: options.root });
  const { commonDir } = dirs;
  const root = dirs.worktree;
  const store = new MachineLocalStore(commonDir);
  await refuseLive(store);

  const pre = await preflight(root, commonDir, store, ctx);
  const report: LeaveReport = {
    left: false,
    released: [],
    cut: null,
    purged: 0,
    sync: null,
    removed: { generated: [], machine_local: null, copies: [], launcher: false, git_config: [], control: [], tracker_ref: null },
    kept: { generated: [], tracker_ref: null },
    stray_edits: [
      ...pre.saved.map((edit) => ({ id: edit.id, skill: edit.skill, worktree: edit.worktree, path: edit.path })),
      ...pre.unsaved.map((edit) => ({ id: null, skill: edit.skill, worktree: edit.worktree, path: edit.path })),
    ],
    warnings: [...pre.warnings],
    problems: [],
  };
  try {
    // The plan.
    say(`grimoire leave removes grimoire from this clone on this machine (${commonDir}):`);
    say(`  generated skill copies and stubs in ${plural(pre.worktrees.length, 'registered worktree')}: ${pre.worktrees.join(', ')}`);
    say(`  the machine-local store ${store.dir}, with its version copies and launcher`);
    say('  the clone’s grimoire.* git config keys, and the control channel’s secret and sockets');
    say(`  ${TRACKER_REF} and its reflog, but only once the remote holds its tip`);
    say('It never changes the host repo, its tracker branch, the remote-tracking ref or your user-level client files.');

    // First what would stop leave, then the offers: each answer is acted on only after the confirmation.
    if (report.stray_edits.length > 0) {
      say(`Stray edits to generated copies (${report.stray_edits.length}); leaving loses them:`);
      for (const edit of report.stray_edits) say(`  ${edit.skill} in ${edit.worktree} (${edit.path})${edit.id ? `: ${edit.id}` : ''}`);
      if (yes(await prompter.ask('Stop now so you can record them first? [y/N] '))) {
        const ids = await saveStrays(store, pre, report);
        say('Nothing was removed. Record each stray edit you want to keep, then run leave again:');
        for (const id of ids) say(`  grimoire skill record ${id}`);
        return { ...report, stopped: 'stray-edits' };
      }
    }
    if (pre.movedAside.length > 0) {
      say(`Folders grimoire moved aside earlier (they held no grimoire output) are kept in the store, and go with it:`);
      for (const dir of pre.movedAside) say(`  ${dir}`);
      if (yes(await prompter.ask('Stop now so you can copy them out first? [y/N] '))) {
        say('Nothing was removed. Copy out what you want to keep, then run leave again.');
        return { ...report, stopped: 'moved-aside' };
      }
    }
    let release = false;
    if (pre.held.length > 0) {
      say(`Open attempts held from this machine (${pre.held.length}):`);
      for (const entry of pre.held) say(`  ${entry.id} ${entry.attempt}${entry.title ? `: ${entry.title}` : ''}`);
      release = yes(await prompter.ask('Release them as abandoned before leaving? [y/N] '));
    }
    const releasing = new Set(release ? pre.held.map((entry) => entry.attempt) : []);
    const uncut = pre.uncut.filter((row) => !releasing.has(row.handle));
    let cut = false;
    if (uncut.length > 0 && pre.view) {
      const mode = storeExcerptMode(pre.view);
      cut = yes(await prompter.ask(`Cut the ${plural(uncut.length, 'bound context')} still uncut and attach their session records (excerpt mode ${mode})? [Y/n] `), true);
    }
    let push = false;
    let purge = false;
    const unpushed = pre.unpushed?.commits ?? 0;
    // Releasing and cutting commit too: what they write is unpushed as well.
    const writes = release || cut;
    const more = writes ? (unpushed > 0 ? ', plus what releasing and cutting write' : 'what releasing and cutting write') : '';
    const what = `${unpushed > 0 ? plural(unpushed, 'unpushed tracker commit') : ''}${more}`;
    if ((unpushed > 0 || writes) && pre.view && autoSyncOn(pre.view)) {
      push = true;
      say(`Auto-sync is on: leave pushes ${what} first.`);
    } else if (unpushed > 0 || writes) {
      push = yes(await prompter.ask(`Push ${what} before leaving? [y/N] `));
      if (!push) say('The local tracker ref keeps what isn’t pushed: leave keeps the ref and prints the command that deletes it.');
    }
    const withText = pre.unpushed?.withText ?? 0;
    const cutText = writes && pre.view !== null && storeExcerptMode(pre.view) === 'excerpts';
    if (push && (withText > 0 || cutText)) {
      const now = withText > 0 ? `${plural(withText, 'unpushed commit')} ${withText === 1 ? 'carries' : 'carry'} excerpt text${cutText ? ', and the cut may add more' : ''}` : 'The cut may attach excerpt text';
      purge = yes(await prompter.ask(`${now}. Purge the unpushed excerpt text before the push? [y/N] `));
    }
    if (pre.localTip !== null && !push) say('Pushed excerpts stay in the remote’s history.');

    const answer = await prompter.ask(`grimoire leave is a human-only operation. Type ${LEAVE_CONFIRMATION} to confirm (anything else cancels): `);
    if (answer === null || answer.trim() !== LEAVE_CONFIRMATION) {
      throw new GrimoireError('INVALID', `leave was not confirmed: type ${LEAVE_CONFIRMATION} exactly to run it; nothing changed`, {
        fields: { confirmation: `must be ${LEAVE_CONFIRMATION}` },
      });
    }

    // The accepted offers.
    if (release || cut) await settleAttempts(options, pre, store, report, { release, cut, contexts: uncut.length });
    const left = report.cut?.uncut ?? 0;
    if (left > 0) {
      // Their seen-here rows go with the store, and no later sweep would cut them.
      const them = left === 1 ? 'it' : 'them';
      say(`${plural(left, 'bound context')} ${left === 1 ? 'wasn’t' : 'weren’t'} cut (over the cut’s time budget, or the cut failed); leaving now loses ${left === 1 ? 'its' : 'their'} session records.`);
      const answer = await prompter.ask(`Stop now, so you can run leave again to cut ${them}? [Y/n] `);
      if (answer === null || yes(answer, true)) {
        say('Nothing was removed. What leave committed stays in the local tracker ref; run leave again to cut the rest and push.');
        return { ...report, stopped: 'uncut' };
      }
      report.warnings.push(`${plural(left, 'bound context')} ${left === 1 ? 'wasn’t' : 'weren’t'} cut: ${left === 1 ? 'its' : 'their'} session records are lost`);
    }
    if (purge) {
      try {
        report.purged = await pre.tracker.stripUnpushedText(PURGE_TEXT);
      } catch (error) {
        report.problems.push(`purging the unpushed excerpt text failed: ${messageOf(error)}`);
      }
    }
    const outcome = await finalSync(pre.tracker, ctx, push, report);
    await pre.tracker.close();

    // A process may have started since the preflight. What leave committed stays, so this is a report, not an error.
    const late = await checkProcesses(store);
    const busy = busyText(late, 'nothing was removed; what leave committed and pushed is in this report');
    if (busy !== null) {
      report.problems.push(busy);
      return { ...report, stopped: 'busy', processes: late.live ?? [] };
    }
    await removeAll(store, commonDir, root, pre.worktrees, env, outcome, report);
    await options.afterRemoval?.();
    // Nothing stops a session started meanwhile (older pins' processes honour no marker): say what came back.
    await reportReturns(store, pre.worktrees, report);
  } finally {
    await pre.tracker.close().catch(() => {});
  }

  for (const worktree of pre.installed) {
    report.warnings.push(`${worktree} still pins grimoire (.grimoire/config.yml): its agent sessions will show the not-set-up notice until grimoire is uninstalled there or you join again`);
  }
  report.warnings.push('If you made a login item that runs `grimoire start`, remove it.');
  return { ...report, left: true };
}

/** Sets aside every unsaved stray edit, so `skill record` can take it; the ids of all of them. */
async function saveStrays(store: MachineLocalStore, pre: Preflight, report: LeaveReport): Promise<string[]> {
  const ids = pre.saved.map((edit) => edit.id);
  for (const edit of pre.unsaved) {
    const served = pre.served?.skills.find((skill) => skill.name === edit.skill)?.version ?? null;
    try {
      const saved = await setAsideStrayEdit(store, { skill: edit.skill, worktree: edit.worktree, path: edit.path, text: edit.text, base: null, served });
      ids.push(saved.id);
    } catch (error) {
      report.problems.push(`grimoire couldn't save the stray edit to ${edit.path} in ${edit.worktree}: ${messageOf(error)}`);
    }
  }
  return ids;
}

/** Releases the held attempts and cuts the rest's uncut contexts, as accepted. */
async function settleAttempts(
  options: LeaveOptions,
  pre: Preflight,
  store: MachineLocalStore,
  report: LeaveReport,
  accepted: { release: boolean; cut: boolean; contexts: number },
): Promise<void> {
  const core = createCore({ autoSync: 'off', refreshSkills: 'off', ...(options.capture ? { capture: options.capture } : {}) });
  try {
    if (accepted.release) {
      for (const entry of pre.held) {
        const done = await core.call('release', { id: entry.id, attempt: entry.attempt, abandoned: true }, options.ctx);
        if (done.ok) report.released.push({ id: entry.id, attempt: entry.attempt });
        else report.problems.push(`releasing ${entry.attempt} on ${entry.id} failed: ${done.error.message}`);
      }
    }
  } finally {
    await core.close();
  }
  if (!accepted.cut) return;
  try {
    const swept = await sweepContexts(pre.tracker, store, async () => options.ctx, {
      idleMs: 0,
      sync: false,
      budgetMs: options.cutBudgetMs ?? CUT_BUDGET_MS,
      ...(options.capture ? { capture: options.capture } : {}),
    });
    // A cancelled sweep committed nothing; a context the budget overtook keeps its row, uncut.
    report.cut = swept.cancelled
      ? { contexts: 0, attached: 0, uncut: accepted.contexts }
      : { contexts: swept.cut - swept.budget, attached: swept.attached, uncut: swept.budget };
  } catch (error) {
    report.problems.push(`cutting the uncut contexts failed: ${messageOf(error)}`);
    report.cut = { contexts: 0, attached: 0, uncut: accepted.contexts };
  }
}

/** The final sync: a push when allowed, else a fetch only. Null when there is no local tracker, or it failed. */
async function finalSync(tracker: TrackerStore, ctx: CallContext, push: boolean, report: LeaveReport): Promise<SyncOutcome | null> {
  if ((await localTipOf(tracker.location.root)) === null) return null;
  try {
    const outcome = push
      ? await syncNow(tracker, syncRequestOf(ctx, actorOf(ctx)))
      : await tracker.sync({ author: null, actor: actorOf(ctx), timeoutMs: EXPLICIT_STEP_TIMEOUT_MS, fetchOnly: true });
    report.sync = {
      state: outcome.state,
      remote: outcome.remote,
      pushed: outcome.state === 'pushed',
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    if (outcome.failure) report.problems.push(`the final sync failed: ${outcome.failure.message}`);
    return outcome;
  } catch (error) {
    report.problems.push(`the final sync failed: ${messageOf(error)}`);
    return null;
  }
}

async function removeAll(
  store: MachineLocalStore,
  commonDir: string,
  root: string,
  worktrees: readonly string[],
  env: NodeJS.ProcessEnv,
  outcome: SyncOutcome | null,
  report: LeaveReport,
): Promise<void> {
  const listed = await readPathList(store).catch(() => [] as string[]);
  for (const worktree of worktrees) {
    try {
      await removeGenerated(worktree, listed, report);
    } catch (error) {
      report.problems.push(`removing the generated output in ${worktree} failed: ${messageOf(error)}`);
    }
  }
  try {
    await removeMachineLocal(store, report);
  } catch (error) {
    report.problems.push(`removing the machine-local store ${store.dir} failed: ${messageOf(error)}`);
  }
  try {
    report.removed.git_config.push(...(await removeGitConfig(commonDir)));
  } catch (error) {
    report.problems.push(`removing the grimoire.* git config keys failed: ${messageOf(error)}`);
  }
  try {
    report.removed.control.push(...(await removeControlFiles(await cloneId(commonDir), env)));
  } catch (error) {
    report.problems.push(`removing the control channel’s files failed: ${messageOf(error)}`);
  }
  await removeTrackerRef(root, outcome, report);
}

/** Reports what came back after the removal: the store (with who runs from it now) and generated folders. */
async function reportReturns(store: MachineLocalStore, worktrees: readonly string[], report: LeaveReport): Promise<void> {
  if (await lstat(store.dir).then(() => true, () => false)) {
    const check = await checkProcesses(store);
    const who = check.live !== null && check.live.length > 0 ? ` (${check.live.map(describeProcess).join('; ')})` : '';
    report.problems.push(`${store.dir} came back while leave ran: a grimoire process started in this clone during leave${who}. End it, then run leave again`);
  }
  for (const worktree of worktrees) {
    const kept = new Set(report.kept.generated.filter((entry) => entry.worktree === worktree).map((entry) => entry.path));
    const back = (await existingFolders(worktree).catch(() => [])).map((entry) => entry.folder).filter((folder) => !kept.has(folder));
    if (back.length > 0) {
      report.problems.push(`generated output came back in ${worktree}: ${back.join(', ')}. A grimoire session started there during leave: end it, then run leave again`);
    }
  }
}

/** A generated folder's shape (`.grimoire/skills/<name>`, `<stub root>/grimoire-<name>`), POSIX and relative; null for anything else. */
function generatedShape(relative: string): string | null {
  const parts = relative.split('/');
  const name = parts.at(-1) ?? '';
  const parent = parts.slice(0, -1).join('/');
  if (name === '' || name === '.' || name === '..') return null;
  if (parent === COPY_ROOT) return relative;
  if (Object.values(STUB_ROOTS).includes(parent) && name.startsWith(STUB_PREFIX) && name.toLowerCase() !== `${STUB_PREFIX}chores`) return relative;
  return null;
}

/** Removes `worktree`'s generated folders: each one untracked, unlinked, carrying grimoire's `.gitignore` and nothing but grimoire's files. */
async function removeGenerated(worktree: string, listed: readonly string[], report: LeaveReport): Promise<void> {
  const folders = new Map<string, string>();
  const abs = (folder: string) => path.join(worktree, ...folder.split('/'));
  for (const { folder } of await existingFolders(worktree)) folders.set(comparablePath(abs(folder)), folder);
  const prefix = comparablePath(worktree) + path.sep;
  for (const entry of listed) {
    if (!comparablePath(entry).startsWith(prefix)) continue;
    const shape = generatedShape(path.relative(worktree, entry).split(path.sep).join('/'));
    if (shape !== null && !folders.has(comparablePath(abs(shape)))) folders.set(comparablePath(abs(shape)), shape);
  }
  if (folders.size === 0) return;
  const keep = (folder: string, why: string) => report.kept.generated.push({ worktree, path: folder, why });
  const tracked = await runGit(worktree, ['ls-files', '-z', '--', COPY_ROOT, ...Object.values(STUB_ROOTS)]);
  if (tracked.code !== 0) {
    for (const folder of folders.values()) keep(folder, `git can't say which paths it tracks here (${tracked.stderr.toString().trim()})`);
    return;
  }
  const trackedFiles = tracked.stdout.toString('utf8').split('\0').filter((file) => file !== '');
  for (const folder of [...folders.values()].sort()) {
    const linked = await linkedComponent(worktree, folder);
    if (linked !== null) {
      keep(folder, `${linked} is a symlink or junction; grimoire never removes through one`);
      continue;
    }
    const full = abs(folder);
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) {
      keep(folder, 'it is not a folder');
      continue;
    }
    const inside = comparablePath(full) + path.sep;
    const tracks = trackedFiles.filter((file) => comparablePath(abs(file)).startsWith(inside));
    if (tracks.length > 0) {
      keep(folder, `git tracks ${tracks.join(', ')}`);
      continue;
    }
    const ignore = await readCheckoutText(path.join(full, '.gitignore')).catch(() => null);
    const ignoreInfo = await lstat(path.join(full, '.gitignore')).catch(() => null);
    if (!ignoreInfo?.isFile() || ignore?.state !== 'text' || ignore.text !== GENERATED_GITIGNORE) {
      keep(folder, 'it doesn’t carry grimoire’s .gitignore');
      continue;
    }
    const entries = await readdir(full);
    const extra = entries.filter((name) => name !== SKILL_FILE && name !== '.gitignore');
    if (extra.length > 0) {
      keep(folder, `it holds files grimoire didn’t write (${extra.join(', ')})`);
      continue;
    }
    let plain = true;
    for (const name of entries) plain &&= (await lstat(path.join(full, name))).isFile();
    if (!plain) {
      keep(folder, 'it holds something other than files');
      continue;
    }
    try {
      if (entries.includes(SKILL_FILE)) await retryTransient(() => unlink(path.join(full, SKILL_FILE)));
      await retryTransient(() => unlink(path.join(full, '.gitignore')));
      await retryTransient(() => rmdir(full));
      report.removed.generated.push({ worktree, path: folder });
    } catch (error) {
      keep(folder, `grimoire couldn’t remove it (${messageOf(error)})`);
    }
  }
  // An emptied copy root goes, and an emptied dotfolder (a worktree that pins nothing); stub roots stay.
  for (const dir of [COPY_ROOT, '.grimoire']) {
    if ((await linkedComponent(worktree, dir)) === null) await rmdir(abs(dir)).catch(() => {});
  }
}

/** Removes the machine-local store: everything in it, then `pkg/`, then the launcher, then its folder. */
async function removeMachineLocal(store: MachineLocalStore, report: LeaveReport): Promise<void> {
  const info = await lstat(store.dir).catch(() => null);
  if (!info) return;
  const remove = (target: string) => rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!info.isDirectory()) {
    // A link (or a stray file) in the store's place: only the link itself goes.
    await retryTransient(() => unlink(store.dir));
    report.removed.machine_local = store.dir;
    return;
  }
  const pkg = path.join(store.dir, 'pkg');
  const launcher = path.join(store.dir, 'launcher.cjs');
  const copies = (await readdir(pkg).catch(() => [] as string[])).filter((name) => !name.startsWith('.')).sort();
  for (const name of await readdir(store.dir)) {
    if (name === 'pkg' || name === 'launcher.cjs') continue;
    await remove(path.join(store.dir, name));
  }
  await remove(pkg);
  report.removed.copies.push(...copies);
  if (await lstat(launcher).then(() => true, () => false)) {
    await remove(launcher);
    report.removed.launcher = true;
  }
  await remove(store.dir);
  report.removed.machine_local = store.dir;
}

/** Removes every `grimoire.*` key from the clone's own git config; returns the keys. */
async function removeGitConfig(commonDir: string): Promise<string[]> {
  const file = path.join(commonDir, 'config');
  const keysNow = async (): Promise<string[]> => {
    const run = await runGit(commonDir, ['config', '--file', file, '-z', '--name-only', '--get-regexp', '^grimoire\\.']);
    // Exit 1: no such key.
    if (run.code === 1) return [];
    if (run.code !== 0) throw new Error(`git config failed: ${run.stderr.toString().trim()}`);
    return [...new Set(run.stdout.toString('utf8').split('\0').filter((key) => key !== ''))];
  };
  const keys = await keysNow();
  const sections = new Set(keys.map((key) => key.slice(0, key.lastIndexOf('.'))));
  for (const section of sections) await runGit(commonDir, ['config', '--file', file, '--remove-section', section]);
  for (const key of await keysNow()) {
    const run = await runGit(commonDir, ['config', '--file', file, '--unset-all', key]);
    if (run.code !== 0) throw new Error(`git config --unset-all ${key} failed: ${run.stderr.toString().trim()}`);
  }
  return keys;
}

/** Deletes the local tracker ref and its reflog when the final sync showed the remote holds its tip; else keeps it, with the command. */
async function removeTrackerRef(root: string, outcome: SyncOutcome | null, report: LeaveReport): Promise<void> {
  const tip = await localTipOf(root);
  if (tip === null) return;
  const command = `git update-ref -d ${TRACKER_REF}`;
  const keep = (why: string) => {
    report.kept.tracker_ref = { tip, why, command };
  };
  if (outcome === null || outcome.state === 'pending') {
    keep(
      outcome?.reason === 'no-remote'
        ? 'this clone has no remote to hold it'
        : outcome === null || outcome.failure
          ? 'the final sync couldn’t show that the remote holds its tip'
          : 'the remote doesn’t hold its tip: it has unpushed commits',
    );
    return;
  }
  if (outcome.local !== tip) {
    keep('it moved after the final sync');
    return;
  }
  // A compare-and-set: the ref goes only if it still holds the tip the remote holds. Its reflog goes with it.
  const run = await runGit(root, ['update-ref', '-d', TRACKER_REF, tip]);
  if (run.code !== 0) {
    keep(`git update-ref -d failed: ${run.stderr.toString().trim()}`);
    return;
  }
  report.removed.tracker_ref = tip;
}
