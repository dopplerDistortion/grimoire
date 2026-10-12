// Seam 1 (spec §14 Facts: Read, facts_complete; Pending session records):
// the attempt-end cut fills each session record's skill reads from the
// context's whole window, the subagents launched in it, and this machine's
// `skill_read` events; in `none` mode only the events count. Real Codex and
// Claude Code transcripts stand in for the clients': their call ids stand in
// for the ids of the grimoire calls the tests make.
import { createHash } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { fixturePath, makeTempDir, removeDir } from '#harness';
import type { CallContext, Core } from '../../src/core';
import {
  CLAUDE_AGENT,
  CLAUDE_SESSION,
  CLAUDE_TX,
  DEBRIEF,
  MAIN_CALL,
  captureOf,
  claudeCall,
  codexCall,
  codexHomeWith,
  created,
  sessionRecords,
  setExcerptMode,
  test,
} from './capture-support';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Spike F's copy, which its Codex thread read through the shell. */
const TIDEWATER = [
  '---',
  'name: tidewater-ledger',
  'description: Reconcile the tidewater ledger files in this repo. Use when the user asks to reconcile, balance or settle the tidewater ledger.',
  '---',
  '',
  'Write ledger/tidewater.md with one line: marker GRIM-B2-COPY-READ.',
  '',
].join('\n');
const TIDEWATER_THREAD = '01a1295a-7c36-71b2-af4a-412ac1a31b9a';
const TIDEWATER_ROLLOUT = `rollout-2026-10-11T08-05-58-${TIDEWATER_THREAD}.jsonl`;

/** Spike C's copy, which its Claude Code session read with `Read`. */
const CHANGELOG = [
  '---',
  'name: changelog-entry',
  'description: Add a changelog entry or release note for a change in this repo. Use when the user asks to record, log or note a change, fix or feature in the changelog or release notes.',
  '---',
  '',
  '# Changelog entries',
  '',
  'This repo does not edit CHANGELOG.md by hand; it is generated at release time.',
  '',
  'To record a change, create one new file `changes/<kebab-slug>.md` containing exactly:',
  '',
  '```',
  'kind: <fix|feat|chore>',
  'summary: <one line, imperative mood>',
  'marker: GRIM-P2-COPY-READ',
  '```',
  '',
  'The `marker` line must be copied exactly. Do not touch CHANGELOG.md.',
  '',
].join('\n');

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

async function edit(core: Core, ctx: CallContext, name: string, text: string): Promise<string> {
  const result = await core.call('skill_edit', { name, text, base: null }, terminal(ctx));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result.version;
}

describe('skill reads in session records', () => {
  test('a Codex thread that read the copy through the shell, and called skill_read, gets both reads with their versions; its facts are complete', async ({
    world,
    grimoire,
    capture,
  }) => {
    const codex = await codexHomeWith('codex/transcripts/skill-stub-read', TIDEWATER_ROLLOUT);
    try {
      const core = capture.makeCore({ capture: { codexHome: codex.home } });
      const version = await edit(core, grimoire.ctx, 'tidewater-ledger', TIDEWATER);
      expect(version).toBe(sha256(TIDEWATER));
      capture.at('2026-10-11T05:05:59.100Z');
      const id = await created(core, grimoire.ctx, 'Reconcile');
      // The thread's stub read stands in for its claim, the copy rewrite for its close.
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_3_0', TIDEWATER_THREAD));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T05:05:59.500Z');
      expect(await core.call('skill_read', { name: 'tidewater-ledger' }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_read', TIDEWATER_THREAD))).toMatchObject({
        ok: true,
      });
      capture.at('2026-10-11T05:06:00.050Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_6_0', TIDEWATER_THREAD));

      expect(closed).toMatchObject({ ok: true });
      const [record] = await sessionRecords(world.a, id, attempt);
      expect(record!.fields).toMatchObject({ facts: 'scanned' });
      expect(record!.fields.skills_read).toEqual([
        { name: 'tidewater-ledger', version, via: 'shell', at: '2026-10-11T05:05:59.283Z', session: TIDEWATER_THREAD, context: TIDEWATER_THREAD },
        { name: 'tidewater-ledger', version, via: 'skill_read', at: '2026-10-11T05:05:59.500Z', session: TIDEWATER_THREAD, context: TIDEWATER_THREAD },
      ]);
      expect((await captureOf(world.a, attempt)).facts_complete).toBe(true);
    } finally {
      await removeDir(codex.home);
    }
  });

  test('in none mode no transcript is opened: only skill_read events count, and the facts are incomplete', async ({ world, grimoire, capture }) => {
    const codex = await codexHomeWith('codex/transcripts/skill-stub-read', TIDEWATER_ROLLOUT);
    try {
      await setExcerptMode(world.a, 'none');
      const core = capture.makeCore({ capture: { codexHome: codex.home } });
      const version = await edit(core, grimoire.ctx, 'tidewater-ledger', TIDEWATER);
      capture.at('2026-10-11T05:05:59.100Z');
      const id = await created(core, grimoire.ctx, 'Reconcile');
      const claim = await core.call('claim', { id }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_3_0', TIDEWATER_THREAD));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T05:05:59.500Z');
      await core.call('skill_read', { name: 'tidewater-ledger' }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_read', TIDEWATER_THREAD));
      capture.at('2026-10-11T05:06:00.050Z');

      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, codexCall(grimoire.ctx, TIDEWATER_THREAD, 'call_6_0', TIDEWATER_THREAD));

      const [record] = await sessionRecords(world.a, id, attempt);
      expect(record!.fields).toMatchObject({ excerpt: 'off', facts: 'events_only' });
      expect(record!.fields.skills_read).toEqual([
        { name: 'tidewater-ledger', version, via: 'skill_read', at: '2026-10-11T05:05:59.500Z', session: TIDEWATER_THREAD, context: TIDEWATER_THREAD },
      ]);
      expect((await captureOf(world.a, attempt)).facts_complete).toBe(false);
    } finally {
      await removeDir(codex.home);
    }
  });

  test('the scan covers subagents launched in the window: a subagent that read the copy gives a read in its own context', async ({
    world,
    grimoire,
    capture,
  }) => {
    // The subagent session, its one subagent's transcript being spike C's session that read the copy.
    const configDir = await makeTempDir('grimoire-claude-config-');
    try {
      const project = path.join(configDir, 'projects', 'C--Users-user-proj');
      const subagents = path.join(project, CLAUDE_SESSION, 'subagents');
      await mkdir(subagents, { recursive: true });
      await cp(fixturePath(`${CLAUDE_TX}/${CLAUDE_SESSION}.jsonl`), path.join(project, `${CLAUDE_SESSION}.jsonl`));
      await cp(fixturePath(`${CLAUDE_TX}/${CLAUDE_SESSION}/subagents/agent-${CLAUDE_AGENT}.meta.json`), path.join(subagents, `agent-${CLAUDE_AGENT}.meta.json`));
      await cp(fixturePath('claude-code/transcripts/stub-match-read-tool.jsonl'), path.join(subagents, `agent-${CLAUDE_AGENT}.jsonl`));
      const core = capture.makeCore({ capture: { claudeConfigDir: configDir } });
      const version = await edit(core, grimoire.ctx, 'changelog-entry', CHANGELOG);
      capture.at('2026-10-11T03:27:17.500Z');
      const id = await created(core, grimoire.ctx, 'Changelog');
      const claim = await core.call('claim', { id }, claudeCall(grimoire.ctx, MAIN_CALL));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const { attempt } = claim.result;
      capture.at('2026-10-11T03:27:30.000Z');

      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close_not_flushed'));

      const [record] = await sessionRecords(world.a, id, attempt);
      expect(record!.fields).toMatchObject({ context: 'main', facts: 'scanned' });
      expect(record!.fields.skills_read).toEqual([
        { name: 'changelog-entry', version, via: 'file', at: '2026-10-11T03:21:37.110Z', session: CLAUDE_SESSION, context: CLAUDE_AGENT },
      ]);
    } finally {
      await removeDir(configDir);
    }
  });
});
