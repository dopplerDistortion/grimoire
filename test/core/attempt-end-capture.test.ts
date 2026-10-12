// Seam 1 (spec Testing Decisions; §14 Cut at attempt end, Pending session
// records, Statuses; §3 The attempt directory; §19): every attempt-ending op
// cuts the bound contexts that ran on this machine and seals their session
// records, `end.md` and the outcome in one commit. Real Claude Code and Codex
// transcripts from the seam-2 fixtures stand in for the clients' transcripts:
// their tool-use ids stand in for the ids of the grimoire calls the tests make.
import { existsSync, renameSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { fixturePath, makeTempDir, removeDir, type Checkout } from '#harness';
import { seenHereRows, sessionKey, type SeenHereRow } from '../../src/capture/seen-here';
import { registerSweep } from '../../src/capture/sweeps';
import { recordRevealedRoot } from '../../src/capture/transcript-roots';
import type { CallContext, Core, CoreOptions } from '../../src/core';
import { putMachineSetting } from '../../src/core/settings';
import { MachineLocalStore } from '../../src/machine-local';
import { createScanner } from '../../src/scanner';
import { agentContext, commitToTracker, fetchTracker, pushTracker, TRACKER_REF, trackerFile, trackerTip } from './support';
import { CLAUDE_SESSION, CLAUDE_AGENT, MAIN_CALL, SUBAGENT_CALL, golden, DEBRIEF, claudeConfigDir, claudeCall, claudeCallIn, setExcerptMode, type StoredRecord, attemptDir, sessionRecords, captureOf, created, test, claimed, CHORE_SESSION, CHORE_SUBAGENT, CHORE_SKILL_CALL, CHORE_SUBAGENT_CALL, PLAIN_SESSION, PLAIN_COMMENT, person, plainCall, CODEX_ROOT, CODEX_CHILD, CODEX_TX, codexCall, codexHomeWith } from './capture-support';

describe('closing an attempt', () => {
  test('claim → update (with the handle) from a subagent → close seals one session record per bound context, each cut from its own transcript, in the one commit that writes end.md', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Show gr-5');
    const claim = await core.call('claim', { id }, claudeCall(grimoire.ctx, MAIN_CALL));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:27:20.300Z');
    const update = await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    expect(update.ok).toBe(true);
    const beforeClose = (await trackerTip(world.a))!;
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_not_flushed'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done', outcome: 'pass' } });
    // One commit: end.md, the outcome and both session records.
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--count', `${beforeClose}..${TRACKER_REF}`])).toBe('1');
    const changed = (await world.a.git(['diff', '--name-only', beforeClose, tip])).split('\n');
    expect(changed).toEqual(expect.arrayContaining([`${attemptDir(id, attempt)}/end.md`]));
    const records = await sessionRecords(world.a, id, attempt);
    expect(records).toHaveLength(2);
    for (const record of records) expect(changed).toContain(`${attemptDir(id, attempt)}/sessions/${record.name}`);

    const main = records.find((r) => r.fields.context === 'main')!;
    const subagent = records.find((r) => r.fields.context === CLAUDE_AGENT)!;
    expect(main.fields).toMatchObject({
      client: 'claude-code',
      client_version: '2.1.296',
      reader_version: 1,
      session: CLAUDE_SESSION,
      source: 'hint',
      excerpt: 'cut',
      // The close call hadn't reached the transcript: the cut stops at its flushed end.
      excerpt_notes: ['tail_unflushed'],
      facts: 'scanned',
      skills_read: [],
      commits: [],
    });
    // The main line shows the subagent only as its launch and result.
    expect(main.body).toContain('tool Agent');
    expect(main.body).not.toContain('tool mcp__grimoire__show');
    // The subagent passed the handle: its own transcript is cut (the seam-2 golden excerpt of it).
    expect(subagent.fields).toMatchObject({ session: CLAUDE_SESSION, source: 'hint', excerpt: 'cut', excerpt_notes: [] });
    expect(subagent.body).toBe(golden('claude-code/subagent'));
    expect(subagent.fields.reach).toEqual({ at: '2026-10-11T03:27:22.005Z', ref: expect.any(String) });
    expect(subagent.fields).toMatchObject({ steps: 8, steps_kept: 8, characters: subagent.body.length });

    // end.md stays attempt-level only.
    const end = await trackerFile(world.a, tip, `${attemptDir(id, attempt)}/end.md`);
    const endKeys = end.split('\n').filter((line) => line.includes(': ')).map((line) => line.slice(0, line.indexOf(':')));
    expect(endKeys).toEqual(['ended', 'ended_by', 'at', 'debrief', 'worker_kind', 'wiki_exposed', 'field_changes']);
    // Per-context entries and facts_complete are read from the session records.
    const trace = await captureOf(world.a, attempt);
    expect(trace.contexts.map((c) => [c.context, c.excerpt.status, c.facts])).toEqual(
      expect.arrayContaining([
        ['main', 'cut', 'scanned'],
        [CLAUDE_AGENT, 'cut', 'scanned'],
      ]),
    );
    expect(trace.facts_complete).toBe(true);
    // Each cut's reach is noted on its context's seen-here row.
    const rows = await seenHereRows(new MachineLocalStore(path.join(world.a.dir, '.git')), { handle: attempt });
    expect(rows.find((row) => row.context === CLAUDE_AGENT)!.reach).toEqual(subagent.fields.reach);
    expect(rows.find((row) => row.context === 'main')!.reach).toEqual(main.fields.reach);
  });
});

describe('capture problems are statuses, never errors', () => {
  test('a transcript that can’t be found gives a not_found placeholder naming the roots searched; the close succeeds', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Nowhere');
    const lost = (toolUseId: string): CallContext => {
      const ctx = claudeCall(grimoire.ctx, toolUseId);
      return { ...ctx, mcp: { ...ctx.mcp!, hint: { session_id: 'ffffffff-0000-4000-8000-000000000000', tool_use_id: toolUseId } } };
    };
    const claim = await core.call('claim', { id }, lost('toolu_lost_claim'));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt: claim.result.attempt, debrief: DEBRIEF }, lost('toolu_lost_close'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const [record] = await sessionRecords(world.a, id, claim.result.attempt);
    expect(record!.fields).toMatchObject({
      session: 'ffffffff-0000-4000-8000-000000000000',
      context: 'main',
      excerpt: 'not_found',
      facts: 'not_found',
      window_start: null,
      reach: null,
      roots: [`~${path.sep}${path.basename(capture.configDir)}${path.sep}projects`],
    });
    expect(record!.body).toBe('');
    // A context whose facts weren't scanned leaves the trace's facts incomplete: read unknown.
    expect((await captureOf(world.a, claim.result.attempt)).facts_complete).toBe(false);
  });

  test('a scanner that can’t run drops the excerpt with status unscanned; the rest of the record is written and the close succeeds', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore({ scanner: createScanner([]) });
    const id = await created(core, grimoire.ctx, 'Unscanned');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({ excerpt: 'unscanned', facts: 'scanned', steps_kept: 0, characters: 0 });
    expect(record!.fields.window_start).toMatchObject({ at: '2026-10-11T03:27:15.900Z' });
    expect(record!.body).toBe('');
  });
});

describe('replays', () => {
  test('replaying the close answers replayed: true without cutting again, and makes no second commit', async ({ world, grimoire, capture }) => {
    // The spec's 2 s flush wait: a cut of the calling context waits it out, since its close call never reaches the transcript.
    const core = capture.makeCore({ capture: { flushWaitMs: 2_000 } });
    const id = await created(core, grimoire.ctx, 'Replayed');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    const close = { id, reason: 'done' as const, attempt, debrief: DEBRIEF };
    expect(await core.call('close', close, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    const sealed = await trackerTip(world.a);

    const started = Date.now();
    const replay = await core.call('close', close, claudeCall(grimoire.ctx, 'toolu_close_retry'));
    const took = Date.now() - started;

    expect(replay).toMatchObject({ ok: true, result: { replayed: true, ended: 'done', attempt } });
    expect(took).toBeLessThan(1_500);
    expect(await trackerTip(world.a)).toBe(sealed);
    expect(await sessionRecords(world.a, id, attempt)).toHaveLength(1);
  });
});

describe('the excerpt mode', () => {
  test('in facts mode, records carry the entry and the facts but no excerpt text: status off', async ({ world, grimoire, capture }) => {
    await setExcerptMode(world.a, 'facts');
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Facts only');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      client: 'claude-code',
      session: CLAUDE_SESSION,
      context: 'main',
      excerpt: 'off',
      facts: 'scanned',
      skills_read: [],
      commits: [],
      steps_kept: 0,
      characters: 0,
      window_start: { at: '2026-10-11T03:27:15.900Z', ref: expect.any(String) },
    });
    expect(record!.fields.steps).toBeGreaterThan(0);
    expect(record!.fields.reach).toMatchObject({ at: expect.any(String) });
    expect(record!.body).toBe('');
  });
});

/** The main line's key, and a good earlier cut of it reaching `reach` (as a sweep leaves one waiting with the open attempt). */
function storedCut(reach: { at: string; ref: string }): { key: string; bytes: string } {
  const key = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: 'main', nonce: 'nonce-claude' });
  const bytes = [
    '---',
    'client: "claude-code"',
    'client_version: "2.1.296"',
    'reader_version: 1',
    `session: "${CLAUDE_SESSION}"`,
    'context: "main"',
    'source: "hint"',
    'window_start: {"at":"2026-10-11T03:27:15.900Z","ref":"a"}',
    `window_end: ${JSON.stringify(reach)}`,
    'steps: 1',
    'steps_kept: 1',
    'characters: 10',
    'excerpt: "cut"',
    'excerpt_notes: []',
    'facts: "scanned"',
    'skills_read: []',
    'commits: []',
    `reach: ${JSON.stringify(reach)}`,
    'cut_at: "2026-10-11T03:27:17.000Z"',
    'roots: []',
    '---',
    'user:\n | an earlier excerpt\n',
  ].join('\n');
  return { key, bytes };
}

describe('a stored record', () => {
  /** Claims as `claimCall`, stores an earlier cut reaching `reach`, closes; returns the record the seal left. */
  async function sealedOver(
    capture: { makeCore: (extra?: CoreOptions) => Core; at: (iso: string) => void },
    base: CallContext,
    checkout: Checkout,
    reach: { at: string; ref: string },
    options: { claimCall?: string; core?: CoreOptions } = {},
  ): Promise<{ key: string; record: StoredRecord }> {
    const core = capture.makeCore(options.core);
    const id = await created(core, base, 'Stored');
    const attempt = await claimed(core, base, id, options.claimCall);
    const stored = storedCut(reach);
    await commitToTracker(checkout, { [`${attemptDir(id, attempt)}/sessions/${stored.key}.md`]: stored.bytes });
    capture.at('2026-10-11T03:27:30.000Z');
    const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(base, 'toolu_close'));
    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    const records = await sessionRecords(checkout, id, attempt);
    expect(records).toHaveLength(1);
    return { key: stored.key, record: records[0]! };
  }

  test('a later cut that fails (unreadable) never replaces a good stored record: the seal keeps it, noted source: pending', async ({
    world,
    grimoire,
    capture,
  }) => {
    // A claim call the transcript doesn't hold, made inside its parsed range: the cut can't trust the reader.
    const { key, record } = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' }, { claimCall: 'toolu_never_written' });

    expect(record.name).toBe(`${key}.md`);
    expect(record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach: { at: '2026-10-11T03:27:16.000Z', ref: 'b' } });
    expect(record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('nor does one that reached further but lost its excerpt (unscanned)', async ({ world, grimoire, capture }) => {
    const { record } = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' }, { core: { scanner: createScanner([]) } });

    expect(record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'] });
    expect(record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('a good cut reaching strictly further replaces it; one reaching no further leaves its text, noted source: pending', async ({ world, grimoire, capture }) => {
    const further = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' });
    // The cut's last step is the main line's final assistant text, at 03:27:22.041 or before.
    const behind = await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:59.000Z', ref: 'z' });

    expect(further.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['tail_unflushed'] });
    expect(further.record.body).toContain('tool Agent');
    expect(behind.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach: { at: '2026-10-11T03:27:59.000Z', ref: 'z' } });
    expect(behind.record.body).toBe('user:\n | an earlier excerpt\n');
  });

  test('a good cut reaching exactly as far doesn’t replace it either: only strictly further does', async ({ world, grimoire, capture }) => {
    // How far a cut of the main line reaches, from a seal over a record it passed.
    const reach = (await sealedOver(capture, grimoire.ctx, world.a, { at: '2026-10-11T03:27:16.000Z', ref: 'b' })).record.fields.reach as { at: string; ref: string };

    const level = await sealedOver(capture, grimoire.ctx, world.a, reach);

    expect(level.record.fields).toMatchObject({ excerpt: 'cut', excerpt_notes: ['source: pending'], reach });
    expect(level.record.body).toBe('user:\n | an earlier excerpt\n');
  });
});

describe('Codex', () => {
  test('each thread that passed the handle is cut from its own rollout, found by thread id in the Codex home a hook revealed', async ({
    world,
    grimoire,
    capture,
  }) => {
    // The rollouts live in a Codex home only a hook's transcript_path names: the default home is elsewhere.
    const codexHome = await makeTempDir('grimoire-codex-home-');
    const day = path.join(codexHome, 'sessions', '2026', '10', '11');
    await mkdir(day, { recursive: true });
    const rootFile = `rollout-2026-10-11T07-44-45-${CODEX_ROOT}.jsonl`;
    await cp(fixturePath(`${CODEX_TX}/${rootFile}`), path.join(day, rootFile));
    await cp(fixturePath(`${CODEX_TX}/rollout-2026-10-11T07-44-47-${CODEX_CHILD}.jsonl`), path.join(day, `rollout-2026-10-11T07-44-47-${CODEX_CHILD}.jsonl`));
    try {
      const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
      await recordRevealedRoot(machine, { client: 'codex', session: CODEX_ROOT, transcriptPath: path.join(day, rootFile) });
      const core = capture.makeCore();
      capture.at('2026-10-11T04:44:47.100Z');
      const id = await created(core, grimoire.ctx, 'Codex work');
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_2_0'));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T04:44:47.340Z');
      await core.call('update', { id, labels_add: ['read'], attempt }, codexCall(grimoire.ctx, CODEX_CHILD, 'call_5_0'));
      capture.at('2026-10-11T04:44:47.800Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, CODEX_ROOT, 'call_8_0'));

      expect(closed).toMatchObject({ ok: true });
      const records = await sessionRecords(world.a, id, attempt);
      expect(records).toHaveLength(2);
      const root = records.find((r) => r.fields.context === CODEX_ROOT)!;
      const child = records.find((r) => r.fields.context === CODEX_CHILD)!;
      expect(root.fields).toMatchObject({ client: 'codex', client_version: '0.162.1', session: CODEX_ROOT, source: 'meta', excerpt: 'cut', excerpt_notes: [] });
      expect(child.fields).toMatchObject({ session: CODEX_ROOT, source: 'meta', excerpt: 'cut', reach: { at: '2026-10-11T04:44:47.685Z', ref: expect.stringMatching(/^\d+$/) } });
      // The seam-2 goldens: the root keeps the child only as its launch, result and wait. (How much a trim cuts
      // depends on the paths the goldens rewrote: the spike's home and repo, not this test's.)
      const trims = (text: string) => text.replace(/\[… \d+ chars trimmed …\]/g, '[… trimmed …]');
      expect(trims(root.body)).toBe(trims(golden('codex/subagent-root')));
      expect(trims(child.body)).toBe(trims(golden('codex/subagent')));
    } finally {
      await removeDir(codexHome);
    }
  });
});

/** Spike F's Codex run: the root thread spawned the grimoire-chores role, whose thread called chore_start. */
const CHORE_ROOT = '01a12968-6f96-78e2-aef8-4da11543207e';
const CHORE_THREAD = '01a12968-71aa-7fe1-a70d-7745aa7feacd';
const CHORE_TX = 'codex/transcripts/chore-role';

describe('chore contexts', () => {
  test('a Codex chore thread that bound with the handle is excluded from excerpts and fact scans: it gets no session record', async ({
    world,
    grimoire,
    capture,
  }) => {
    const codex = await codexHomeWith(
      CHORE_TX,
      `rollout-2026-10-11T08-21-12-${CHORE_ROOT}.jsonl`,
      `rollout-2026-10-11T08-21-13-${CHORE_THREAD}.jsonl`,
    );
    try {
      const core = capture.makeCore({ capture: { codexHome: codex.home } });
      capture.at('2026-10-11T05:21:12.900Z');
      const id = await created(core, grimoire.ctx, 'Chores');
      // The root's first call stands in for its claim; the chore thread's chore_start for an update naming the handle.
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, CHORE_ROOT, 'call_1_0', CHORE_ROOT));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T05:21:13.450Z');
      expect(await core.call('update', { id, labels_add: ['chore'], attempt }, codexCall(grimoire.ctx, CHORE_THREAD, 'call_8_0', CHORE_ROOT))).toMatchObject({
        ok: true,
      });
      capture.at('2026-10-11T05:21:13.600Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, CHORE_ROOT, 'call_close', CHORE_ROOT));

      expect(closed).toMatchObject({ ok: true });
      const records = await sessionRecords(world.a, id, attempt);
      expect(records.map((r) => [r.fields.context, r.fields.excerpt])).toEqual([[CHORE_ROOT, 'cut']]);
      // Nothing of the chore thread's own steps (its apply_patch, its chore_start) is in the trace.
      expect(records[0]!.body).not.toMatch(/^tool (?:apply_patch|mcp__grimoire__chore_start)$/m);
      expect((await captureOf(world.a, attempt)).contexts.map((c) => c.context)).toEqual([CHORE_ROOT]);
    } finally {
      await removeDir(codex.home);
    }
  });
});

describe('chore subagents', () => {
  test('a Claude Code grimoire-chores subagent that bound with the handle gets no session record: its own transcript names its type', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    capture.at('2026-10-11T03:23:41.500Z');
    const id = await created(core, grimoire.ctx, 'Claude chores');
    const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, CHORE_SESSION, CHORE_SKILL_CALL));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:23:43.450Z');
    // The hint names no agent type: only the subagent's own .meta.json says it is a chores subagent.
    const fromChores = claudeCallIn(grimoire.ctx, CHORE_SESSION, CHORE_SUBAGENT_CALL, { id: CHORE_SUBAGENT });
    expect(await core.call('comment', { id, body: 'chore', attempt }, fromChores)).toMatchObject({ ok: true });
    capture.at('2026-10-11T03:23:52.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, CHORE_SESSION, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context])).toEqual([[CHORE_SESSION, 'main']]);
  });

  test('nor does a calling context its validated hint names a grimoire-chores subagent, even with no transcript to read', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const lost = 'ffffffff-0000-4000-8000-000000000000';
    const id = await created(core, grimoire.ctx, 'Chores close');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call(
      'close',
      { id, reason: 'done', attempt, debrief: DEBRIEF },
      claudeCallIn(grimoire.ctx, lost, 'toolu_chores_close', { id: 'a0000000000000001', type: 'grimoire-chores' }),
    );

    expect(closed).toMatchObject({ ok: true });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context])).toEqual([[CLAUDE_SESSION, 'main']]);
  });
});

describe('the other attempt-ending ops', () => {
  test('a human’s abandoned release binds nothing, so only the bound agent contexts are cut', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const human: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Abandoned');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    capture.at('2026-10-11T03:27:30.000Z');

    const released = await core.call('release', { id, attempt, abandoned: true }, human);

    expect(released).toMatchObject({ ok: true, result: { ended: 'release-abandoned', outcome: 'fail' } });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.context, r.fields.excerpt]).sort()).toEqual([
      ['aa0434c9616245e9e', 'cut'],
      ['main', 'cut'],
    ]);
  });

  test('a reassign cuts the bound agent contexts; the person reassigning is no agent context, so gets no record', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const human: CallContext = { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Handed over');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    const reassigned = await core.call('reassign', { id, assignee: world.b.identity.email }, human);

    expect(reassigned).toMatchObject({ ok: true, result: { ended: attempt } });
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.client, r.fields.context, r.fields.excerpt, r.fields.facts])).toEqual([['claude-code', 'main', 'cut', 'scanned']]);
    // The attempt it opened has no bound context yet.
    const opened = (reassigned as { ok: true; result: { attempt: string } }).result.attempt;
    expect(await sessionRecords(world.a, id, opened)).toEqual([]);
  });

  test('a reopen supersedes an attempt a fold left open: its context, bound only on the other side of the fold, gets a placeholder', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const bobCore = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Closed here, claimed there');
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const mine = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');
    await core.call('close', { id, reason: 'done', attempt: mine, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    const bobClaim = await bobCore.call('claim', { id }, agentContext(world.b));
    if (!bobClaim.ok) throw new Error(JSON.stringify(bobClaim.error));
    const bobs = bobClaim.result.attempt;
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const reopened = await core.call('reopen', { id, comment: 'Bob is still on it.' }, person(grimoire.ctx));

    expect(reopened).toMatchObject({ ok: true });
    // Bob's claim is only on the remote tip: this machine has no row for his context, so it isn't cut.
    const records = await sessionRecords(world.a, id, bobs);
    expect(records.map((r) => r.fields)).toEqual([
      expect.objectContaining({ client: 'claude-code', session: 'sess-1', context: 'main', excerpt: 'not_found', facts: 'not_found', roots: [], reach: null }),
    ]);
    expect((await captureOf(world.a, bobs)).facts_complete).toBe(false);
  });
});

describe('an unclaimed close', () => {
  test('cuts its own context into the instant attempt it opens and seals in one commit', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Done without a claim');
    const before = (await trackerTip(world.a))!;
    capture.at('2026-10-11T03:27:30.000Z');

    // The Agent launch stands in for the close call: the attempt opens and ends with it.
    const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, claudeCall(grimoire.ctx, MAIN_CALL));

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done', outcome: 'pass' } });
    expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    const attempt = (closed as { ok: true; result: { attempt: string } }).result.attempt;
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => [r.fields.session, r.fields.context, r.fields.excerpt, r.fields.excerpt_notes])).toEqual([[CLAUDE_SESSION, 'main', 'cut', []]]);
    expect(records[0]!.body).toContain('tool Agent');
  });

  test('whose call never reaches the transcript in time finds no window: nothing was scanned, so its facts are partial', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Not flushed');
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done', debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_never_flushed'));

    expect(closed).toMatchObject({ ok: true });
    const attempt = (closed as { ok: true; result: { attempt: string } }).result.attempt;
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      session: CLAUDE_SESSION,
      excerpt: 'cut',
      excerpt_notes: ['tail_unflushed'],
      facts: 'partial',
      window_start: null,
      steps: 0,
      reach: null,
    });
    expect(record!.body).toBe('');
    expect((await captureOf(world.a, attempt)).facts_complete).toBe(false);
  });

  test('by a person at their terminal leaves no session record: a person is no agent context', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Done by hand');
    capture.at('2026-10-11T03:27:30.000Z');

    const closed = await core.call('close', { id, reason: 'done' }, { ...grimoire.ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' });

    expect(closed).toMatchObject({ ok: true, result: { ended: 'done' } });
    expect(await sessionRecords(world.a, id, (closed as { ok: true; result: { attempt: string } }).result.attempt)).toEqual([]);
  });
});

describe('which contexts are cut', () => {
  test('a bound context with no seen-here row on this machine isn’t cut: the seal writes a placeholder naming no roots', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore();
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Elsewhere');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    // The subagent's row is gone (as if it had bound on another machine).
    const subagentKey = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: CLAUDE_AGENT, nonce: 'nonce-claude' });
    expect(await machine.coordination.remove('seen-here', `${attempt}/${subagentKey}`)).toBe(true);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.find((r) => r.name === `${subagentKey}.md`)!.fields).toMatchObject({
      context: CLAUDE_AGENT,
      excerpt: 'not_found',
      facts: 'not_found',
      roots: [],
      reach: null,
    });
    expect(records.find((r) => r.fields.context === 'main')!.fields).toMatchObject({ excerpt: 'cut' });
  });

  test('an attempt-ending call cancels the sweeps running in its process before it cuts', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Swept');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    // The subagent's own transcript is away until the sweep is cancelled: a cut made before that can't find it.
    const subagents = path.join(capture.configDir, 'projects', 'C--Users-user-proj', CLAUDE_SESSION);
    renameSync(subagents, `${subagents}.away`);
    let cancelled = 0;
    const done = registerSweep(() => {
      cancelled++;
      renameSync(`${subagents}.away`, subagents);
    });
    capture.at('2026-10-11T03:27:30.000Z');

    try {
      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));
    } finally {
      done();
      if (existsSync(`${subagents}.away`)) renameSync(`${subagents}.away`, subagents);
    }

    expect(cancelled).toBe(1);
    const records = await sessionRecords(world.a, id, attempt);
    expect(records.find((r) => r.fields.context === CLAUDE_AGENT)!.fields).toMatchObject({ excerpt: 'cut' });
  });

  test('a context whose record a human purged is skipped: no record is written, and the trace lists it purged', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Purged');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:20.300Z');
    await core.call('update', { id, labels_add: ['shown'], attempt }, claudeCall(grimoire.ctx, SUBAGENT_CALL, CLAUDE_AGENT));
    const subagentKey = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: CLAUDE_AGENT, nonce: 'nonce-claude' });
    await commitToTracker(world.a, { [`purges/${attempt}/${subagentKey}.md`]: '---\nby: "alice@example.com"\nat: "2026-10-11T03:27:25.000Z"\n---\n' });
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    expect(records.map((r) => r.fields.context)).toEqual(['main']);
    expect(records.map((r) => r.name)).not.toContain(`${subagentKey}.md`);
    const trace = await captureOf(world.a, attempt);
    expect(trace.contexts.map((c) => [c.key, c.excerpt.status, c.facts])).toEqual(
      expect.arrayContaining([[subagentKey, 'purged', 'purged']]),
    );
    expect(trace.contexts).toHaveLength(2);
    expect(trace.facts_complete).toBe(false);
  });
});

/**
 * A person claims; a Claude Code context comments naming the handle at the
 * time the plain session made its comment call, carrying `ctx`'s evidence;
 * the person closes. Returns the comment context's session record.
 */
async function commentedFrom(
  capture: { makeCore: (extra?: CoreOptions) => Core; at: (iso: string) => void },
  base: CallContext,
  checkout: Checkout,
  ctx: CallContext,
  times = { claim: '2026-10-11T03:30:00.000Z', comment: '2026-10-11T03:30:40.051Z', close: '2026-10-11T03:30:45.000Z' },
): Promise<StoredRecord | undefined> {
  const core = capture.makeCore();
  capture.at(times.claim);
  const id = await created(core, base, 'Commented');
  const claim = await core.call('claim', { id }, person(base));
  if (!claim.ok) throw new Error(JSON.stringify(claim.error));
  const { attempt } = claim.result;
  capture.at(times.comment);
  expect(await core.call('comment', { id, body: 'done', attempt }, ctx)).toMatchObject({ ok: true });
  capture.at(times.close);
  expect(await core.call('close', { id, reason: 'done', attempt }, person(base))).toMatchObject({ ok: true });
  return (await sessionRecords(checkout, id, attempt)).find((r) => r.fields.client === 'claude-code');
}

describe('identity checked against the transcript at cut time', () => {
  test('a hint that came with no _meta counts once its session’s transcript holds its tool-use id', async ({ world, grimoire, capture }) => {
    const hint = { session_id: PLAIN_SESSION, tool_use_id: PLAIN_COMMENT };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'legacy', hint, meta: null }));

    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'hint', excerpt: 'cut' });
    expect(record!.body).toContain('tool mcp__grimoire__comment');
  });

  test('a context’s paths are rewritten against the worktree its row says it worked in, not the closing call’s', async ({ world, grimoire, capture }) => {
    // The plain session ran in spike A's probe repo: a linked worktree of the repo, as far as this test goes.
    const probe = 'C:\\Users\\user\\AppData\\Local\\Temp\\grimoire-spike-a\\proj';
    const core = capture.makeCore();
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    capture.at('2026-10-11T03:30:00.000Z');
    const id = await created(core, grimoire.ctx, 'Another worktree');
    const claim = await core.call('claim', { id }, person(grimoire.ctx));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    capture.at('2026-10-11T03:30:40.051Z');
    const hint = { session_id: PLAIN_SESSION, tool_use_id: PLAIN_COMMENT };
    const commenting = plainCall(grimoire.ctx, { era: 'modern', hint, meta: { 'claudecode/toolUseId': PLAIN_COMMENT } });
    expect(await core.call('comment', { id, body: 'done', attempt }, commenting)).toMatchObject({ ok: true });
    const key = sessionKey({ client: 'claude-code', session: PLAIN_SESSION, context: 'main', nonce: 'nonce-plain' });
    await machine.coordination.update<SeenHereRow>('seen-here', `${attempt}/${key}`, (row) => (row ? { ...row, worktree: probe } : undefined));
    capture.at('2026-10-11T03:30:45.000Z');

    expect(await core.call('close', { id, reason: 'done', attempt }, person(grimoire.ctx))).toMatchObject({ ok: true });

    const record = (await sessionRecords(world.a, id, attempt)).find((r) => r.fields.client === 'claude-code')!;
    expect(record.fields).toMatchObject({ session: PLAIN_SESSION, excerpt: 'cut' });
    expect(record.body).toContain(' | file_path: <repo>\\README.md');
    expect(record.body).not.toContain(probe);
  });

  test('a pending hint whose tool-use id its transcript doesn’t hold claims nothing', async ({ world, grimoire, capture }) => {
    const forged = { session_id: PLAIN_SESSION, tool_use_id: 'toolu_never_made' };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'legacy', hint: forged, meta: null }));

    expect(record!.fields).toMatchObject({ session: null, source: null, excerpt: 'not_found' });
  });

  test('a _meta tool-use id alone is joined to the transcript that holds it', async ({ world, grimoire, capture }) => {
    const meta = { 'claudecode/toolUseId': PLAIN_COMMENT };
    const record = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, { era: 'modern', hint: null, meta }));

    expect(record!.fields).toMatchObject({ session: PLAIN_SESSION, context: 'main', source: 'tool-use-id', excerpt: 'cut' });
  });

  test('the spawn-env session is trusted only if its transcript holds the call', async ({ world, grimoire, capture }) => {
    const trusted = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, undefined, { spawnEnvId: PLAIN_SESSION }));
    // The subagent session's main line made no comment call around then, inside its flushed range.
    const wrong = await commentedFrom(capture, grimoire.ctx, world.a, plainCall(grimoire.ctx, undefined, { spawnEnvId: CLAUDE_SESSION }), {
      claim: '2026-10-11T03:27:00.000Z',
      comment: '2026-10-11T03:27:19.000Z',
      close: '2026-10-11T03:27:30.000Z',
    });

    expect(trusted!.fields).toMatchObject({ session: PLAIN_SESSION, source: 'spawn-env', excerpt: 'cut' });
    expect(wrong!.fields).toMatchObject({ session: CLAUDE_SESSION, source: 'spawn-env', excerpt: 'unmatched', facts: 'unmatched', reach: null });
  });
});

describe('modes that open no transcript, or commit no text', () => {
  test('in none mode no transcript is opened: facts-only records, reaching the context’s latest skill_read event plus the event count', async ({
    world,
    grimoire,
    capture,
  }) => {
    await setExcerptMode(world.a, 'none');
    // No transcript anywhere: a cut that looked would say not_found.
    const core = capture.makeCore({ capture: { claudeConfigDir: path.join(capture.configDir, 'nothing-here') } });
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'No transcripts');
    const attempt = await claimed(core, grimoire.ctx, id);
    // Two skill_read events of the claiming context (the shape skill_read appends), and one of another session.
    const actor = { kind: 'agent', client: 'claude-code', session: CLAUDE_SESSION, context: 'main', call: 'toolu_read', nonce: 'nonce-claude' };
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:18.000Z', actor, nonce: 'nonce-claude' });
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:21.000Z', actor, nonce: 'nonce-claude' });
    await machine.records.append('skill-reads', {
      skill: 'other',
      version: 'b'.repeat(64),
      at: '2026-10-11T03:27:25.000Z',
      actor: { ...actor, session: 'someone-else' },
      nonce: 'nonce-other',
    });
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      session: CLAUDE_SESSION,
      context: 'main',
      excerpt: 'off',
      excerpt_notes: [],
      facts: 'events_only',
      reader_version: null,
      window_start: null,
      reach: { at: '2026-10-11T03:27:21.000Z', ref: '2' },
    });
    expect(record!.body).toBe('');
  });

  test('this machine’s capture.excerpts_max lowers the store’s mode for its own cuts: status off, noted capped', async ({ world, grimoire, capture }) => {
    await putMachineSetting(path.join(world.a.dir, '.git'), 'capture.excerpts_max', 'facts');
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'Capped');
    const attempt = await claimed(core, grimoire.ctx, id);
    capture.at('2026-10-11T03:27:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'));

    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({ excerpt: 'off', excerpt_notes: ['tail_unflushed', 'capped'], facts: 'scanned', characters: 0 });
    expect(record!.body).toBe('');
  });
});
