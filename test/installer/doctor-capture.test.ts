// Seam 1 for `doctor`'s capture checks (GOK-156; spec §12 doctor, `--readers`;
// §6 capture doctor stats, revealed roots): runDoctor driven in process.
// Plain `doctor` shows the capture statistics (late-cut drops, `unreadable`
// and `unmatched` cuts) without opening a transcript; `--readers` reads this
// machine's transcripts whose cwd is inside the repo and reports structure
// statistics only, and is skipped in `none` mode.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { fixturePath, gitTest, makeTempDir, removeDir } from '#harness';
import { parseSessionRecord, serializeSessionRecord } from '../../src/capture/session-record';
import { putMachineSetting } from '../../src/core/settings';
import { runDoctor, type DoctorReport } from '../../src/installer/doctor';
import { MachineLocalStore } from '../../src/machine-local';
import { openTracker, trackerTips } from '../../src/tracker';
import { countLateDrops } from '../../src/tracker/capture-stats';
import { setExcerptMode } from '../core/capture-support';
import { coreTest as test } from '../core/support';

const SESSION = 'ff9eace1-0645-4dd9-bf34-f61ffa87b3c2';
const SUBAGENT_COMMIT = 'claude-code/transcripts/subagent-commit';
const CODEX_CHILD = 'codex/transcripts/subagent/rollout-2026-10-11T07-44-47-01a12947-16a2-7152-be00-4e4b1e12a4d8.jsonl';
const CODEX_ROOT = 'codex/transcripts/subagent/rollout-2026-10-11T07-44-45-01a12947-11cf-7fd1-8ece-b3d7fe5a6e72.jsonl';

/** The capture section of a report: its findings and how its checks ran. */
function capture(report: DoctorReport) {
  return {
    findings: report.findings.filter((finding) => finding.section === 'capture'),
    checks: report.checks.filter((run) => run.section === 'capture'),
  };
}

/** A session record of `client` with the given cut statuses, as capture writes one. */
const record = (client: string, excerpt: string, facts: string) =>
  serializeSessionRecord({
    ...parseSessionRecord(Buffer.from('---\n---\n')),
    client,
    reader_version: 1,
    session: 's1',
    excerpt: excerpt as never,
    facts: facts as never,
    cut_at: '2026-10-12T05:00:00.000Z',
  });

/**
 * A copy of a fixture transcript that ran in `cwd` instead: the fixture's own
 * probe-repo path, in each JSON spelling, rewritten to `cwd` (the way the
 * sanitizer rewrote the user name).
 */
async function movedTranscript(source: string, target: string, from: string, cwd: string): Promise<void> {
  const text = await readFile(fixturePath(source), 'utf8');
  const escape = (p: string) => JSON.stringify(p).slice(1, -1);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text.split(escape(from)).join(escape(cwd)));
}

describe('plain doctor: capture statistics', () => {
  test('late-cut drops, unreadable and unmatched cuts are counted, by reader; no transcript is opened', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const created = await core.call('create', { title: 'Captured' }, ctx);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const claim = await core.call('claim', { id: created.result.id }, ctx);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const attempt = claim.result.attempt;
    const tracker = await openTracker(world.a.dir);
    try {
      await tracker.transact({ op: 'capture', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'agent', client: 'claude-code', nonce: 'n' } }, (draft) => {
        draft.putSessionRecord(attempt, '1111111111111111', record('claude-code', 'unreadable', 'unreadable'));
        draft.putSessionRecord(attempt, '2222222222222222', record('codex', 'unreadable', 'unreadable'));
        draft.putSessionRecord(attempt, '3333333333333333', record('claude-code', 'unmatched', 'unmatched'));
        draft.putSessionRecord(attempt, '4444444444444444', record('claude-code', 'cut', 'scanned'));
        return { result: null };
      });
    } finally {
      await tracker.close();
    }
    await countLateDrops(path.join(world.a.dir, '.git'), [`${attempt}/9999999999999999`, `${attempt}/8888888888888888`], new Date('2026-10-12T06:00:00.000Z'));

    // This repo's transcripts are where Claude Code keeps them: plain doctor never reads them.
    const configDir = await makeTempDir('grimoire-claude-config-');
    const empty = await makeTempDir('grimoire-claude-empty-');
    try {
      const project = path.join(configDir, 'projects', path.resolve(world.a.dir).replace(/[^a-zA-Z0-9]/g, '-'));
      await movedTranscript(`${SUBAGENT_COMMIT}/${SESSION}.jsonl`, path.join(project, `${SESSION}.jsonl`), 'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-gok156\\proj', world.a.dir);
      const withTranscripts = await runDoctor({ root: world.a.dir, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: configDir } });
      const without = await runDoctor({ root: world.a.dir, env: { ...process.env, CLAUDE_CONFIG_DIR: empty, CODEX_HOME: empty } });

      const { findings, checks } = capture(withTranscripts);
      expect(checks).toEqual([{ check: 'capture.stats', section: 'capture', status: 'findings' }]);
      expect(findings.map((finding) => [finding.kind, finding.severity, finding.details?.count])).toEqual([
        ['late-cut-drops', 'info', 2],
        ['unreadable', 'warning', 2],
        ['unmatched', 'info', 1],
      ]);
      expect(findings[0]!.details).toMatchObject({ last_at: '2026-10-12T06:00:00.000Z', latest: [`${attempt}/9999999999999999`, `${attempt}/8888888888888888`] });
      expect(findings[1]!.details).toMatchObject({ readers: { 'claude-code reader 1': 1, 'codex reader 1': 1 }, latest: [`${attempt}/1111111111111111`, `${attempt}/2222222222222222`] });
      expect(findings[2]!.details).toMatchObject({ readers: { 'claude-code reader 1': 1 }, latest: [`${attempt}/3333333333333333`] });
      // With or without transcripts to read, the statistics are the same: they come from the tracker and the machine-local store alone.
      expect(capture(without)).toEqual(capture(withTranscripts));
    } finally {
      await removeDir(configDir);
      await removeDir(empty);
    }
  });

  test('a clean capture history shows no capture finding', async ({ world, grimoire: _grimoire }) => {
    const report = await runDoctor({ root: world.a.dir });

    expect(capture(report)).toEqual({ findings: [], checks: [{ check: 'capture.stats', section: 'capture', status: 'ok' }] });
  });
});

describe('doctor --readers', () => {
  test('reads only the transcripts whose cwd is inside this repo, a revealed root’s included, and reports structure statistics only', async ({ world }) => {
    const claudeDir = await makeTempDir('grimoire-claude-config-');
    const revealedDir = await makeTempDir('grimoire-claude-revealed-');
    const codexHome = await makeTempDir('grimoire-codex-home-');
    try {
      const slug = path.resolve(world.a.dir).replace(/[^a-zA-Z0-9]/g, '-');
      const project = path.join(claudeDir, 'projects', slug);
      // The subagent-commit session ran in this repo: its main line and its subagent.
      await movedTranscript(`${SUBAGENT_COMMIT}/${SESSION}.jsonl`, path.join(project, `${SESSION}.jsonl`), 'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-gok156\\proj', world.a.dir);
      await cp(fixturePath(`${SUBAGENT_COMMIT}/${SESSION}`), path.join(project, SESSION), { recursive: true });
      // A session that ran elsewhere, in a folder whose name starts like this repo's: never read.
      await cp(fixturePath('claude-code/transcripts/plain/0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5.jsonl'), path.join(claudeDir, 'projects', `${slug}-other`, '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5.jsonl'));
      // A config folder only a hook revealed, holding one more session of this repo (spike A's subagent session, moved here).
      const revealedProject = path.join(revealedDir, 'projects', slug);
      await movedTranscript(
        'claude-code/transcripts/subagent/0e195270-803a-4006-be3c-4af4e288c343.jsonl',
        path.join(revealedProject, '0e195270-803a-4006-be3c-4af4e288c343.jsonl'),
        'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-spike-a\\proj',
        world.a.dir,
      );
      const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
      await store.records.write('transcript-roots', '0e195270-803a-4006-be3c-4af4e288c343', {
        client: 'claude-code',
        session: '0e195270-803a-4006-be3c-4af4e288c343',
        transcript_path: path.join(revealedProject, '0e195270-803a-4006-be3c-4af4e288c343.jsonl'),
        root: revealedProject,
        at: '2026-10-12T06:00:00.000Z',
      });
      // Codex: the child thread ran in this repo, the root thread elsewhere.
      const day = path.join(codexHome, 'sessions', '2026', '10', '11');
      await movedTranscript(CODEX_CHILD, path.join(day, path.basename(CODEX_CHILD)), 'C:\\Users\\USER\\AppData\\Local\\Temp\\gok130\\repos\\b1', world.a.dir);
      await cp(fixturePath(CODEX_ROOT), path.join(day, path.basename(CODEX_ROOT)));

      const report = await runDoctor({ root: world.a.dir, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome }, readers: true });

      const { findings, checks } = capture(report);
      expect(checks.map((run) => [run.check, run.status])).toEqual([
        ['capture.stats', 'ok'],
        ['capture.readers', 'findings'],
      ]);
      const stats = findings.filter((finding) => finding.kind === 'reader-stats').map((finding) => finding.details as Record<string, any>);
      expect(stats.map((entry) => [entry.client, entry.transcripts, entry.unreadable])).toEqual([
        ['claude-code', 3, 0],
        ['codex', 1, 0],
      ]);
      expect(stats[0]!.client_versions).toEqual(['2.1.296']);
      expect(stats[0]!.steps.tool_call).toBeGreaterThan(0);
      expect(stats[0]!.steps.subagent_launch).toBe(2);
      expect(stats[0]!.lines.read).toBeGreaterThan(0);
      expect(stats[1]!.client_versions).toEqual(['0.162.1']);
      // Structure only: no path, prompt, tool output or commit text.
      const shown = JSON.stringify(findings);
      for (const text of ['Add sub', 'dba2f59', 'git log', 'gr-72222222222222222pq', world.a.dir, JSON.stringify(world.a.dir).slice(1, -1)]) expect(shown).not.toContain(text);
    } finally {
      await removeDir(claudeDir);
      await removeDir(revealedDir);
      await removeDir(codexHome);
    }
  });

  test('is skipped in none mode: no transcript is opened', async ({ world, grimoire: _grimoire }) => {
    await setExcerptMode(world.a, 'none');

    const report = await runDoctor({ root: world.a.dir, readers: true });

    expect(capture(report).checks).toEqual([
      { check: 'capture.stats', section: 'capture', status: 'ok' },
      { check: 'capture.readers', section: 'capture', status: 'skipped', why: 'the excerpt mode on this machine is none: grimoire never opens a transcript' },
    ]);
  });

  // A plain git world, not coreTest's: there clone a starts with a tracker.
  gitTest('is skipped when this machine caps the mode at none before the clone has a tracker: no transcript is opened', async ({ world }) => {
    expect(await trackerTips(world.a.dir)).toEqual({ local: null, remotes: new Map() });
    const claudeDir = await makeTempDir('grimoire-claude-config-');
    try {
      const project = path.join(claudeDir, 'projects', path.resolve(world.a.dir).replace(/[^a-zA-Z0-9]/g, '-'));
      await movedTranscript(`${SUBAGENT_COMMIT}/${SESSION}.jsonl`, path.join(project, `${SESSION}.jsonl`), 'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-gok156\\proj', world.a.dir);
      await putMachineSetting(path.join(world.a.dir, '.git'), 'capture.excerpts_max', 'none');

      const report = await runDoctor({ root: world.a.dir, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: claudeDir }, readers: true });

      const { findings, checks } = capture(report);
      expect(checks.find((run) => run.check === 'capture.readers')).toEqual({
        check: 'capture.readers',
        section: 'capture',
        status: 'skipped',
        why: 'the excerpt mode on this machine is none: grimoire never opens a transcript',
      });
      expect(findings.filter((finding) => finding.kind === 'reader-stats')).toEqual([]);
    } finally {
      await removeDir(claudeDir);
    }
  });
});
