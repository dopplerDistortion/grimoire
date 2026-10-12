// The excerpt-mode setting (spec §14 The setting; §6 Machine settings): the
// store's `excerpts` / `facts` / `none`, changed only by a person's
// `settings set excerpts <mode>`, which re-shows the disclosure. Tightening
// strips the text from every open attempt's session records in the same commit;
// loosening warns that every clone applies it at its next cut. Seam 1.
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext } from '../../src/core';
import { sessionKey } from '../../src/capture/seen-here';
import { syncPending } from '../../src/core/sync';
import { agentContext, commitToTracker, fetchTracker, pushTracker, trackerTip, TRACKER_REF } from './support';
import { attemptDir, CLAUDE_SESSION, claimed, created, DEBRIEF, claudeCall, sessionRecords, setExcerptMode, test } from './capture-support';

function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true, nonce: 'nonce-human' };
}

/** A good pending record of the claiming context, with excerpt text, as a sweep attaches one to an open attempt. */
function pendingRecord(): { key: string; bytes: string } {
  const key = sessionKey({ client: 'claude-code', session: CLAUDE_SESSION, context: 'main', nonce: 'nonce-claude' });
  const reach = { at: '2026-10-11T03:27:16.000Z', ref: 'b' };
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
    'user:\n | an earlier excerpt\n',
  ].join('\n');
  return { key, bytes };
}

describe('settings set excerpts', () => {
  test('tightening to facts strips the excerpt text from every open attempt’s records in the same commit; a sealed trace keeps its text', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    // A sealed attempt, cut in excerpts mode.
    const doneId = await created(core, grimoire.ctx, 'Done already');
    const done = await claimed(core, grimoire.ctx, doneId);
    capture.at('2026-10-11T03:27:30.000Z');
    expect(await core.call('close', { id: doneId, reason: 'done', attempt: done, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    const sealedBody = (await sessionRecords(world.a, doneId, done))[0]!.body;
    expect(sealedBody).not.toBe('');
    // An open attempt with a pending record carrying text.
    const openId = await created(core, grimoire.ctx, 'Still open');
    const open = await claimed(core, grimoire.ctx, openId);
    const pending = pendingRecord();
    await commitToTracker(world.a, { [`${attemptDir(openId, open)}/sessions/${pending.key}.md`]: pending.bytes });
    const before = (await trackerTip(world.a))!;

    const set = await core.call('settings_set', { key: 'excerpts', value: 'facts' }, terminal(grimoire.ctx));

    expect(set).toMatchObject({ ok: true, result: { key: 'excerpts', scope: 'store', value: 'facts', changed: true } });
    const result = set.ok ? (set.result as unknown as { disclosure: string[]; warning?: string }) : null;
    expect(result!.disclosure[0]).toBe('Excerpt mode: facts.');
    expect(result!.disclosure.join('\n')).toContain('Pushed history can’t be purged.');
    expect(result!.warning).toBeUndefined();
    // One commit: the setting and the stripped record.
    expect(await world.a.git(['rev-list', '--count', `${before}..${TRACKER_REF}`])).toBe('1');
    const changed = (await world.a.git(['diff', '--name-only', before, TRACKER_REF])).split('\n').sort();
    expect(changed).toEqual(['settings.yml', `${attemptDir(openId, open)}/sessions/${pending.key}.md`].sort());
    const [stripped] = await sessionRecords(world.a, openId, open);
    expect(stripped!.body).toBe('');
    expect(stripped!.fields).toMatchObject({ excerpt: 'off', steps_kept: 0, characters: 0, facts: 'scanned', reach: { at: '2026-10-11T03:27:16.000Z', ref: 'b' } });
    // Pushed or sealed, a trace's text stays.
    expect((await sessionRecords(world.a, doneId, done))[0]!.body).toBe(sealedBody);
  });

  test('loosening warns that every clone applies it at its next cut and that teammates aren’t asked; it rewrites no record', async ({
    world,
    grimoire,
    capture,
  }) => {
    await setExcerptMode(world.a, 'none');
    const before = (await trackerTip(world.a))!;

    const set = await capture.core.call('settings_set', { key: 'excerpts', value: 'excerpts' }, terminal(grimoire.ctx));

    expect(set).toMatchObject({ ok: true, result: { value: 'excerpts', changed: true } });
    const result = set.ok ? (set.result as unknown as { disclosure: string[]; warning?: string }) : null;
    expect(result!.warning).toMatch(/every clone applies it at its next cut/);
    expect(result!.warning).toMatch(/teammates aren’t asked/);
    expect(result!.disclosure[0]).toBe('Excerpt mode: excerpts.');
    expect((await world.a.git(['diff', '--name-only', before, TRACKER_REF])).split('\n')).toEqual(['settings.yml']);
  });

  test('an unknown mode is refused, and an agent can’t change it', async ({ world, grimoire, capture }) => {
    const before = await trackerTip(world.a);

    const bad = await capture.core.call('settings_set', { key: 'excerpts', value: 'everything' }, terminal(grimoire.ctx));
    const agent = await capture.core.call('settings_set', { key: 'excerpts', value: 'facts' }, grimoire.ctx);

    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(agent).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    expect(await trackerTip(world.a)).toBe(before);
  });

  test('a push after tightening on another clone rewrites the unpushed segment: no pushed record carries text, and the text pushed before stays', { timeout: 120_000 }, async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    // A sealed trace with text, pushed while the store was in excerpts mode.
    const doneId = await created(core, grimoire.ctx, 'Pushed with text');
    const done = await claimed(core, grimoire.ctx, doneId);
    capture.at('2026-10-11T03:27:30.000Z');
    expect(await core.call('close', { id: doneId, reason: 'done', attempt: done, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close'))).toMatchObject({ ok: true });
    const openId = await created(core, grimoire.ctx, 'Open on a');
    const open = await claimed(core, grimoire.ctx, openId);
    await pushTracker(world.a);
    await fetchTracker(world.b);
    // Clone a attaches a pending record with text and doesn't push it; clone b tightens to facts and pushes.
    const pending = pendingRecord();
    const recordPath = `${attemptDir(openId, open)}/sessions/${pending.key}.md`;
    await commitToTracker(world.a, { [recordPath]: pending.bytes });
    await commitToTracker(world.a, { 'unknown-later-file.txt': 'kept\n' });
    const bob = terminal(agentContext(world.b));
    expect(await core.call('settings_set', { key: 'excerpts', value: 'facts' }, bob)).toMatchObject({ ok: true, result: { changed: true } });
    await pushTracker(world.b);

    const synced = await core.call('sync', {}, terminal(grimoire.ctx));

    expect(synced).toMatchObject({ ok: true, result: { state: 'pushed' } });
    // The marker set for the tip before its rewrite settles with the push of the rewritten one.
    expect(await syncPending(path.join(world.a.dir, '.git'))).toBe(false);
    expect(await core.call('sync_status', {}, terminal(grimoire.ctx))).toMatchObject({ ok: true, result: { pending_since: null } });
    const remote = (await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    // Every commit the remote holds: none carries the record with text.
    for (const commit of (await world.a.git(['rev-list', remote])).split('\n')) {
      const shown = await world.a.gitResult(['show', `${commit}:${recordPath}`]);
      if (shown.code === 0) expect(shown.stdout.slice(shown.stdout.indexOf('\n---\n') + 5), commit).toBe('');
    }
    // The record itself, and the rest of the rewritten segment, arrived.
    expect(await world.a.git(['show', `${remote}:${recordPath}`])).toContain('excerpt: "off"');
    expect(await world.a.git(['show', `${remote}:unknown-later-file.txt`])).toBe('kept');
    expect(await trackerTip(world.a)).toBe(remote);
    // Pushed text stays.
    expect((await sessionRecords(world.a, doneId, done))[0]!.body).not.toBe('');
  });

  test('settings_get shows the mode, and a tracker without it reads facts', async ({ grimoire }) => {
    const shown = await grimoire.core.call('settings_get', { key: 'excerpts' }, grimoire.ctx);

    expect(shown).toMatchObject({ ok: true, result: { store: { excerpts: { value: 'facts', default: true } } } });
  });
});
