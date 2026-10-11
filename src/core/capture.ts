// Attempt-end capture in the core (spec §14 Cut at attempt end): every op that
// ends an attempt validates without writing, cuts the bound contexts with
// `cutForEnding`, then seals their session records with `sealCaptures` inside
// its one compare-and-set round, before `end.md`. A replay never gets here, so
// it never cuts again. Capture never fails the ending: a capture problem is a
// record's status.
import { captureAtEnd, sealSessionRecords, type CaptureMode, type ContextCapture, type SkillReadEvent } from '../capture/end';
import { observedEvidence } from '../capture/evidence';
import { cutSucceeded } from '../capture/session-record';
import { noteCutReach } from '../capture/seen-here';
import { cancelSweeps } from '../capture/sweeps';
import { MachineLocalStore } from '../machine-local';
import type { AttemptRecord, TrackerDraft, TrackerView } from '../tracker';
import type { OpEnv } from './op';
import { isExcerptMode, readMachineSetting, storeExcerptMode } from './settings';
import { SKILL_READS } from './skills';

const RANK: Readonly<Record<CaptureMode, number>> = { none: 0, facts: 1, excerpts: 2 };

/** This machine's machine-setting cap on the excerpt mode (spec §6). */
const EXCERPTS_MAX = 'capture.excerpts_max';

/**
 * The mode a cut on this machine applies (spec §14 The setting): the store's
 * merged mode, lowered by this machine's `capture.excerpts_max`.
 */
export async function captureMode(view: Pick<TrackerView, 'settings'>, commonDir: string): Promise<{ mode: CaptureMode; capped: boolean }> {
  const store = storeExcerptMode(view);
  const max = await readMachineSetting(commonDir, EXCERPTS_MAX).catch(() => undefined);
  if (isExcerptMode(max) && RANK[max] < RANK[store]) return { mode: max, capped: true };
  return { mode: store, capped: false };
}

/** The attempt an op is about to end. */
export interface Ending {
  readonly issue: string;
  /** Null for an unclaimed close: its instant attempt opens in the ending commit. */
  readonly attempt: AttemptRecord | null;
  /** The op (`close`, `release`, `reassign`, `reopen`): how the cut finds a CLI ending call. */
  readonly op: string;
  /** Whether the ending call binds: its own context is then cut first. */
  readonly binds: boolean;
}

/** What an ending carries into its commit: the captures, and the mode they were cut under. */
export interface EndingCapture {
  readonly captures: readonly ContextCapture[];
  readonly mode: CaptureMode;
}

const NOTHING: EndingCapture = { captures: [], mode: 'none' };

/**
 * Step 2 (spec §14): cancels the sweeps running in this process, then cuts the
 * ending's bound contexts within the budget, against the view the call
 * validated. Never throws.
 */
export async function cutForEnding(env: OpEnv, view: TrackerView, ending: Ending): Promise<EndingCapture> {
  cancelSweeps();
  try {
    const { commonDir, root } = env.tracker.location;
    const store = new MachineLocalStore(commonDir, env.ctx.repo.root);
    const { mode, capped } = await captureMode(view, commonDir);
    const { source, pendingHint } = observedEvidence(env.ctx);
    const skillReads = await store.records
      .list<SkillReadEvent>(SKILL_READS)
      .then((entries) => entries.map((entry) => entry.value))
      .catch(() => []);
    const captures = await captureAtEnd({
      repoRoot: root,
      worktree: env.ctx.repo.root,
      store,
      view,
      issue: ending.issue,
      attempt: ending.attempt,
      call: { op: ending.op, actor: env.actor, source, pendingHint, binds: ending.binds, at: env.tracker.now().toISOString() },
      mode,
      capped,
      skillReads,
      scanner: env.scanner,
      ...(env.capture ? { options: env.capture } : {}),
    });
    return { captures, mode };
  } catch {
    return NOTHING;
  }
}

/**
 * Step 3, inside the ending's compare-and-set round and before its seal:
 * writes the session records of `handle` (the further-reaching of each fresh
 * cut and its pending record). A mode tightened since the cut drops the text.
 * Returns the session keys written.
 */
export async function sealCaptures(draft: TrackerDraft, handle: string, capture: EndingCapture): Promise<string[]> {
  if (capture.captures.length === 0) return [];
  const now = storeExcerptMode(draft);
  const mode = RANK[now] < RANK[capture.mode] ? now : capture.mode;
  return sealSessionRecords(draft, handle, capture.captures, mode);
}

/**
 * After the ending commit: notes each written cut's reach on its seen-here
 * row, and asks for the automatic sync the attachment triggers (the sealing
 * commit asks too). Best effort.
 */
export async function afterSeal(env: OpEnv, handle: string, capture: EndingCapture, written: readonly string[], commit: string | null): Promise<void> {
  if (commit === null || written.length === 0) return;
  env.requestSync(commit);
  try {
    const store = new MachineLocalStore(env.tracker.location.commonDir, env.ctx.repo.root);
    for (const { key, record, row } of capture.captures) {
      if (row && written.includes(key) && cutSucceeded(record) && record.reach) await noteCutReach(store, handle, key, record.reach);
    }
  } catch {
    // A row is only a hint.
  }
}
