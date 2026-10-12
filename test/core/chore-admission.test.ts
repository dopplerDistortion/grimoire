// Seam 1 (spec Testing Decisions; §16 Admission; spikes C (C1) and F (P5);
// ADR 0006): `chore_start` admits only a caller grimoire can tell holds no
// open attempt. Contexts are built from seam-2 fixtures: Claude Code's real
// PreToolUse payloads through grimoire's own hook, and real `_meta` from Claude
// Code and Codex `tools/call`s.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { clientIn, evidenceIn } from '../../src/surfaces/cli/shell';
import {
  choreAgent,
  claudeCall,
  Clock,
  codexRoot,
  codexSubagent,
  genericCall,
  terminal,
  workPair,
} from './chore-support';
import { coreTest as test, T0, type Grimoire } from './support';

/** A core whose Wiki Maintainer is due: one settled fail, and compile_pairs 1. */
async function dueCore(grimoire: Grimoire): Promise<Core> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now });
  await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
  await workPair(core, grimoire.ctx, 'fail');
  clock.advance(25);
  return core;
}

/** A CLI call from an agent's shell whose env is `env`. */
function shellCall(base: CallContext, env: NodeJS.ProcessEnv): CallContext {
  return { ...base, surface: 'cli', client: clientIn(env), evidence: evidenceIn(env), tty: false, nonce: 'nonce-shell' };
}

const notIsolated = { ok: false, error: { code: 'NOT_ISOLATED', details: { hint: expect.any(String) } } };

describe('the admission table', () => {
  test('a validated grimoire-chores hint is admitted, isolated as claude-chore-agent', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const started = await core.call('chore_start', {}, await choreAgent(grimoire.ctx));
    expect(started).toMatchObject({ ok: true, result: { kind: 'wiki-maintainer', isolation: 'claude-chore-agent' } });
  });

  test('a forged or unvalidated agent_type, another subagent, or a Claude main context gives NOT_ISOLATED', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const payloads = 'claude-code/hook-payloads';
    const contexts: [string, CallContext][] = [
      // The hint names the chore agent, but its tool_use_id isn't this call's: forged.
      ['forged', await claudeCall(grimoire.ctx, `${payloads}/pre-tool-use-chore-subagent.json`, undefined, { tool_use_id: 'toolu_guessed' })],
      // A hint with no _meta to check it against: unvalidated.
      ['unvalidated', { ...(await choreAgent(grimoire.ctx)), mcp: { ...(await choreAgent(grimoire.ctx)).mcp!, meta: null } }],
      // A main context that wrote agent_type into its own hint: the hook keeps only the payload's ids, but a model could try.
      ['main with a claimed type', await claudeCall(grimoire.ctx, `${payloads}/pre-tool-use-main-context.json`, 'claude-code/meta/tools-call-chore-subagent.json', { tool_use_id: 'toolu_01JKJLE75F1oWW6KxurK5paA', agent_type: 'grimoire-chores' })],
      ['general-purpose subagent', await claudeCall(grimoire.ctx, `${payloads}/pre-tool-use-general-purpose-subagent.json`, 'claude-code/meta/tools-call-chore-subagent.json', { tool_use_id: 'toolu_01JKJLE75F1oWW6KxurK5paA' })],
      ['main context', await claudeCall(grimoire.ctx, `${payloads}/pre-tool-use-main-context.json`, 'claude-code/meta/tools-call-chore-subagent.json', { tool_use_id: 'toolu_01JKJLE75F1oWW6KxurK5paA' })],
    ];
    for (const [what, ctx] of contexts) {
      expect(await core.call('chore_start', {}, ctx), what).toMatchObject(notIsolated);
    }
    const main = await core.call('chore_start', {}, contexts.at(-1)![1]);
    expect(main.ok ? '' : main.error.details.hint).toMatch(/grimoire-chores skill/);
  });

  test('a Codex subagent thread is admitted', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    expect(await core.call('chore_start', {}, codexSubagent(grimoire.ctx))).toMatchObject({ ok: true, result: { isolation: 'codex-subagent' } });
  });

  test('a Codex root thread is admitted when its session is tied to no open attempt, and refused when it is', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const root = codexRoot(grimoire.ctx);
    const created = await core.call('create', { title: 'Root work' }, grimoire.ctx);
    if (!created.ok) throw new Error('create failed');
    await core.call('claim', { id: created.result.id }, root);

    expect(await core.call('chore_start', {}, root)).toMatchObject(notIsolated);
    // Another thread of the same session counts as that session.
    expect(await core.call('chore_start', {}, codexRoot(grimoire.ctx, 'nonce-other'))).toMatchObject(notIsolated);
  });

  test('a context that is itself bound to an open attempt is always refused, even a Codex subagent', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const subagent = codexSubagent(grimoire.ctx);
    const created = await core.call('create', { title: 'Subagent work' }, grimoire.ctx);
    if (!created.ok) throw new Error('create failed');
    await core.call('claim', { id: created.result.id }, subagent);

    expect(await core.call('chore_start', {}, subagent)).toMatchObject(notIsolated);
  });

  test('an unidentified caller is admitted while its person holds no open attempt on this machine, and refused once they do', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const created = await core.call('create', { title: 'Held work' }, grimoire.ctx);
    if (!created.ok) throw new Error('create failed');
    const claimed = await core.call('claim', { id: created.result.id }, grimoire.ctx);

    expect(await core.call('chore_start', {}, genericCall(grimoire.ctx))).toMatchObject(notIsolated);

    if (claimed.ok) await core.call('release', { id: created.result.id, attempt: claimed.result.attempt, debrief: { asked: 'a', tried: 'b', failed: 'c', worked: 'd', next: 'e' } }, grimoire.ctx);
    expect(await core.call('chore_start', {}, genericCall(grimoire.ctx))).toMatchObject({ ok: true, result: { isolation: 'unidentified' } });
  });

  test('CLI callers: refused in a Claude Code shell and with no session id; the root-thread rule in a Codex shell', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const claudeShell = shellCall(grimoire.ctx, { AI_AGENT: 'claude-code_2-1-296_agent', CLAUDE_CODE_SESSION_ID: 'c2eb58d9-ccb7-4978-bc0e-35f624a5266b' });
    const bareShell = shellCall(grimoire.ctx, { AI_AGENT: 'some-agent_1_agent' });
    const codexShell = shellCall(grimoire.ctx, { CODEX_THREAD_ID: '01a12946-7d23-7f93-b8c8-aa18d1bca5ef', CODEX_CI: '1' });

    expect(await core.call('chore_start', {}, claudeShell)).toMatchObject(notIsolated);
    expect(await core.call('chore_start', {}, bareShell)).toMatchObject(notIsolated);
    expect(await core.call('chore_start', {}, codexShell)).toMatchObject({ ok: true, result: { isolation: 'codex-root' } });
  });

  test('origin scheduled, as a parameter or GRIMOIRE_CHORE_ORIGIN, refuses the Skill Proposer but runs the Wiki Maintainer', async ({ grimoire }) => {
    const core = await dueCore(grimoire);
    const chores = await choreAgent(grimoire.ctx);
    expect(await core.call('chore_start', { kind: 'skill-proposer', origin: 'scheduled' }, chores)).toMatchObject({
      ok: false,
      error: { code: 'NOT_DUE', details: { why: expect.stringMatching(/scheduled/) } },
    });
    expect(await core.call('chore_start', { kind: 'skill-proposer' }, { ...chores, choreOrigin: 'scheduled' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_DUE' },
    });
    expect(await core.call('chore_start', {}, { ...chores, choreOrigin: 'scheduled' })).toMatchObject({
      ok: true,
      result: { kind: 'wiki-maintainer', origin: 'scheduled' },
    });
  });
});

describe('the unidentified rule fails closed', () => {
  test('with no git email, or with the seen-here rows unreadable, an unidentified caller is refused while an attempt is held on this machine', async ({ world, grimoire }) => {
    const core = await dueCore(grimoire);
    const created = await core.call('create', { title: 'Held work' }, grimoire.ctx);
    if (!created.ok) throw new Error('create failed');
    expect((await core.call('claim', { id: created.result.id }, grimoire.ctx)).ok).toBe(true);

    // No git email: grimoire can't tell whose the held attempt is, so it can't admit.
    const anonymous = { ...genericCall(grimoire.ctx), person: { ...grimoire.ctx.person, email: null } };
    const refused = await core.call('chore_start', {}, anonymous);
    expect(refused).toMatchObject(notIsolated);
    expect(refused.ok ? '' : refused.error.details.hint).toMatch(/user\.email/);

    // Seen-here rows that can't be read: grimoire can't tell the attempt isn't held here.
    await mkdir(path.join(world.a.dir, '.git', 'grimoire', 'coordination', 'seen-here', 'unreadable.json'), { recursive: true });
    const unreadable = await core.call('chore_start', {}, genericCall(grimoire.ctx));
    expect(unreadable).toMatchObject(notIsolated);
    expect(unreadable.ok ? '' : unreadable.error.details.hint).toMatch(/doctor/);
  });
});
