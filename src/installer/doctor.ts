// `doctor` (spec §12): a read-only report on the store and the install of one
// checkout, and with `--fix` the single-answer repairs only: content pointer
// files and stale locks. Each check is one entry of DOCTOR_CHECKS (the store's
// in ./store-checks.ts, the install's in ./install-checks.ts), so later slices
// add their own (capture statistics, knowledge facts, the runner) the same way.
import { sessionRecordProblem } from '../capture';
import { GrimoireError } from '../errors';
import { ledgerRecordProblem } from '../knowledge';
import { findGitDirs, MachineLocalStore, type GitDirs, type Lease } from '../machine-local';
import { inspectTrees, openTracker, removeStaleRefLocks, trackerTips, type TrackerStore, type TrackerTips, type TrackerView, type TreeInspection } from '../tracker';
import { holdWorktreeLease, noteRefreshed, operationInProgress, refreshNotice, upgradeInProgress, upgradeSkipNotice } from '../upkeep';
import { VERSION } from '../version';
import { readInstallConfig, type CheckoutInstall } from './config';
import { INSTALL_CHECKS } from './install-checks';
import { refreshContentPointers, type ContentRefresh } from './refresh';
import { STORE_CHECKS } from './store-checks';
import { countBySeverity, messageOf, type CheckFinding, type CheckRun, type Finding, type Severity } from './health';

/** What every check is handed. Everything costly is read once, on first use. */
export interface DoctorInput {
  /** The checkout's root (it holds `.git`). */
  readonly root: string;
  readonly dirs: GitDirs;
  readonly store: MachineLocalStore;
  /** The version this process runs. */
  readonly version: string;
  /** The checkout's config.yml, or null in a checkout grimoire isn't installed in. */
  readonly config: CheckoutInstall | null;
  readonly env: NodeJS.ProcessEnv;
  /** The tracker tips this clone holds. */
  readonly tips: () => Promise<TrackerTips>;
  /** What the tracker trees hold, file by file. */
  readonly trees: () => Promise<TreeInspection>;
  /** The merged view every read shows; throws when it can't be read (NOT_SYNCED, an unparsable record). */
  readonly view: () => Promise<TrackerView>;
}

/** What a check returns: its findings, or why it had nothing to look at. */
export type CheckOutcome = readonly CheckFinding[] | { readonly skipped: string };

/** One check of the report. */
export interface DoctorCheck {
  /** `<section>.<name>`. */
  readonly name: string;
  readonly section: string;
  run(input: DoctorInput): Promise<CheckOutcome>;
}

export interface DoctorOptions {
  readonly root: string;
  /** The version this process runs (default: this build's). */
  readonly version?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The checks to run (default: every check this release ships). */
  readonly checks?: readonly DoctorCheck[];
  /** Make the single-answer repairs (content pointer files, stale locks), then report what is left. */
  readonly fix?: boolean;
  /** How long `fix` waits for the (live store, worktree) lease while another process holds it (default 30 s). */
  readonly leaseWaitMs?: number;
}

export interface DoctorReport {
  readonly version: string;
  readonly root: string;
  /** The checkout's pin, or null. */
  readonly pin: string | null;
  /** No finding is an error. */
  readonly ok: boolean;
  readonly counts: Record<Severity, number>;
  readonly findings: Finding[];
  readonly checks: CheckRun[];
  /** With --fix: what was repaired. */
  readonly fix?: FixReport;
}

/** Every check this release ships, in report order. */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [...STORE_CHECKS, ...INSTALL_CHECKS];

/** What `--fix` did. */
export interface FixReport {
  /** Each repair made: what was found, about what, and what was done. */
  readonly fixed: { readonly kind: string; readonly subject: string; readonly action: string }[];
  /** Repairs left undone, and why. */
  readonly skipped: { readonly kind: string; readonly subject?: string; readonly why: string }[];
  /** Lines a person should see ("commit them", the upgrade-in-progress line). */
  readonly notices: string[];
}

/** Runs the checks once over a fresh input; costly reads are shared between them. */
async function runChecks(options: DoctorOptions, dirs: GitDirs, config: CheckoutInstall | null, version: string): Promise<{ input: DoctorInput; findings: Finding[]; checks: CheckRun[] }> {
  let tips: Promise<TrackerTips> | null = null;
  let trees: Promise<TreeInspection> | null = null;
  let tracker: Promise<TrackerStore> | null = null;
  let view: Promise<TrackerView> | null = null;
  const input: DoctorInput = {
    root: options.root,
    dirs,
    store: new MachineLocalStore(dirs.commonDir, dirs.worktree),
    version,
    config,
    env: options.env ?? process.env,
    tips: () => (tips ??= trackerTips(options.root)),
    trees: () => (trees ??= input.tips().then((held) => inspectTrees(options.root, held, { ledgerRecord: ledgerRecordProblem, sessionRecord: sessionRecordProblem }))),
    view: () => (view ??= (tracker ??= openTracker(options.root)).then((store) => store.read())),
  };
  const findings: Finding[] = [];
  const checks: CheckRun[] = [];
  try {
    for (const check of options.checks ?? DOCTOR_CHECKS) {
      try {
        const outcome = await check.run(input);
        if ('skipped' in outcome) {
          checks.push({ check: check.name, section: check.section, status: 'skipped', why: outcome.skipped });
          continue;
        }
        findings.push(...outcome.map((finding) => ({ section: check.section, check: check.name, ...finding, fixable: finding.fixable ?? false })));
        checks.push({ check: check.name, section: check.section, status: outcome.length > 0 ? 'findings' : 'ok' });
      } catch (error) {
        checks.push({ check: check.name, section: check.section, status: 'failed', error: messageOf(error) });
      }
    }
  } finally {
    if (tracker) await (await (tracker as Promise<TrackerStore>).catch(() => null))?.close();
  }
  return { input, findings, checks };
}

/**
 * Content pointer files back to the pinned release's text, under the
 * (live store, worktree) lease upkeep and `init` share, with upkeep's skips:
 * a process at another version than the pin, a git operation in progress, an
 * upgrade in progress to another pin (checked again under the lease).
 */
async function refreshPointers(input: DoctorInput, fix: FixReport, leaseWaitMs: number | undefined): Promise<void> {
  const { root, store, version } = input;
  const skip = (why: string): void => void fix.skipped.push({ kind: 'content-drift', why });
  if (input.config?.version !== version) return skip(`this is grimoire ${version} and the checkout pins ${input.config?.version ?? 'nothing'}: only the pinned version rewrites its text`);
  const operation = await operationInProgress(root);
  if (operation) return skip(`a ${operation} is in progress in ${root}`);
  const upgradeGate = async (): Promise<boolean> => {
    const upgrade = await upgradeInProgress(store, root).catch(() => null);
    if (!upgrade || upgrade.to === version) return false;
    fix.notices.push(upgradeSkipNotice(root, upgrade.to));
    skip(`an upgrade to ${upgrade.to} is in progress`);
    return true;
  };
  if (await upgradeGate()) return;
  let lease: Lease | null;
  try {
    lease = await holdWorktreeLease(store, root, leaseWaitMs === undefined ? {} : { waitMs: leaseWaitMs });
  } catch (error) {
    // A sandboxed shell (Codex's) can't write .git/: the report still goes out.
    return skip(`grimoire can’t write this clone’s machine-local store (${messageOf(error)})`);
  }
  if (!lease) return skip(`another grimoire process keeps working on ${root} (upkeep, init or doctor --fix); run doctor --fix again in a moment`);
  try {
    if (await upgradeGate()) return;
    let refresh: ContentRefresh;
    try {
      refresh = await refreshContentPointers(root);
    } catch (error) {
      return skip(`grimoire couldn’t plan the pointer files’ refresh (${messageOf(error)})`);
    }
    const { refreshed, skipped } = refresh;
    for (const file of refreshed) fix.fixed.push({ kind: 'content-drift', subject: file, action: 'rewrote it with the shipped text' });
    for (const left of skipped) fix.skipped.push({ kind: 'content-drift', subject: left.path, why: left.why });
    // `status` and the session line ask to commit them, as for upkeep's own refreshes.
    await noteRefreshed(store, root, refreshed).catch(() => {});
    if (refreshed.length > 0) fix.notices.push(refreshNotice(refreshed.length, null));
  } finally {
    await lease.release().catch(() => {});
  }
}

/** The single-answer repairs (spec §12 `--fix`): content pointer files and stale locks. Nothing else is touched. */
async function applyFixes(input: DoctorInput, findings: readonly Finding[], leaseWaitMs: number | undefined): Promise<FixReport> {
  const fix: FixReport = { fixed: [], skipped: [], notices: [] };
  const fixable = (kind: string) => findings.filter((finding) => finding.fixable && finding.kind === kind);
  if (fixable('stale-ref-lock').length > 0) {
    const { removed, failed } = await removeStaleRefLocks(input.dirs.commonDir);
    for (const lock of removed) fix.fixed.push({ kind: 'stale-ref-lock', subject: lock.name, action: 'removed it' });
    for (const { lock, why } of failed) fix.skipped.push({ kind: 'stale-ref-lock', subject: lock.name, why });
  }
  for (const finding of fixable('stale-lease')) {
    const cleared = await input.store.leases.clearExpired(finding.subject!).catch(() => false);
    if (cleared) fix.fixed.push({ kind: finding.kind, subject: finding.subject!, action: 'released it' });
    else fix.skipped.push({ kind: finding.kind, subject: finding.subject!, why: 'it is held again' });
  }
  for (const finding of [...fixable('stale-lock'), ...fixable('stale-start-lock')]) {
    const cleared = await input.store.locks.clearStale(finding.subject!).catch(() => false);
    if (cleared) fix.fixed.push({ kind: finding.kind, subject: finding.subject!, action: 'released it' });
    else fix.skipped.push({ kind: finding.kind, subject: finding.subject!, why: 'it is held again' });
  }
  if (fixable('content-drift').length > 0) await refreshPointers(input, fix, leaseWaitMs);
  return fix;
}

const SECTION_TITLES: Readonly<Record<string, string>> = { store: 'Store', install: 'Install' };

/** The report as a person reads it: each section's findings, worst first, with what to do. */
export function doctorText(report: DoctorReport): string[] {
  const lines = [`grimoire ${report.version} doctor in ${report.root}${report.pin ? ` (pins ${report.pin})` : ''}`];
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const sections = [...new Set(report.checks.map((run) => run.section))];
  for (const section of sections) {
    const findings = report.findings.filter((finding) => finding.section === section).sort((a, b) => order[a.severity] - order[b.severity]);
    const failed = report.checks.filter((run) => run.section === section && run.status === 'failed');
    const title = SECTION_TITLES[section] ?? section;
    if (findings.length === 0 && failed.length === 0) {
      lines.push(`${title}: ok`);
      continue;
    }
    lines.push(`${title}:`);
    for (const finding of findings) {
      lines.push(`  ${finding.severity.padEnd(7)} ${finding.message}`);
      if (finding.fixable) lines.push('          fix: grimoire doctor --fix');
      else if (finding.remedy) lines.push(`          fix: ${finding.remedy}`);
    }
    for (const run of failed) lines.push(`  failed  ${run.check} couldn’t run: ${run.error}`);
  }
  if (report.fix) {
    lines.push(report.fix.fixed.length > 0 ? 'Fixed:' : 'Fixed: nothing');
    for (const entry of report.fix.fixed) lines.push(`  ${entry.subject}: ${entry.action}`);
    for (const entry of report.fix.skipped) lines.push(`  left ${entry.subject ?? entry.kind}: ${entry.why}`);
    lines.push(...report.fix.notices);
  }
  const { error, warning, info } = report.counts;
  lines.push(`${error} error${error === 1 ? '' : 's'}, ${warning} warning${warning === 1 ? '' : 's'}, ${info} note${info === 1 ? '' : 's'}`);
  return lines;
}

/** Runs every check on `root` and reports what they found. Reads only, unless `fix`. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const dirs = await findGitDirs(options.root);
  if (!dirs) throw new GrimoireError('NO_REPO', `no git repository at ${options.root}`, { root: options.root });
  const config = await readInstallConfig(options.root);
  const version = options.version ?? VERSION;
  let run = await runChecks(options, dirs, config, version);
  let fix: FixReport | undefined;
  if (options.fix) {
    fix = await applyFixes(run.input, run.findings, options.leaseWaitMs);
    // The report shows what is left after the repairs.
    if (fix.fixed.length > 0) run = await runChecks(options, dirs, config, version);
  }
  const counts = countBySeverity(run.findings);
  return {
    version,
    root: options.root,
    pin: config?.version ?? null,
    ok: counts.error === 0,
    counts,
    findings: run.findings,
    checks: run.checks,
    ...(fix ? { fix } : {}),
  };
}
