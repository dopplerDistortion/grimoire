// Seam 1 (spec Testing Decisions; §14 Binding, Identity is observed, Seen-here
// rows; §3 Commits): every write records observed identity on its
// `Grimoire-Actor` trailer, and a context binds to an attempt only through a
// write that names the attempt's handle (`Grimoire-Attempt`). Each binding
// write leaves a seen-here row on this machine.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { readFixtureJson, type Checkout } from '#harness';
import { boundContexts, readBindings, type Binding } from '../../src/capture/bindings';
import { noteCutReach, seenHereRows, sessionKey } from '../../src/capture/seen-here';
import { recordRevealedRoot } from '../../src/capture/transcript-roots';
import type { CallContext, Core, McpCallFacts } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import { clientIn, evidenceIn } from '../../src/surfaces/cli/shell';
import { metaIds, takeHint } from '../../src/surfaces/mcp/hint';
import { openTracker } from '../../src/tracker';
import type { AttemptRecord } from '../../src/tracker/attempt';
import { coreTest as test, expectRefUnmoved, T0, trackerFile, trackerTip, TRACKER_REF } from './support';

interface ToolsCall {
  params: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}

/** The facts the MCP surface takes from a real `tools/call` (fixture path), with `hint` as its reserved key. */
function factsOf(fixture: string, hint?: unknown): McpCallFacts {
  const { params } = readFixtureJson<ToolsCall>(fixture);
  const args = hint === undefined ? params.arguments : { ...params.arguments, _grimoire: hint };
  return { era: 'legacy', hint: takeHint(args).hint, meta: params._meta ? metaIds(params._meta) : null };
}

/** An MCP call in `base`'s checkout, from `client`, carrying `mcp`. */
function mcpContext(base: CallContext, client: string, mcp: McpCallFacts, spawnEnvId?: string): CallContext {
  return {
    ...base,
    client: { name: client },
    evidence: spawnEnvId ? { spawnEnvId } : {},
    mcp,
    nonce: 'nonce-mcp',
  };
}

/** The Grimoire-Actor trailer of the tracker tip, parsed. */
async function tipActor(checkout: Checkout): Promise<Record<string, string>> {
  const value = await checkout.git(['log', '-1', '--format=%(trailers:key=Grimoire-Actor,valueonly,unfold)', TRACKER_REF]);
  return JSON.parse(value) as Record<string, string>;
}

/** The spike-era hint Claude Code really sent, with its transcript path (fixture claude-code/meta/tools-call.json). */
const claudeHint = () => readFixtureJson<ToolsCall>('claude-code/meta/tools-call.json').params.arguments!._grimoire_hint as Record<string, string>;

describe('Grimoire-Actor: observed identity, ids only', () => {
  test("a Claude Code call whose hint matches _meta records the hint's session, the context and the call", async ({ world, grimoire }) => {
    const ctx = mcpContext(grimoire.ctx, 'claude-code', factsOf('claude-code/meta/tools-call.json', claudeHint()), 'spawn-1');

    await grimoire.core.call('create', { title: 'Hinted' }, ctx);

    expect(await tipActor(world.a)).toEqual({
      kind: 'agent',
      client: 'claude-code',
      session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5',
      context: 'main',
      call: 'toolu_015PCZBt35Z3Yy1hx37HDZqV',
      spawn_env: 'spawn-1',
      nonce: 'nonce-mcp',
    });
  });

  test("a hint whose tool_use_id doesn't match _meta claims nothing: the actor keeps _meta's call id and the spawn env", async ({ world, grimoire }) => {
    const forged = { session_id: 'someone-else', tool_use_id: 'toolu_guessed', agent_id: 'a9', agent_type: 'grimoire-chores' };
    const ctx = mcpContext(grimoire.ctx, 'claude-code', factsOf('claude-code/meta/tools-call.json', forged), 'spawn-1');

    await grimoire.core.call('create', { title: 'Forged' }, ctx);

    expect(await tipActor(world.a)).toEqual({
      kind: 'agent',
      client: 'claude-code',
      call: 'toolu_015PCZBt35Z3Yy1hx37HDZqV',
      spawn_env: 'spawn-1',
      nonce: 'nonce-mcp',
    });
  });

  test("a Codex subagent thread's call records the root session, its own thread as the context, and the call id", async ({ world, grimoire }) => {
    const ctx = mcpContext(grimoire.ctx, 'codex-mcp-client', factsOf('codex/meta/tools-call-subagent.json'));

    await grimoire.core.call('create', { title: 'From a Codex subagent' }, ctx);

    expect(await tipActor(world.a)).toEqual({
      kind: 'agent',
      client: 'codex-mcp-client',
      session: '01a12947-11cf-7fd1-8ece-b3d7fe5a6e72',
      context: '01a12947-16a2-7152-be00-4e4b1e12a4d8',
      call: 'call_5_0',
      nonce: 'nonce-mcp',
    });
  });

  test('trailers never contain filesystem paths, whatever the evidence held', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const pathy = 'C:\\Users\\user\\.claude\\projects\\C--x\\0b95f7c0.jsonl';
    const contexts: CallContext[] = [
      // Claude Code's real hinted call, its hint in the spike-era shape that held the transcript path.
      mcpContext(grimoire.ctx, 'claude-code', factsOf('claude-code/meta/tools-call.json', claudeHint()), '/home/user/.claude/session'),
      // Codex's real call, whose turn metadata holds absolute workspace paths.
      mcpContext(grimoire.ctx, 'codex-mcp-client', factsOf('codex/meta/tools-call.json')),
      // A generic client calling itself by a path, and a hint and _meta made of paths.
      mcpContext(grimoire.ctx, '/usr/local/bin/some-client', {
        era: 'modern',
        hint: { session_id: pathy, tool_use_id: '~/call' },
        meta: { 'claudecode/toolUseId': '~/call', threadId: 'D:/x' },
      }),
      // An agent's shell whose env names paths.
      { ...grimoire.ctx, surface: 'cli', client: { name: 'claude-code' }, evidence: { agentMarkers: ['AI_AGENT'], session: pathy, context: '/tmp/x', callId: 'C:x' } },
    ];
    const ids: string[] = [];
    for (const ctx of contexts) {
      const created = await core.call('create', { title: 'Paths stay out' }, ctx);
      expect(created.ok).toBe(true);
      if (created.ok) ids.push(created.result.id);
      const claimed = await core.call('claim', { id: ids.at(-1)! }, ctx);
      expect(claimed.ok).toBe(true);
    }

    const trailers = await world.a.git(['log', '--format=%(trailers:only,unfold)', TRACKER_REF]);
    expect(trailers).toMatch(/Grimoire-Attempt: at-/);
    for (const line of trailers.split('\n').filter(Boolean)) {
      expect(line, line).not.toMatch(/[\\/]|\b[A-Za-z]:[^ "]|~/);
    }
    // The ids survive: the hinted call still names its session and call.
    expect(trailers).toContain('"session":"0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5"');
    expect(trailers).toContain('"client":"mcp"');
    expect(await trackerTip(world.a)).not.toBeNull();
  });
});

const DEBRIEF = { asked: 'Fix the redirect', tried: 'Patched the guard', failed: 'none', worked: 'Reordering', next: 'none' };

/** A Claude Code call from the main line of session `0b95f7c0…`, as call `toolUseId`, with the hook's hint. */
function claudeMain(base: CallContext, toolUseId: string, agent?: { agent_id: string; agent_type: string }): CallContext {
  const hint = { session_id: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', tool_use_id: toolUseId, ...agent };
  return mcpContext(base, 'claude-code', { era: 'modern', hint, meta: { 'claudecode/toolUseId': toolUseId } }, 'spawn-1');
}

/**
 * A CLI call from Claude Code's Bash tool in session `0b95f7c0…`, observed from
 * the env spike A recorded for it: the shell names the session, never a context.
 */
function claudeShell(base: CallContext): CallContext {
  const env = {
    AI_AGENT: 'claude-code_2-1-296_agent',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5',
  };
  return { ...base, surface: 'cli', client: clientIn(env), evidence: evidenceIn(env), tty: false, nonce: 'nonce-cli' };
}

async function created(core: Core, ctx: CallContext, title: string): Promise<string> {
  const outcome = await core.call('create', { title }, ctx);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.result.id;
}

async function claimed(core: Core, ctx: CallContext, id: string): Promise<string> {
  const outcome = await core.call('claim', { id }, ctx);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.result.attempt;
}

describe('seen-here rows', () => {
  test('every binding write leaves a row on this machine: one per attempt and context, holding its ids, worktree, times and transcript path', async ({ world, grimoire }) => {
    let now = T0;
    const core = grimoire.makeCore({ clock: () => now });
    const later = new Date(T0.getTime() + 5 * 60_000);
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    // The hook revealed this session's transcript earlier.
    const transcript = 'C:\\Users\\user\\.claude\\projects\\C--repo\\0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5.jsonl';
    await recordRevealedRoot(machine, { client: 'claude-code', session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', transcriptPath: transcript });
    const id = await created(core, grimoire.ctx, 'Seen here');

    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);
    now = later;
    await core.call('update', { id, title: 'Seen here, retitled', attempt }, claudeMain(grimoire.ctx, 'toolu_update'));
    await core.call('comment', { id, body: 'From a subagent', attempt }, claudeMain(grimoire.ctx, 'toolu_sub', { agent_id: 'a77', agent_type: 'general-purpose' }));

    const rows = await seenHereRows(machine);
    expect(rows).toHaveLength(2);
    const main = rows.find((row) => row.context === 'main')!;
    expect(main).toEqual({
      handle: attempt,
      issue: id,
      client: 'claude-code',
      session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5',
      context: 'main',
      call: 'toolu_update',
      spawn_env: 'spawn-1',
      nonce: 'nonce-mcp',
      source: 'hint',
      pending_hint: null,
      worktree: world.a.dir,
      // The first binding write seen here, and the latest.
      at: T0.toISOString(),
      last_at: later.toISOString(),
      path: transcript,
      reach: null,
    });
    expect(rows.find((row) => row.context === 'a77')).toMatchObject({ handle: attempt, call: 'toolu_sub', session: main.session, path: transcript });
    expect(await seenHereRows(machine, { handle: 'at-zzzzzz' })).toEqual([]);
  });

  test('a show, a write without a handle and an abandoned release bind nothing: no Grimoire-Attempt trailer, no row', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const human = { ...grimoire.ctx, surface: 'cli' as const, client: null, evidence: {}, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Activity only');
    const attempt = await claimed(core, human, id);
    const before = await seenHereRows(machine);
    const tipBefore = await trackerTip(world.a);

    const agent = claudeMain(grimoire.ctx, 'toolu_activity');
    expect(await core.call('show', { ref: id }, agent)).toMatchObject({ ok: true });
    expect(await core.call('update', { id, labels_add: ['triaged'] }, agent)).toMatchObject({ ok: true });
    expect(await core.call('comment', { id, body: 'Drive-by' }, agent)).toMatchObject({ ok: true });
    expect(await core.call('release', { id, attempt, abandoned: true }, agent)).toMatchObject({ ok: true, result: { ended: 'release-abandoned' } });

    const log = await world.a.git(['log', '--format=%(trailers:key=Grimoire-Op,valueonly,separator=)|%(trailers:key=Grimoire-Attempt,valueonly,separator=)', `${tipBefore}..${TRACKER_REF}`]);
    expect(log.split('\n').filter(Boolean).sort()).toEqual(['comment|', 'release|', 'update|']);
    expect(await seenHereRows(machine)).toEqual(before);
    expect(before.map((row) => row.client)).toEqual(['cli']);
  });

  test('a replayed write moves no ref and leaves no row; a failed binding write neither', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Replayed');
    const first = claudeMain(grimoire.ctx, 'toolu_first');
    const claim = await core.call('claim', { id, idempotency_key: 'k-1' }, first);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    const rows = await seenHereRows(machine);

    await expectRefUnmoved(world.a, async () => {
      expect(await core.call('claim', { id, idempotency_key: 'k-1' }, claudeMain(grimoire.ctx, 'toolu_retry'))).toMatchObject({
        ok: true,
        result: { replayed: true, attempt },
      });
      // Failing inside the compare-and-set round: a handle that isn't this issue's, and a done without its debrief.
      const wrong = { id, reason: 'done' as const, attempt: 'at-zzzzzz', debrief: DEBRIEF };
      expect(await core.call('close', wrong, claudeMain(grimoire.ctx, 'toolu_wrong'))).toMatchObject({ ok: false, error: { code: 'NOT_ASSIGNEE' } });
      expect(await core.call('close', { id, reason: 'done', attempt }, claudeMain(grimoire.ctx, 'toolu_bare'))).toMatchObject({
        ok: false,
        error: { code: 'DEBRIEF_REQUIRED' },
      });
    });

    expect(await seenHereRows(machine)).toEqual(rows);
    expect(rows.map((row) => row.call)).toEqual(['toolu_first']);
  });

  test('a hinted call with no _meta to check the hint against claims nothing now: its row keeps the hint for a later cut', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const hint = { session_id: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', tool_use_id: 'toolu_unchecked' };
    const ctx = mcpContext(grimoire.ctx, 'claude-code', { era: 'legacy', hint, meta: null }, 'spawn-1');
    const id = await created(core, grimoire.ctx, 'Pending hint');

    const attempt = await claimed(core, ctx, id);

    // The trailer carries nothing the hint said.
    expect(await tipActor(world.a)).toEqual({ kind: 'agent', client: 'claude-code', spawn_env: 'spawn-1', nonce: 'nonce-mcp' });
    expect(await seenHereRows(machine)).toEqual([
      expect.objectContaining({ handle: attempt, session: null, context: null, call: null, source: 'spawn-env', pending_hint: hint }),
    ]);
  });
});

/** The attempt `handle` as the tracker in `checkout` holds it. */
async function attemptIn(checkout: Checkout, handle: string): Promise<AttemptRecord> {
  const tracker = await openTracker(checkout.dir);
  try {
    const record = (await tracker.read()).attempt(handle);
    if (!record) throw new Error(`no attempt ${handle}`);
    return record;
  } finally {
    await tracker.close();
  }
}

/** `handle`'s bindings, read from the trailers of `checkout`'s tracker. */
async function bindingsIn(checkout: Checkout, handle: string): Promise<Binding[]> {
  return readBindings(checkout.dir, await attemptIn(checkout, handle), [(await trackerTip(checkout))!]);
}

/** A Codex call from thread `thread` of root session `root`, as call `callId` (Codex runs no grimoire hook). */
function codexThread(base: CallContext, root: string, thread: string, callId?: string): CallContext {
  const meta = { sessionId: root, threadId: thread, ...(callId !== undefined ? { callId } : {}) };
  return { ...mcpContext(base, 'codex-mcp-client', { era: 'legacy', hint: null, meta }), nonce: `nonce-${thread}` };
}

describe("a cut's reach on the row", () => {
  test('a cut notes how far it reached on its context’s row, and a later binding write keeps it; no row is made for a context without one', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Reached');
    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);
    const [context] = boundContexts(await bindingsIn(world.a, attempt), await seenHereRows(machine));
    const reach = { at: '2026-10-11T03:20:00.000Z', ref: '6be549fa-035d-4f52-9610-2535d0a4b9de' };

    expect(await noteCutReach(machine, attempt, context!.key, reach)).toBe(true);
    await core.call('comment', { id, body: 'Later', attempt }, claudeMain(grimoire.ctx, 'toolu_later'));
    expect(await noteCutReach(machine, attempt, 'no-such-context', reach)).toBe(false);

    expect(await seenHereRows(machine)).toEqual([expect.objectContaining({ call: 'toolu_later', reach })]);
  });
});

describe('bindings, read from the trailers', () => {
  test("from the start commit onward, filtered by handle: the claim, the writes naming it and the ending call; never a show, a write without it, or another attempt's writes", async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const id = await created(core, grimoire.ctx, 'Bound');
    const other = await created(core, grimoire.ctx, 'Elsewhere');
    const otherAttempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_elsewhere'), other);

    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);
    await core.call('show', { ref: id }, claudeMain(grimoire.ctx, 'toolu_show'));
    await core.call('update', { id, labels_add: ['triaged'] }, claudeMain(grimoire.ctx, 'toolu_unnamed'));
    await core.call('comment', { id: other, body: 'Other attempt', attempt: otherAttempt }, claudeMain(grimoire.ctx, 'toolu_other'));
    await core.call('update', { id, title: 'Bound, retitled', attempt }, claudeMain(grimoire.ctx, 'toolu_update'));
    const subagent = { agent_id: 'a77', agent_type: 'general-purpose' };
    await core.call('comment', { id, body: 'From a subagent', attempt }, claudeMain(grimoire.ctx, 'toolu_sub', subagent));
    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeMain(grimoire.ctx, 'toolu_close'));

    const bindings = await bindingsIn(world.a, attempt);

    expect(bindings.map((b) => [b.op, b.actor.call, b.actor.context])).toEqual([
      ['claim', 'toolu_claim', 'main'],
      ['update', 'toolu_update', 'main'],
      ['comment', 'toolu_sub', 'a77'],
      ['close', 'toolu_close', 'main'],
    ]);
    for (const binding of bindings) {
      expect(binding).toMatchObject({
        attempt,
        issue: id,
        person: world.a.identity.email,
        commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      // Commit times have whole seconds.
      expect(Date.parse(binding.at)).toBe(Math.floor(T0.getTime() / 1000) * 1000);
    }
    expect((await bindingsIn(world.a, otherAttempt)).map((b) => b.op)).toEqual(['claim', 'comment']);
  });

  test('a reassign is an ending call: its commit names the attempt it ended, never the one it opened', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const person = { ...grimoire.ctx, surface: 'cli' as const, client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
    const id = await created(core, grimoire.ctx, 'Handed over');
    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);

    const reassigned = await core.call('reassign', { id, assignee: world.b.identity.email }, person);
    if (!reassigned.ok) throw new Error(JSON.stringify(reassigned.error));

    const bindings = await bindingsIn(world.a, attempt);
    expect(bindings.map((b) => [b.op, b.actor.kind, b.printed])).toEqual([
      ['claim', 'agent', [attempt]],
      ['reassign', 'human', [attempt]],
    ]);
    expect(await bindingsIn(world.a, reassigned.result.attempt)).toEqual([]);
    expect(boundContexts(bindings, []).map((c) => c.writeOnly)).toEqual([false, false]);
  });

  test('an abandoned release binds nothing: the claim stays the only binding write', async ({ world, grimoire }) => {
    const { core } = grimoire;
    const id = await created(core, grimoire.ctx, 'Abandoned');
    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);

    await core.call('release', { id, attempt, abandoned: true }, claudeMain(grimoire.ctx, 'toolu_abandon'));

    expect((await bindingsIn(world.a, attempt)).map((b) => b.op)).toEqual(['claim']);
  });

  test("a takeover binds the same way: the same person's other session names the handle and becomes a bound context, with its own row", async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Taken over');
    const attempt = await claimed(core, codexThread(grimoire.ctx, 'root-1', 'root-1', 'call_claim'), id);

    // Another session of the same person asks for the issue, and names the handle ALREADY_CLAIMED gives it.
    const refused = await core.call('claim', { id }, codexThread(grimoire.ctx, 'root-2', 'root-2', 'call_retry'));
    expect(refused).toMatchObject({ ok: false, error: { code: 'ALREADY_CLAIMED' } });
    const details = (refused as { ok: false; error: { details: Record<string, unknown> } }).error.details;
    const [held] = details.open_attempts as { attempt: string; held_by_you: boolean }[];
    expect(held).toMatchObject({ attempt, held_by_you: true });
    const handle = held!.attempt;
    await core.call('comment', { id, body: 'Taking this over', attempt: handle }, codexThread(grimoire.ctx, 'root-2', 'root-2', 'call_takeover'));
    await core.call('close', { id, reason: 'done', attempt: handle, debrief: DEBRIEF }, codexThread(grimoire.ctx, 'root-2', 'root-2', 'call_close'));

    const contexts = boundContexts(await bindingsIn(world.a, attempt), await seenHereRows(machine));

    expect(
      contexts.map(({ session, context, bindingCalls, writeOnly }) => ({ session, context, calls: bindingCalls.map((c) => c.id), writeOnly })),
    ).toEqual([
      { session: 'root-1', context: 'root-1', calls: ['call_claim'], writeOnly: false },
      { session: 'root-2', context: 'root-2', calls: ['call_takeover', 'call_close'], writeOnly: false },
    ]);
    expect(contexts.map((c) => [c.row?.client, c.row?.call])).toEqual([
      ['codex-mcp-client', 'call_claim'],
      ['codex-mcp-client', 'call_close'],
    ]);
  });

  test('one Claude Code session that claims over MCP and comments through the CLI is one bound context, with one row', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Both surfaces');
    const attempt = await claimed(core, claudeMain(grimoire.ctx, 'toolu_claim'), id);
    expect(await core.call('comment', { id, body: 'From the shell', attempt }, claudeShell(grimoire.ctx))).toMatchObject({ ok: true });

    const contexts = boundContexts(await bindingsIn(world.a, attempt), await seenHereRows(machine));

    expect(
      contexts.map(({ client, session, context, bindings }) => ({ client, session, context, ops: bindings.map((b) => b.op) })),
    ).toEqual([{ client: 'claude-code', session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', context: 'main', ops: ['claim', 'comment'] }]);
    const rows = await seenHereRows(machine);
    expect(rows).toHaveLength(1);
    expect(contexts[0]!.row).toEqual(rows[0]);
    expect(rows[0]).toMatchObject({ context: 'main', nonce: 'nonce-cli', source: 'shell-env' });
  });

  test('a context bound through the CLI: each binding write holds the id its result printed, which is how the cut finds its shell call', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const shell = claudeShell(grimoire.ctx);
    const id = await created(core, grimoire.ctx, 'Through the shell');
    const claim = await core.call('claim', { id }, shell);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const { attempt } = claim.result;
    const comment = await core.call('comment', { id, body: 'Working on it', attempt }, shell);
    const update = await core.call('update', { id, title: 'Through the shell, retitled', attempt }, shell);
    const close = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, shell);
    if (!comment.ok || !update.ok || !close.ok) throw new Error('a binding write failed');

    const bindings = await bindingsIn(world.a, attempt);
    const [context] = boundContexts(bindings, []);

    // What the CLI printed for each write (spec §10: the server-minted write id, or the handle for a claim).
    expect(bindings.map((b) => [b.op, b.printed])).toEqual([
      ['claim', [attempt]],
      ['comment', [comment.result.id]],
      ['update', [update.result.revision]],
      ['close', [close.result.attempt]],
    ]);
    // No call id: the cut finds each call by what it printed, else by its verb, the issue and the time (spec §14 CLI calls).
    expect(context!.bindingCalls).toEqual(bindings.map((b) => ({ grimoire: b.op, printed: b.printed, at: b.at })));
  });

  test('bound contexts: one bound only by update or comment is write-only; a binding without a row is still bound; a row without a matching write is ignored', async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const id = await created(core, grimoire.ctx, 'Rows are hints');
    const attempt = await claimed(core, codexThread(grimoire.ctx, 'root-1', 'root-1', 'call_claim'), id);
    // A Codex subagent thread passing the handle, from a Codex that sends no callId (0.140.0).
    await core.call('update', { id, body_patch: [{ op: 'append', text: '\nnotes' }], attempt }, codexThread(grimoire.ctx, 'root-1', 'sub-1'));
    const rows = await seenHereRows(machine);
    expect(rows.map((row) => row.context).sort()).toEqual(['root-1', 'sub-1']);
    // This machine lost the subagent's row, and holds a row for a write that never landed.
    const subagentRow = rows.find((row) => row.context === 'sub-1')!;
    const subagentKey = sessionKey({ client: 'codex-mcp-client', session: 'root-1', context: 'sub-1', nonce: 'nonce-sub-1' });
    expect(await machine.coordination.remove('seen-here', `${attempt}/${subagentKey}`)).toBe(true);
    const stray = { ...subagentRow, context: 'never-wrote', call: 'call_ghost' };

    const contexts = boundContexts(await bindingsIn(world.a, attempt), [...(await seenHereRows(machine)), stray]);

    expect(contexts).toHaveLength(2);
    const [root, subagent] = contexts;
    expect(root).toMatchObject({ context: 'root-1', writeOnly: false, row: { call: 'call_claim' } });
    expect(subagent).toMatchObject({ session: 'root-1', context: 'sub-1', writeOnly: true, row: null });
    // No call id: the cut finds the call by its operation and the time grimoire saw it (T6's fallback).
    expect(subagent!.bindingCalls).toEqual([
      { grimoire: 'update', printed: [expect.stringMatching(/^[0-9a-f]{64}$/)], at: subagent!.bindings[0]!.at },
    ]);
  });
});

describe('worker kind', () => {
  test("agent when any binding write by the attempt's own person had an agent actor; another person's agent never changes it", async ({
    world,
    grimoire,
  }) => {
    const { core } = grimoire;
    const human = { ...grimoire.ctx, surface: 'cli' as const, client: null, evidence: {}, nonce: 'nonce-human' };
    const bob = { name: world.b.identity.name, email: world.b.identity.email };
    const bobsAgent: CallContext = { ...claudeMain(grimoire.ctx, 'toolu_bob'), person: bob };
    const endOf = async (id: string, attempt: string) =>
      trackerFile(world.a, (await trackerTip(world.a))!, `attempts/${id[3]}/${id[4]}/${id}/${attempt}/end.md`);

    // By hand, with Bob's agent around: it can't name Alice's handle, and its other writes bind nothing.
    const byHand = await created(core, human, 'By hand');
    const handAttempt = await claimed(core, human, byHand);
    await core.call('update', { id: byHand, title: 'By hand, retitled', attempt: handAttempt }, human);
    expect(await core.call('comment', { id: byHand, body: 'Mine now', attempt: handAttempt }, bobsAgent)).toMatchObject({
      ok: false,
      error: { code: 'NOT_ASSIGNEE' },
    });
    expect(await core.call('comment', { id: byHand, body: 'Drive-by' }, bobsAgent)).toMatchObject({ ok: true });
    await core.call('close', { id: byHand, reason: 'done', attempt: handAttempt }, human);
    const handBindings = await bindingsIn(world.a, handAttempt);
    expect(handBindings.map((b) => [b.op, b.actor.kind])).toEqual([
      ['claim', 'human'],
      ['update', 'human'],
      ['close', 'human'],
    ]);
    expect(await endOf(byHand, handAttempt)).toMatch(/^worker_kind: "human"$/m);

    // Claimed by hand, then Alice's own agent passed the handle once.
    const helped = await created(core, human, 'Agent helped');
    const helpedAttempt = await claimed(core, human, helped);
    await core.call('comment', { id: helped, body: 'On it', attempt: helpedAttempt }, claudeMain(grimoire.ctx, 'toolu_help'));
    await core.call('close', { id: helped, reason: 'done', attempt: helpedAttempt }, human);
    expect((await bindingsIn(world.a, helpedAttempt)).map((b) => [b.op, b.person, b.actor.kind])).toEqual([
      ['claim', world.a.identity.email, 'human'],
      ['comment', world.a.identity.email, 'agent'],
      ['close', world.a.identity.email, 'human'],
    ]);
    expect(await endOf(helped, helpedAttempt)).toMatch(/^worker_kind: "agent"$/m);
  });
});
