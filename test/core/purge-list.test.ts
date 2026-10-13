// `purge_list` (spec §20 Settings: purged records, with the history caveat;
// §3 Delete and purge), seam 1: every purge tombstone the merged view holds,
// newest first, and the words that say pushed history keeps the content.
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { sessionKey } from '../../src/capture/seen-here';
import { commitToTracker, coreTest as test } from './support';

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

function dashboard(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'dashboard', client: { name: 'dashboard' }, evidence: {} };
}

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const done = await outcome;
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  return done.result;
}

/** A session record with excerpt text, as a sweep attaches one to an open attempt. */
function sessionRecord(): { key: string; bytes: string } {
  const key = sessionKey({ client: 'claude-code', session: 'sess-1', context: 'main', nonce: 'nonce-claude' });
  const reach = { at: '2026-10-11T03:27:16.000Z', ref: 'b' };
  const bytes = [
    '---',
    'client: "claude-code"',
    'client_version: "2.1.296"',
    'reader_version: 1',
    'session: "sess-1"',
    'context: "main"',
    'source: "hint"',
    'window_start: {"at":"2026-10-11T03:27:15.900Z","ref":"a"}',
    `window_end: ${JSON.stringify(reach)}`,
    'steps: 1',
    'steps_kept: 1',
    'characters: 24',
    'excerpt: "cut"',
    'excerpt_notes: []',
    'facts: "scanned"',
    'skills_read: []',
    'commits: []',
    `reach: ${JSON.stringify(reach)}`,
    'cut_at: "2026-10-11T03:27:17.000Z"',
    'roots: []',
    '---',
    'user:\n | a token pasted here\n',
  ].join('\n');
  return { key, bytes };
}

describe('purge_list', () => {
  test('lists purged traces and session records with who, when and why, and says pushed history keeps them', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const empty = await ok(core.call('purge_list', {}, dashboard(ctx)));

    const { id } = await ok(core.call('create', { title: 'Leaky' }, ctx));
    const { attempt } = await ok(core.call('claim', { id }, ctx));
    await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx));
    await ok(core.call('purge_trace', { attempt, reason: 'pasted a token' }, terminal(ctx)));

    const open = await ok(core.call('create', { title: 'Still open' }, ctx));
    const claimed = await ok(core.call('claim', { id: open.id }, ctx));
    const record = sessionRecord();
    await commitToTracker(world.a, { [`attempts/${open.id[3]}/${open.id[4]}/${open.id}/${claimed.attempt}/sessions/${record.key}.md`]: record.bytes });
    await ok(core.call('purge_session', { attempt: claimed.attempt, key: record.key, reason: 'a secret in the excerpt' }, terminal(ctx)));

    const listed = await ok(core.call('purge_list', {}, dashboard(ctx)));
    const fromAgent = await core.call('purge_list', {}, ctx);

    expect(empty.purged).toEqual([]);
    const me = world.a.identity.email;
    expect(listed.purged).toEqual([
      { kind: 'session', id: claimed.attempt, key: record.key, facts: 'kept', by: me, at: expect.any(String), reason: 'a secret in the excerpt' },
      { kind: 'trace', id: attempt, by: me, at: expect.any(String), reason: 'pasted a token' },
    ]);
    expect(listed.note).toBe('Pushed git history keeps purged content: grimoire never rewrites pushed history, so the remote and every clone that fetched it keep it until someone rewrites that history.');
    expect(fromAgent).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
  });
});
