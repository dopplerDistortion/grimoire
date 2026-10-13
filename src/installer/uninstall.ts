// Uninstall (spec §21 Uninstall; glossary: Uninstall): a person removes
// grimoire from a host repo through one checkout, for them to commit like any
// change. The remote tracker is never deleted: it stays as an archive a later
// first install adopts.
//
// 1. Refusals, before anything is read or asked beyond them: a merge, rebase,
//    cherry-pick, revert or bisect in progress; a checkout grimoire isn't
//    installed in; a manifest kind this release doesn't know (naming a
//    release that does); live grimoire processes (in the clone when the
//    uninstall also leaves it, else in this checkout). The gate (agent
//    markers, a terminal, no --yes) is the CLI's (../surfaces/cli/uninstall.ts).
// 2. A read-only preflight: fetch the tracker and fold in memory; the plan of
//    the checkout's removal (./removal.ts), with drift, what stays and what
//    mentions grimoire outside the manifest; the Codex hook groups whose
//    positions shift; the active evolved skills, with an offer to eject them.
//    When no other registered worktree is still installed, uninstall leaves
//    the clone too (./leave.ts), and leave's preflight and offers follow.
//    Otherwise: the open attempts held from this machine (advise releasing),
//    the stray edits (they will be lost), and the unpushed tracker commits
//    and those carrying excerpt text (offer to purge; push under auto-sync or
//    an explicit yes). Pushed excerpts stay in the tracker branch's history.
// 3. One typed confirmation. Nothing changes, and nothing is pushed, before it.
// 4. The accepted ejects, purge and push; a last liveness check; then the
//    removal, holding the (store, worktree) lease so upkeep keeps off; then
//    leave's removal, when it applies and the checkout's removal completed.
// 5. The report: what went and what stayed, the commit to make (with text
//    telling teammates to run `npx @goksening/grimoire leave`), and the
//    commands that delete the remote tracker or keep it under a tag.
import { lstat } from 'node:fs/promises';
import { actorOf, type CallContext } from '../core/context';
import { createCore, type CaptureOptions } from '../core';
import { autoSyncOn, EXPLICIT_STEP_TIMEOUT_MS } from '../core/sync';
import { upgradeRequiredDetails } from '../core/upgrade';
import { GrimoireError } from '../errors';
import { comparablePath, readPathList, sharedScanner } from '../generated';
import { runGit } from '../git/run';
import { readSkills, type ServedSkill } from '../knowledge';
import { findGitDirs, MachineLocalStore } from '../machine-local';
import { openTracker } from '../tracker';
import { remoteTrackerRef } from '../tracker/layout';
import { holdWorktreeLease, operationInProgress } from '../upkeep';
import { VERSION } from '../version';
import { readInstallConfig } from './config';
import {
  busyText,
  checkProcesses,
  closeLeave,
  finalSync,
  messageOf,
  performLeave,
  plural,
  preflight,
  prepareLeave,
  PURGE_TEXT,
  saveStrays,
  yes,
  type LeaveOptions,
  type LeavePlan,
  type LeaveReport,
  type Preflight,
} from './leave';
import { MANIFEST_PATH, readManifest } from './manifest';
import { readRemotes } from './preflight';
import { planRemoval, removeCheckout, type CheckoutRemoval, type KeptItem, type Mention, type RemovalPlan, type RemovedEntry, type ShiftedGroup } from './removal';
import { compareSemver, isStrictSemver } from './semver';
import { registeredWorktrees } from './worktrees';

/** What the person types to confirm. */
export const UNINSTALL_CONFIRMATION = 'uninstall';

/** The commit's subject. */
export const UNINSTALL_SUBJECT = 'Uninstall grimoire';

/** The tag the archive command keeps the remote tracker under. */
const ARCHIVE_TAG = 'refs/tags/grimoire-tracker-archive';

export interface UninstallPrompter {
  /** Asks one question at the terminal; null when the person closed the prompt. */
  ask(question: string): Promise<string | null>;
}

export interface UninstallOptions {
  /** The checkout to uninstall from (any directory in it). */
  readonly root: string;
  /** The person's call context (the CLI at a terminal): the writes uninstall makes are theirs. */
  readonly ctx: CallContext;
  readonly prompter: UninstallPrompter;
  /** Lines the person reads (the plan, the offers' lists). */
  readonly say: (text: string) => void;
  /** Where the control channel's folders are found (default: this process's). */
  readonly env?: NodeJS.ProcessEnv;
  /** Where leave's cuts find transcripts (default: the clients' own folders). */
  readonly capture?: CaptureOptions;
  /** How long leave's cut of every uncut context may take, all told. */
  readonly cutBudgetMs?: number;
  /** Called after each file the removal changes; what it throws stops it there, as a crash would (a test seam). */
  readonly onRemovalStep?: (path: string) => Promise<void> | void;
}

export interface UninstallReport {
  /** True when everything grimoire wrote in the checkout is gone (or kept by rule). */
  readonly uninstalled: boolean;
  /** Why it stopped before the removal (nothing in the checkout changed), or `checkout` when the removal stopped part way: run it again. */
  readonly stopped?: 'stray-edits' | 'moved-aside' | 'uncut' | 'busy' | 'checkout';
  readonly root: string;
  /** Evolved skills ejected into this checkout as ordinary files. */
  readonly ejected: { name: string; version: string; files: string[] }[];
  /** Unpushed commits written again without their excerpt text (when this clone stays joined; else see `leave`). */
  purged: number;
  /** The push after the confirmation (when this clone stays joined; else see `leave`). */
  sync: LeaveReport['sync'];
  /** The checkout's removal; null when it didn't run. */
  checkout: CheckoutRemoval | null;
  /** Lines in grimoire's pointer files that mention grimoire outside the manifest: never touched. */
  readonly mentions: Mention[];
  /** Codex SessionStart groups whose positions shift, and what to tell people. */
  readonly codex: { readonly shifted: ShiftedGroup[]; readonly notice: string | null };
  /** The leave uninstall ran, when no other registered worktree is still installed. */
  leave: LeaveReport | null;
  /** The worktrees still installed (or that can't be reached), when uninstall doesn't leave the clone. */
  readonly still_installed: string[];
  /** The remote tracker, never deleted: the commands that delete it, or keep it under a tag. */
  readonly tracker: { readonly remote: string | null; readonly delete: string | null; readonly archive: string | null };
  /** What to commit: the paths, the command, the message and the PR text. */
  commit: { paths: string[]; command: string; message: string; pr: string } | null;
  readonly warnings: string[];
  readonly problems: string[];
}

/** The worktree `dir` names, compared the way the file system does. */
function same(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/** Whether grimoire is installed in the checkout at `root` (a config.yml or a manifest; a crashed uninstall leaves the manifest). */
async function installedAt(root: string): Promise<boolean> {
  if ((await readInstallConfig(root).catch(() => null)) !== null) return true;
  return (await readManifest(root).catch(() => ({ exists: true }))).exists;
}

/** The release to name for a manifest this one can't read. */
function capableRelease(pin: string | null): string {
  return pin !== null && isStrictSemver(pin) && compareSemver(pin, VERSION) > 0 ? pin : 'latest';
}

/** Throws BUSY while grimoire processes run in the clone (`here` null) or in the checkout `here`, or when it can't tell. */
async function refuseLive(store: MachineLocalStore, here: string | null, after: string): Promise<void> {
  const check = await checkProcesses(store);
  const scoped = check.live === null || here === null ? check : { live: check.live.filter((entry) => entry.worktree !== null && same(entry.worktree, here)), unreadable: null };
  const busy = busyText(scoped, after, { verb: 'uninstall', where: here === null ? 'this clone' : 'this checkout' });
  if (busy === null) return;
  throw new GrimoireError('BUSY', busy, scoped.live === null ? { unreadable: scoped.unreadable } : { processes: scoped.live.map((entry) => ({ ...entry })) });
}

/** The evolved skills agents are served now: what eject could keep. */
async function activeSkills(root: string, warnings: string[]): Promise<ServedSkill[]> {
  const tracker = await openTracker(root);
  try {
    const tips = await tracker.tips().catch(() => ({ local: null, remote: null }));
    if (tips.local === null && tips.remote === null) return [];
    return [...(await readSkills(await tracker.read(), sharedScanner())).served];
  } catch (error) {
    warnings.push(`grimoire can't read this clone's tracker (${messageOf(error)}), so it can't offer to eject evolved skills`);
    return [];
  } finally {
    await tracker.close().catch(() => {});
  }
}

/** Fetches the tracker so the preflight folds the remote's latest in memory. Writes nothing but the remote-tracking ref. */
async function fetchTracker(root: string, ctx: CallContext, warnings: string[]): Promise<void> {
  const tracker = await openTracker(root);
  try {
    const outcome = await tracker.sync({ author: null, actor: actorOf(ctx), timeoutMs: EXPLICIT_STEP_TIMEOUT_MS, fetchOnly: true });
    if (outcome.failure) warnings.push(`grimoire couldn't fetch the tracker (${outcome.failure.message}): what is listed may miss the remote's latest`);
  } catch (error) {
    warnings.push(`grimoire couldn't fetch the tracker (${messageOf(error)}): what is listed may miss the remote's latest`);
  } finally {
    await tracker.close().catch(() => {});
  }
}

/** The remote the tracker goes to: `grimoire.remote`, else `origin`, else the only remote. */
async function trackerRemote(root: string): Promise<string | null> {
  const remotes = await readRemotes(root).catch(() => null);
  if (!remotes) return null;
  if (remotes.chosen !== null) return remotes.chosen;
  if (remotes.names.includes('origin')) return 'origin';
  return remotes.names.length === 1 ? remotes.names[0]! : null;
}

/**
 * The commands that keep the remote tracker under a tag, then delete the
 * branch. Run whenever the person likes, so: fetch first (the tag holds what
 * teammates pushed since uninstall), and delete with a lease on that fetch
 * (a push after it makes the delete fail, never lost untagged).
 */
function archiveCommand(remote: string): string {
  const tracking = remoteTrackerRef(remote);
  return [
    `git fetch ${remote} +refs/heads/grimoire/tracker:${tracking}`,
    `git push ${remote} ${tracking}:${ARCHIVE_TAG}`,
    `git push ${remote} --force-with-lease=refs/heads/grimoire/tracker:${tracking} --delete grimoire/tracker`,
  ].join(' && ');
}

function describeEntry(entry: RemovedEntry): string {
  const what = entry.hook !== undefined ? `its ${entry.hook} hook group` : entry.item !== undefined ? `“${entry.item}” in ${entry.key?.join('.')}` : entry.marker !== undefined ? 'its block' : entry.key ? entry.key.join('.') : 'the file';
  return `${entry.path}: ${what}${entry.drift ? ' (edited since grimoire wrote it)' : ''}`;
}

function sayPlan(say: (text: string) => void, root: string, plan: RemovalPlan): void {
  say(`grimoire uninstall removes grimoire from this repo through this checkout (${root}), for you to commit:`);
  const deleted = new Set(plan.changes.filter((change) => change.after === null).map((change) => change.path));
  for (const entry of plan.removed) say(`  ${deleted.has(entry.path) && (entry.kind === 'file' || entry.kind === 'seeded-file') ? `delete ${entry.path}${entry.drift ? ' (edited since grimoire wrote it)' : ''}` : `remove ${describeEntry(entry)}`}`);
  for (const relative of deleted) if (!plan.removed.some((entry) => entry.path === relative && (entry.kind === 'file' || entry.kind === 'seeded-file'))) say(`  delete ${relative}: grimoire created it, and nothing else is left in it`);
  say(`  then .grimoire/config.yml, this checkout's generated skill copies and stubs, ${MANIFEST_PATH} last, and .grimoire/ if nothing else is in it`);
  for (const item of plan.kept) say(`  keep ${item.path}: ${item.why}`);
  for (const problem of plan.problems) say(`  can't change ${problem}`);
  if (plan.mentions.length > 0) {
    say('These lines mention grimoire, but grimoire’s manifest doesn’t record them, so they stay as they are:');
    for (const mention of plan.mentions) say(`  ${mention.path}:${mention.line}: ${mention.text}`);
  }
  say('The tracker branch grimoire/tracker stays on the remote as an archive: uninstall never deletes it.');
}

function codexNotice(shifted: readonly ShiftedGroup[]): string | null {
  if (shifted.length === 0) return null;
  const groups = shifted.map((group) => `#${group.from} → #${group.to}${group.command ? ` (${group.command})` : ''}`).join('; ');
  return `Removing grimoire’s hook group moves ${plural(shifted.length, 'Codex SessionStart group')} after it in .codex/config.toml up one position: ${groups}. Codex keys hook approval by position, so each person approves ${shifted.length === 1 ? 'it' : 'them'} again in Codex’s /hooks, once per clone of this repo.`;
}

/** What the person commits: the paths of the checkout's removal git tracks, and the ejected skills' new files. */
async function pathsToCommit(root: string, removal: CheckoutRemoval, ejected: UninstallReport['ejected']): Promise<string[]> {
  const changed = [...new Set([...removal.edited, ...removal.deleted])];
  let tracked = changed;
  if (changed.length > 0) {
    const run = await runGit(root, ['ls-files', '-z', '--', ...changed]);
    if (run.code === 0) {
      const known = new Set(run.stdout.toString('utf8').split('\0').filter((file) => file !== ''));
      tracked = changed.filter((file) => known.has(file));
    }
  }
  return [...new Set([...tracked, ...ejected.flatMap((skill) => skill.files)])].sort();
}

function commitOf(paths: string[], ejected: UninstallReport['ejected']): UninstallReport['commit'] {
  const teammates = 'Teammates: run `npx @goksening/grimoire leave` in your clone to remove grimoire from your machine. Until then, the skill files grimoire generated there tell agents to ignore them.';
  const archive = 'The tracker branch grimoire/tracker stays on the remote as an archive; a later install adopts it.';
  const kept = ejected.length === 0 ? '' : ` Keeps the evolved ${ejected.length === 1 ? 'skill' : 'skills'} ${ejected.map((skill) => skill.name).join(', ')} as ordinary skills (.claude/skills/ and .agents/skills/).`;
  return {
    paths,
    command: paths.length === 0 ? '' : `git add -A -- ${paths.join(' ')} && git commit -m "${UNINSTALL_SUBJECT}"`,
    message: `${UNINSTALL_SUBJECT}\n\nRemoves grimoire's files and entries from this repo.${kept} ${archive}\n\n${teammates}\n`,
    pr: `Removes grimoire from this repo: its pointer files, the entries it added to shared files, and .grimoire/.${kept} ${archive}\n\n${teammates}\n`,
  };
}

/**
 * Runs uninstall in the checkout `options.root` is in. Throws (before
 * anything changed) INVALID while a git operation is in progress, when
 * grimoire isn't installed here, or when the typed confirmation doesn't
 * match; UPGRADE_REQUIRED for a manifest kind this release doesn't know; BUSY
 * while grimoire processes run. Once the confirmation is given, what goes
 * wrong is a report (`problems`), never an error.
 */
export async function runUninstall(options: UninstallOptions): Promise<UninstallReport> {
  const { ctx, prompter, say } = options;
  const dirs = await findGitDirs(options.root);
  if (!dirs) throw new GrimoireError('NO_REPO', `${options.root} is not inside a git checkout`, { root: options.root });
  const { commonDir } = dirs;
  const root = dirs.worktree;

  // The refusals: nothing has been asked, nothing changes.
  const operation = await operationInProgress(root);
  if (operation) throw new GrimoireError('INVALID', `uninstall doesn't run while a ${operation} is in progress in ${root}: finish or abort it first; nothing changed`, { operation });
  const config = await readInstallConfig(root).catch(() => null);
  const plan = await planRemoval(root);
  if (!plan.manifest && config === null) {
    throw new GrimoireError('INVALID', `grimoire isn't installed in ${root} (no .grimoire/config.yml or ${MANIFEST_PATH}); nothing changed`, { root });
  }
  if (plan.unknown.length > 0) {
    const release = capableRelease(config?.version ?? null);
    const command = `npx @goksening/grimoire@${release} uninstall`;
    // The manifest is part of the install (spec §5, marker `install`): a newer release wrote what this one doesn't know.
    const details = await upgradeRequiredDetails(
      { marker: 'install', why: 'newer', requires: release === 'latest' ? null : release },
      { root, pin: config?.version ?? null, commonDir, verb: 'uninstall' },
    );
    throw new GrimoireError(
      'UPGRADE_REQUIRED',
      `${MANIFEST_PATH} names what grimoire ${VERSION} doesn't know (${plan.unknown.join(', ')}), so it removes nothing: run \`${command}\`, a release that knows it; nothing changed`,
      { ...details },
    );
  }
  const { worktrees, unreachable } = await registeredWorktrees(commonDir);
  const stillInstalled: string[] = [];
  for (const worktree of worktrees) if (!same(worktree, root) && (await installedAt(worktree))) stillInstalled.push(worktree);
  // A registered worktree that can't be reached may still be installed: leaving would strand it.
  stillInstalled.push(...unreachable);
  const leaving = stillInstalled.length === 0;
  const store = new MachineLocalStore(commonDir);
  await refuseLive(store, leaving ? null : root, 'nothing changed');

  const remote = await trackerRemote(root);
  const report: UninstallReport = {
    uninstalled: false,
    root,
    ejected: [],
    purged: 0,
    sync: null,
    checkout: null,
    mentions: [...plan.mentions],
    codex: { shifted: [...plan.codex], notice: codexNotice(plan.codex) },
    leave: null,
    still_installed: stillInstalled,
    tracker: {
      remote,
      delete: remote === null ? null : `git push ${remote} --delete grimoire/tracker`,
      archive: remote === null ? null : archiveCommand(remote),
    },
    commit: null,
    warnings: [],
    problems: [],
  };

  await fetchTracker(root, ctx, report.warnings);
  const leaveOptions: LeaveOptions = {
    root,
    ctx,
    prompter,
    say,
    ...(options.env ? { env: options.env } : {}),
    ...(options.capture ? { capture: options.capture } : {}),
    ...(options.cutBudgetMs !== undefined ? { cutBudgetMs: options.cutBudgetMs } : {}),
  };
  let leavePlan: LeavePlan | null = null;
  let pre: Preflight | null = null;
  let eject: ServedSkill[] = [];
  let push = false;
  let purge = false;
  const close = async () => {
    if (leavePlan) await closeLeave(leavePlan);
    await pre?.tracker.close().catch(() => {});
  };
  try {
    sayPlan(say, root, plan);
    if (report.codex.notice) say(report.codex.notice);

    const skills = await activeSkills(root, report.warnings);
    if (skills.length > 0) {
      say(`Evolved skills agents are served now (${skills.length}); uninstalling stops serving them here:`);
      for (const skill of skills) say(`  ${skill.name} (${skill.version.slice(0, 12)}): ${skill.description}`);
      const answer = await prompter.ask(`Eject any into this checkout as ordinary skills you keep (.claude/skills/<name>/ and .agents/skills/<name>/)? Type their names, or all, or nothing for none: `);
      const words = (answer ?? '').split(/[\s,]+/).filter((word) => word !== '');
      eject = words.some((word) => word.toLowerCase() === 'all') ? skills : skills.filter((skill) => words.includes(skill.name));
      for (const word of words) {
        if (word.toLowerCase() !== 'all' && !skills.some((skill) => skill.name === word)) report.warnings.push(`${word} isn't an evolved skill agents are served, so it wasn't ejected`);
      }
    }

    if (leaving) {
      say('No other worktree of this clone has grimoire installed, so uninstall also leaves this clone on this machine:');
      const prepared = await prepareLeave({ ...leaveOptions, ...(eject.length > 0 ? { pendingWrites: 'ejecting' } : {}) });
      if ('stopped' in prepared) {
        report.leave = prepared.stopped;
        return { ...report, ...(prepared.stopped.stopped ? { stopped: prepared.stopped.stopped } : {}) };
      }
      leavePlan = prepared.plan;
    } else {
      say(`Other worktrees of this clone still have grimoire installed, so this clone stays joined: ${stillInstalled.join(', ')}. Once grimoire is uninstalled there, run grimoire leave.`);
      pre = await preflight(root, commonDir, store, ctx);
      report.warnings.push(...pre.warnings);
      if (pre.held.length > 0) {
        say(`Open attempts held from this machine (${pre.held.length}); release the ones you won't finish:`);
        for (const entry of pre.held) say(`  ${entry.id} ${entry.attempt}${entry.title ? `: ${entry.title}` : ''}  (grimoire release ${entry.id} ${entry.attempt})`);
      }
      const unsaved = pre.unsaved.filter((edit) => same(edit.worktree, root));
      const strays = [...pre.saved.map((edit) => ({ ...edit, id: edit.id as string | null })), ...unsaved.map((edit) => ({ ...edit, id: null }))];
      if (strays.length > 0) {
        say(`Stray edits to generated copies (${strays.length}); uninstalling loses them:`);
        for (const edit of strays) say(`  ${edit.skill} in ${edit.worktree} (${edit.path})${edit.id ? `: ${edit.id}` : ''}`);
        if (yes(await prompter.ask('Stop now so you can record them first? [y/N] '))) {
          const ids = await saveStrays(store, { saved: pre.saved, unsaved, served: pre.served }, report);
          say('Nothing was removed. Record each stray edit you want to keep, then run uninstall again:');
          for (const id of ids) say(`  grimoire skill record ${id}`);
          return { ...report, stopped: 'stray-edits' };
        }
      }
      const unpushed = pre.unpushed?.commits ?? 0;
      const what = `${unpushed > 0 ? plural(unpushed, 'unpushed tracker commit') : ''}${eject.length > 0 ? `${unpushed > 0 ? ', plus ' : ''}what ejecting writes` : ''}`;
      if (unpushed > 0 || eject.length > 0) {
        if (pre.view && autoSyncOn(pre.view)) {
          push = true;
          say(`Auto-sync is on: uninstall pushes ${what} once you confirm.`);
        } else {
          push = yes(await prompter.ask(`Push ${what} once you confirm? [y/N] `));
        }
      }
      const withText = pre.unpushed?.withText ?? 0;
      if (withText > 0) {
        purge = yes(await prompter.ask(`${plural(withText, 'unpushed commit')} ${withText === 1 ? 'carries' : 'carry'} excerpt text. Purge it first? [y/N] `));
      }
      // Leave's preflight says it on the other path.
      say('Excerpts already pushed stay in the history of grimoire/tracker on the remote.');
    }

    const answer = await prompter.ask(`grimoire uninstall is a human-only operation. Type ${UNINSTALL_CONFIRMATION} to confirm (anything else cancels): `);
    if (answer === null || answer.trim() !== UNINSTALL_CONFIRMATION) {
      throw new GrimoireError('INVALID', `uninstall was not confirmed: type ${UNINSTALL_CONFIRMATION} exactly to run it; nothing changed`, {
        fields: { confirmation: `must be ${UNINSTALL_CONFIRMATION}` },
      });
    }
  } catch (error) {
    await close();
    throw error;
  }

  // Confirmed: from here on what goes wrong is a report.
  if (eject.length > 0) await ejectSkills(root, ctx, eject, report);

  const removeHere = async (): Promise<boolean> => {
    report.checkout = await removeThisCheckout(root, store, options, report);
    return report.checkout.complete;
  };
  if (leavePlan) {
    const plan = leavePlan;
    leavePlan = null;
    report.leave = await performLeave(leaveOptions, plan, { beforeRemoval: removeHere });
    report.problems.push(...report.leave.problems);
  } else {
    const tracker = pre!.tracker;
    try {
      if (purge) {
        try {
          report.purged = await tracker.stripUnpushedText(PURGE_TEXT);
        } catch (error) {
          report.problems.push(`purging the unpushed excerpt text failed: ${messageOf(error)}`);
        }
      }
      if (push) await finalSync(tracker, ctx, true, report);
    } finally {
      await tracker.close().catch(() => {});
    }
    try {
      await refuseLive(store, root, 'nothing in this checkout was removed');
    } catch (error) {
      report.problems.push(messageOf(error));
      return { ...report, stopped: 'busy' };
    }
    await removeHere();
  }
  const removal = report.checkout as CheckoutRemoval | null;
  if (removal === null) return { ...report, ...(report.leave?.stopped ? { stopped: report.leave.stopped } : {}) };
  report.problems.unshift(...removal.problems);
  report.commit = commitOf(await pathsToCommit(root, removal, report.ejected), report.ejected);
  if (!removal.complete) return { ...report, stopped: 'checkout' };
  if (!leaving) report.warnings.push(`This clone stays joined: once grimoire is uninstalled in ${stillInstalled.join(', ')}, run grimoire leave.`);
  return { ...report, uninstalled: true };
}

/** Ejects each accepted skill into the checkout (the core's `skill_eject`), as the person. */
async function ejectSkills(root: string, ctx: CallContext, skills: readonly ServedSkill[], report: UninstallReport): Promise<void> {
  try {
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      for (const skill of skills) {
        const done = await core.call('skill_eject', { name: skill.name, base: skill.version }, { ...ctx, repo: { ...ctx.repo, root } });
        if (done.ok) {
          const result = done.result as { name: string; version: string; files: string[] };
          report.ejected.push({ name: result.name, version: result.version, files: result.files });
        } else {
          report.problems.push(`ejecting ${skill.name} failed: ${done.error.message}`);
        }
      }
    } finally {
      await core.close();
    }
  } catch (error) {
    report.problems.push(`ejecting the evolved skills failed: ${messageOf(error)}`);
  }
}

/** The checkout's removal, planned again now, under the (store, worktree) lease so upkeep keeps off. */
async function removeThisCheckout(root: string, store: MachineLocalStore, options: UninstallOptions, report: UninstallReport): Promise<CheckoutRemoval> {
  const failed = (problem: string): CheckoutRemoval => ({ complete: false, removed: [], deleted: [], edited: [], generated: [], kept: [], problems: [problem] });
  const joined = await lstat(store.dir).then(
    () => true,
    () => false,
  );
  const listed = joined ? await readPathList(store).catch(() => [] as string[]) : [];
  let lease: Awaited<ReturnType<typeof holdWorktreeLease>> = null;
  try {
    lease = joined ? await holdWorktreeLease(store, root) : null;
  } catch (error) {
    return failed(`grimoire couldn't take this checkout's lease, so nothing in it was removed: ${messageOf(error)}`);
  }
  if (joined && lease === null) return failed(`another grimoire process keeps working on ${root} (upkeep or doctor --fix): run uninstall again in a moment`);
  // What the test seam throws stops the removal as a crash would: it goes through.
  const crashed = new Set<unknown>();
  const onStep = options.onRemovalStep;
  try {
    let plan: RemovalPlan;
    try {
      plan = await planRemoval(root);
    } catch (error) {
      return failed(`grimoire couldn't read ${MANIFEST_PATH} and the files it names again, so nothing in this checkout was removed: ${messageOf(error)}`);
    }
    for (const mention of plan.mentions) if (!report.mentions.some((known) => known.path === mention.path && known.line === mention.line)) report.mentions.push(mention);
    return await removeCheckout(plan, {
      listed,
      ...(onStep
        ? {
            onStep: async (relative: string) => {
              try {
                await onStep(relative);
              } catch (error) {
                crashed.add(error);
                throw error;
              }
            },
          }
        : {}),
    });
  } catch (error) {
    if (crashed.has(error)) throw error;
    return failed(`the removal stopped: ${messageOf(error)}`);
  } finally {
    await lease?.release().catch(() => {});
  }
}

/** One kept item, as a person reads it. */
export function keptLine(item: KeptItem): string {
  return `Left ${item.path}: ${item.why}`;
}
