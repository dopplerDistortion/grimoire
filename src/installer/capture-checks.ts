// `doctor`'s capture checks (spec §12 doctor; §6 capture doctor stats, revealed
// roots; §14 Statuses):
// - `capture.stats`, always: the session records cut after their attempt
//   ended on another clone that folds dropped (counted machine-local), and
//   the tracker's session records whose cut was `unreadable` or `unmatched`.
//   Gathered without opening a transcript.
// - `capture.readers`, only with `--readers`: the readers' structure
//   statistics over this machine's transcripts of this repo (cwd inside one
//   of its worktrees), in the client folders and those hooks revealed.
//   Skipped in `none` mode, which never opens a transcript.
import path from 'node:path';
import { defaultClaudeConfigDir } from '../capture/claude-code/roots';
import { defaultCodexHome } from '../capture/codex/roots';
import { readerStats, type ReaderStats } from '../capture/reader-stats';
import { parseSessionRecord } from '../capture/session-record';
import { revealedRoots } from '../capture/transcript-roots';
import { captureMode } from '../core/capture';
import type { Json } from '../machine-local';
import { CAPTURE_STATS, LATE_CUT_DROPS, type LateCutDrops, type TrackerView } from '../tracker';
import type { CheckOutcome, DoctorCheck, DoctorInput } from './doctor';
import { messageOf, type CheckFinding } from './health';
import { registeredWorktrees } from './worktrees';

/** How many of the latest affected records a finding names. */
const LATEST = 5;

/** The tracker's session records whose cut was unreadable or unmatched, per status: `<attempt>/<session-key>`, by reader. */
async function failedCuts(view: TrackerView): Promise<Map<'unreadable' | 'unmatched', { records: string[]; readers: Record<string, number> }>> {
  const found = new Map<'unreadable' | 'unmatched', { records: string[]; readers: Record<string, number> }>([
    ['unreadable', { records: [], readers: {} }],
    ['unmatched', { records: [], readers: {} }],
  ]);
  const attempts = [...view.allAttempts()].sort((a, b) => Date.parse(a.start.at) - Date.parse(b.start.at));
  for (const attempt of attempts) {
    for (const key of [...attempt.sessions.keys()].sort()) {
      const bytes = await view.sessionRecord(attempt.id, key);
      if (bytes === null) continue;
      const record = parseSessionRecord(bytes);
      for (const status of ['unreadable', 'unmatched'] as const) {
        if (record.excerpt !== status && record.facts !== status) continue;
        const entry = found.get(status)!;
        entry.records.push(`${attempt.id}/${key}`);
        const reader = `${record.client}${record.reader_version === null ? '' : ` reader ${record.reader_version}`}`;
        entry.readers[reader] = (entry.readers[reader] ?? 0) + 1;
      }
    }
  }
  return found;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const captureStats: DoctorCheck = {
  name: 'capture.stats',
  section: 'capture',
  async run(input: DoctorInput): Promise<CheckOutcome> {
    const findings: CheckFinding[] = [];
    const drops = await input.store.records.read<LateCutDrops>(CAPTURE_STATS, LATE_CUT_DROPS).catch(() => undefined);
    if (drops && drops.count > 0) {
      findings.push({
        kind: 'late-cut-drops',
        severity: 'info',
        message: `${plural(drops.count, 'session record')} cut after its attempt ended on another clone ${drops.count === 1 ? 'was' : 'were'} dropped by folds on this machine (latest ${drops.last_at})`,
        details: { count: drops.count, last_at: drops.last_at, latest: [...drops.last].slice(-LATEST) },
      });
    }
    let view: TrackerView | null = null;
    try {
      const tips = await input.tips();
      if (tips.local !== null || tips.remotes.size > 0) view = await input.view();
    } catch (error) {
      if (findings.length === 0) return { skipped: `the merged view can’t be read: ${messageOf(error)}` };
    }
    if (view !== null) {
      for (const [status, { records, readers }] of await failedCuts(view)) {
        if (records.length === 0) continue;
        const by = Object.entries(readers)
          .map(([reader, n]) => `${reader}: ${n}`)
          .join(', ');
        findings.push({
          kind: status,
          severity: status === 'unreadable' ? 'warning' : 'info',
          message:
            status === 'unreadable'
              ? `${plural(records.length, 'session record')} could not be cut: the transcript reader missed a binding call it should have found (${by})`
              : `${plural(records.length, 'session record')} could not be cut: a CLI binding call matched no shell command, or several (${by})`,
          ...(status === 'unreadable' ? { remedy: 'run grimoire doctor --readers to see how the readers fare on this machine’s transcripts; an upgrade may carry a reader for the client’s newer format' } : {}),
          details: { count: records.length, readers, latest: records.slice(-LATEST) },
        });
      }
    }
    return findings;
  },
};

/** Every folder to read transcripts from: the clients' own, and those hooks revealed on this machine. */
async function transcriptHomes(input: DoctorInput): Promise<{ claude: string[]; codex: string[] }> {
  const claude = [defaultClaudeConfigDir(input.env)];
  const codex = [defaultCodexHome(input.env)];
  for (const root of await revealedRoots(input.store).catch(() => [])) {
    // A revealed Claude Code root is a `projects/<slug>/` folder; its config folder is two levels up.
    if (root.client === 'claude-code') claude.push(path.dirname(path.dirname(root.root)));
    else codex.push(root.root);
  }
  return { claude, codex };
}

function readerLine(stats: ReaderStats): string {
  const { lines, steps } = stats;
  const kinds = Object.entries(steps)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  return (
    `${stats.client} reader ${stats.reader_version}: ${plural(stats.transcripts, 'transcript')}${stats.capped ? ' (the newest; older ones left)' : ''}, ` +
    `${plural(lines.read, 'line')} (${lines.unknown} unknown, ${lines.malformed} malformed), ${stats.unreadable} unreadable` +
    (kinds ? `; steps: ${kinds}` : '') +
    (stats.client_versions.length > 0 ? `; client ${stats.client_versions.join(', ')}` : '')
  );
}

/** `--readers`: opt-in, and the only check that opens transcripts. */
export const READERS_CHECK: DoctorCheck = {
  name: 'capture.readers',
  section: 'capture',
  async run(input: DoctorInput): Promise<CheckOutcome> {
    const tips = await input.tips();
    if (tips.local !== null || tips.remotes.size > 0) {
      const { mode } = await captureMode(await input.view(), input.dirs.commonDir);
      if (mode === 'none') return { skipped: 'the excerpt mode on this machine is none: grimoire never opens a transcript' };
    }
    const { worktrees } = await registeredWorktrees(input.dirs.commonDir);
    const homes = await transcriptHomes(input);
    const stats = await readerStats({ worktrees: worktrees.length > 0 ? worktrees : [input.root], claudeConfigDirs: homes.claude, codexHomes: homes.codex });
    return stats.map((entry) => ({
      kind: 'reader-stats',
      severity: entry.unreadable > 0 || entry.lines.malformed > 0 ? 'warning' : 'info',
      message: readerLine(entry),
      details: entry as unknown as { [key: string]: Json },
    }));
  },
};

/** The checks every `doctor` runs. */
export const CAPTURE_CHECKS: readonly DoctorCheck[] = [captureStats];
