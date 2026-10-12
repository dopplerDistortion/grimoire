// Shared by the attempt-end capture tests (attempt-end-capture.test.ts and its
// serial, wall-clock half attempt-end-capture.slow.test.ts): the fixture
// transcripts, the calls that stand in for the clients, and the `capture` fixture.
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { FIXTURES_DIR, fixturePath, makeTempDir, removeDir, type Checkout } from '#harness';
import type { CallContext, Core, CoreOptions } from '../../src/core';
import { traceCapture, type TraceCapture } from '../../src/core/capture';
import { openTracker } from '../../src/tracker';
import { coreTest, trackerFile, trackerTip } from './support';

/** Claude Code's spike-A subagent session: the main line launched one subagent, which called grimoire. */
export const CLAUDE_SESSION = '0e195270-803a-4006-be3c-4af4e288c343';
export const CLAUDE_AGENT = 'aa0434c9616245e9e';
export const CLAUDE_TX = 'claude-code/transcripts/subagent';
/** The main line's `Agent` launch, and the subagent's `mcp__grimoire__show` (standing in for grimoire writes). */
export const MAIN_CALL = 'toolu_01BWyzp3ee5Q6rwGmHjUoyey';
export const SUBAGENT_CALL = 'toolu_01RgZkxkBkrfVmCHWzxZ2nWH';

/** A seam-2 golden excerpt (test/client-contract/golden/). */
export const golden = (name: string) => readFileSync(new URL(`../client-contract/golden/${name}.excerpt.txt`, import.meta.url), 'utf8');

export const DEBRIEF = { asked: 'Show gr-5', tried: 'A subagent', failed: 'none', worked: 'It showed it', next: 'none' };

/** A Claude Code `projects/` tree holding the fixture sessions, as `$CLAUDE_CONFIG_DIR` would. */
export async function claudeConfigDir(...sessions: { folder: string; session: string }[]): Promise<string> {
  const dir = await makeTempDir('grimoire-claude-config-');
  const project = path.join(dir, 'projects', 'C--Users-user-proj');
  await mkdir(project, { recursive: true });
  for (const { folder, session } of sessions) {
    await cp(fixturePath(`${folder}/${session}.jsonl`), path.join(project, `${session}.jsonl`));
    // Its subagents' own transcripts, when it has any.
    const subagents = path.join(FIXTURES_DIR, folder, session);
    if (existsSync(subagents)) await cp(subagents, path.join(project, session), { recursive: true });
  }
  return dir;
}

/** A Claude Code MCP call from the subagent session's main line (or its subagent), with the hook's hint matching `_meta`. */
export function claudeCall(base: CallContext, toolUseId: string, agentId?: string): CallContext {
  return claudeCallIn(base, CLAUDE_SESSION, toolUseId, agentId === undefined ? undefined : { id: agentId, type: 'general-purpose' });
}

/** A Claude Code MCP call from `session`'s main line, or one of its subagents, with the hook's hint matching `_meta`. */
export function claudeCallIn(base: CallContext, session: string, toolUseId: string, agent?: { id: string; type?: string }): CallContext {
  const hint = {
    session_id: session,
    tool_use_id: toolUseId,
    ...(agent !== undefined ? { agent_id: agent.id, ...(agent.type !== undefined ? { agent_type: agent.type } : {}) } : {}),
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
export async function setExcerptMode(checkout: Checkout, mode: 'excerpts' | 'facts' | 'none'): Promise<void> {
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
export interface StoredRecord {
  readonly name: string;
  readonly fields: Record<string, unknown>;
  readonly body: string;
}

export function parseRecord(name: string, text: string): StoredRecord {
  expect(text.startsWith('---\n')).toBe(true);
  const close = text.indexOf('\n---\n', 3);
  const fields: Record<string, unknown> = {};
  for (const line of text.slice(4, close).split('\n')) {
    const colon = line.indexOf(': ');
    fields[line.slice(0, colon)] = JSON.parse(line.slice(colon + 2));
  }
  return { name, fields, body: text.slice(close + 5) };
}

export const attemptDir = (id: string, attempt: string) => `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;

/** The session records of `attempt` at the tracker tip. */
export async function sessionRecords(checkout: Checkout, id: string, attempt: string): Promise<StoredRecord[]> {
  const tip = (await trackerTip(checkout))!;
  const dir = `${attemptDir(id, attempt)}/sessions`;
  const listed = await checkout.gitResult(['ls-tree', '--name-only', `${tip}:${dir}`]);
  if (listed.code !== 0) return [];
  const names = listed.stdout.split('\n').filter(Boolean);
  return Promise.all(names.map(async (name) => parseRecord(name, await trackerFile(checkout, tip, `${dir}/${name}`))));
}

/** The capture of `attempt` as the core derives it from the tracker in `checkout`. */
export async function captureOf(checkout: Checkout, attempt: string): Promise<TraceCapture> {
  const tracker = await openTracker(checkout.dir);
  try {
    return await traceCapture(await tracker.read(), attempt);
  } finally {
    await tracker.close();
  }
}

export async function created(core: Core, ctx: CallContext, title: string): Promise<string> {
  const outcome = await core.call('create', { title }, ctx);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.result.id;
}

/** `coreTest` plus a Claude Code config dir holding the subagent session, and a core whose capture searches it. */
export const test = coreTest.extend('capture', async ({ world, grimoire }, { onCleanup }) => {
  const configDir = await claudeConfigDir(
    { folder: CLAUDE_TX, session: CLAUDE_SESSION },
    { folder: 'claude-code/transcripts/plain', session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5' },
    { folder: 'claude-code/transcripts/chore-fork', session: CHORE_SESSION },
  );
  onCleanup(() => removeDir(configDir));
  let now = new Date('2026-10-11T03:27:17.500Z');
  // The temp folder holding the config dir stands in for the home folder: roots read `~/<config dir>/projects`.
  const options = (extra: CoreOptions = {}): CoreOptions => ({
    ...extra,
    clock: () => now,
    capture: {
      claudeConfigDir: configDir,
      codexHome: path.join(configDir, 'no-codex'),
      home: path.dirname(configDir),
      flushWaitMs: 50,
      ...extra.capture,
    },
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

/** Claims `id` from Claude Code's main line as call `toolUseId`; returns the handle. */
export async function claimed(core: Core, ctx: CallContext, id: string, toolUseId = MAIN_CALL): Promise<string> {
  const claim = await core.call('claim', { id }, claudeCall(ctx, toolUseId));
  if (!claim.ok) throw new Error(JSON.stringify(claim.error));
  return claim.result.attempt;
}

/** Spike C's Claude Code run: the main line ran the grimoire-chores skill, forked into a grimoire-chores subagent. */
export const CHORE_SESSION = 'c2eb58d9-ccb7-4978-bc0e-35f624a5266b';
export const CHORE_SUBAGENT = 'a523fef26307d8241';
/** The main line's `Skill` call, and the chores subagent's `ToolSearch`. */
export const CHORE_SKILL_CALL = 'toolu_01P6XhbCSzNqUtZ7B5KhAP3x';
export const CHORE_SUBAGENT_CALL = 'toolu_01UQtAtS3Z9HVgYgWDEF4TFq';

/** Claude Code's spike-A plain session: one turn, whose one write on the issue is `mcp__grimoire__comment` (call PLAIN_COMMENT). */
export const PLAIN_SESSION = '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5';
export const PLAIN_COMMENT = 'toolu_01FGkSuaFCkBXSzKt8JWTnv7';

/** A person at their own terminal: no transcript, no debrief needed. */
export function person(base: CallContext): CallContext {
  return { ...base, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
}

/** A Claude Code MCP call from the plain session's main line carrying only the given evidence. */
export function plainCall(base: CallContext, mcp: CallContext['mcp'], evidence: CallContext['evidence'] = {}): CallContext {
  return { ...base, client: { name: 'claude-code', version: '2.1.296' }, evidence, ...(mcp ? { mcp } : {}), nonce: 'nonce-plain' };
}

/** Codex's spike-E subagent session: the root thread spawned one child thread, both under a scripted model. */
export const CODEX_ROOT = '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72';
export const CODEX_CHILD = '01a12947-16a2-7152-be00-4e4b1e12a4d8';
export const CODEX_TX = 'codex/transcripts/subagent';

/** A Codex MCP call from `thread` of the root session, as call `callId` (Codex runs no grimoire hook: `_meta` only). */
export function codexCall(base: CallContext, thread: string, callId: string, session = CODEX_ROOT): CallContext {
  return {
    ...base,
    client: { name: 'codex-mcp-client', version: '0.162.1' },
    evidence: {},
    mcp: { era: 'legacy', hint: null, meta: { sessionId: session, threadId: thread, callId } },
    nonce: 'nonce-codex',
  };
}

/** A Codex home whose `sessions/2026/10/11/` holds the named rollouts of a fixture folder. */
export async function codexHomeWith(folder: string, ...rollouts: string[]): Promise<{ home: string; day: string }> {
  const home = await makeTempDir('grimoire-codex-home-');
  const day = path.join(home, 'sessions', '2026', '10', '11');
  await mkdir(day, { recursive: true });
  for (const name of rollouts) await cp(fixturePath(`${folder}/${name}`), path.join(day, name));
  return { home, day };
}
