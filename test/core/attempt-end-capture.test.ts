// Seam 1 (spec Testing Decisions; §14 Cut at attempt end, Pending session
// records, Statuses; §3 The attempt directory; §19): every attempt-ending op
// cuts the bound contexts that ran on this machine and seals their session
// records, `end.md` and the outcome in one commit. Real Claude Code and Codex
// transcripts from the seam-2 fixtures stand in for the clients' transcripts:
// their tool-use ids stand in for the ids of the grimoire calls the tests make.
import { readFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { fixturePath, makeTempDir, removeDir, type Checkout } from '#harness';
import type { CallContext, Core, CoreOptions } from '../../src/core';
import { openTracker } from '../../src/tracker';
import { coreTest, TRACKER_REF, trackerFile, trackerTip } from './support';

/** Claude Code's spike-A subagent session: the main line launched one subagent, which called grimoire. */
const CLAUDE_SESSION = '0e195270-803a-4006-be3c-4af4e288c343';
const CLAUDE_AGENT = 'aa0434c9616245e9e';
const CLAUDE_TX = 'claude-code/transcripts/subagent';
/** The main line's `Agent` launch, and the subagent's `mcp__grimoire__show` (standing in for grimoire writes). */
const MAIN_CALL = 'toolu_01BWyzp3ee5Q6rwGmHjUoyey';
const SUBAGENT_CALL = 'toolu_01RgZkxkBkrfVmCHWzxZ2nWH';

/** A seam-2 golden excerpt (test/client-contract/golden/). */
const golden = (name: string) => readFileSync(new URL(`../client-contract/golden/${name}.excerpt.txt`, import.meta.url), 'utf8');

const DEBRIEF = { asked: 'Show gr-5', tried: 'A subagent', failed: 'none', worked: 'It showed it', next: 'none' };

/** A Claude Code `projects/` tree holding the fixture sessions, as `$CLAUDE_CONFIG_DIR` would. */
async function claudeConfigDir(...sessions: { folder: string; session: string }[]): Promise<string> {
  const dir = await makeTempDir('grimoire-claude-config-');
  const project = path.join(dir, 'projects', 'C--Users-user-proj');
  await mkdir(project, { recursive: true });
  for (const { folder, session } of sessions) {
    await cp(fixturePath(`${folder}/${session}.jsonl`), path.join(project, `${session}.jsonl`));
    await cp(fixturePath(`${folder}/${session}`), path.join(project, session), { recursive: true }).catch(() => {});
  }
  return dir;
}

/** A Claude Code MCP call from `session`'s main line (or a subagent), with the hook's hint matching `_meta`. */
function claudeCall(base: CallContext, toolUseId: string, agentId?: string): CallContext {
  const hint = {
    session_id: CLAUDE_SESSION,
    tool_use_id: toolUseId,
    ...(agentId !== undefined ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  };
  return {
    ...base,
    client: { name: 'claude-code', version: '2.1.296' },
    evidence: {},
    mcp: { era: 'modern', hint, meta: { 'claudecode/toolUseId': toolUseId } },
    nonce: 'nonce-claude',
  };
}

/** Sets the store's excerpt mode, as `init` or a human's `settings set excerpts` would. */
async function setExcerptMode(checkout: Checkout, mode: 'excerpts' | 'facts' | 'none'): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact(
      { op: 'settings-set', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'human', client: 'cli', nonce: 'n' } },
      (draft) => {
        draft.putSetting('excerpts', mode, 'alice@example.com');
        return { result: null };
      },
    );
  } finally {
    await tracker.close();
  }
}

/** A session record as committed: its frontmatter values by key, and its body. */
interface StoredRecord {
  readonly name: string;
  readonly fields: Record<string, unknown>;
  readonly body: string;
}

function parseRecord(name: string, text: string): StoredRecord {
  expect(text.startsWith('---\n')).toBe(true);
  const close = text.indexOf('\n---\n', 3);
  const fields: Record<string, unknown> = {};
  for (const line of text.slice(4, close).split('\n')) {
    const colon = line.indexOf(': ');
    fields[line.slice(0, colon)] = JSON.parse(line.slice(colon + 2));
  }
  return { name, fields, body: text.slice(close + 5) };
}

const attemptDir = (id: string, attempt: string) => `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;

/** The session records of `attempt` at the tracker tip. */
async function sessionRecords(checkout: Checkout, id: string, attempt: string): Promise<StoredRecord[]> {
  const tip = (await trackerTip(checkout))!;
  const dir = `${attemptDir(id, attempt)}/sessions`;
  const listed = await checkout.gitResult(['ls-tree', '--name-only', `${tip}:${dir}`]);
  if (listed.code !== 0) return [];
  const names = listed.stdout.split('\n').filter(Boolean);
  return Promise.all(names.map(async (name) => parseRecord(name, await trackerFile(checkout, tip, `${dir}/${name}`))));
}

async function created(core: Core, ctx: CallContext, title: string): Promise<string> {
  const outcome = await core.call('create', { title }, ctx);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.result.id;
}

/** `coreTest` plus a Claude Code config dir holding the subagent session, and a core whose capture searches it. */
const test = coreTest.extend('capture', async ({ world, grimoire }, { onCleanup }) => {
  const configDir = await claudeConfigDir({ folder: CLAUDE_TX, session: CLAUDE_SESSION });
  onCleanup(() => removeDir(configDir));
  let now = new Date('2026-10-11T03:27:17.500Z');
  const options = (extra: CoreOptions = {}): CoreOptions => ({
    clock: () => now,
    capture: { claudeConfigDir: configDir, codexHome: path.join(configDir, 'no-codex'), flushWaitMs: 50, ...extra.capture },
    ...extra,
  });
  await setExcerptMode(world.a, 'excerpts');
  return {
    configDir,
    core: grimoire.makeCore(options()),
    makeCore: (extra: CoreOptions = {}) => grimoire.makeCore(options(extra)),
    at: (iso: string) => {
      now = new Date(iso);
    },
  };
});

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
  });
});
