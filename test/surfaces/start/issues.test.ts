// Seam 3 (spec Testing Decisions, §20 Issues and Issue detail): the Issues
// screens' actions through the real `start`, over `/api/op/<name>` with the
// core's shapes, recorded as the signed-in person with client `dashboard`;
// human-only ops succeed there. Then the built dashboard in a headless
// Chromium under the exact CSP: a body edit merges with an agent's insert
// elsewhere, an overlapping one saves nothing and shows the conflict view,
// the draft (with focus and scroll) survives live updates, and agent-authored
// text renders inert.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { CallContext } from '../../../src/core';
import { derivePatch } from '../../../src/core/body-diff';
import { agentContext, coreTest, fetchTracker, pushTracker, trackerTip } from '../../core/support';
import { findChromium, openHeadless, type HeadlessPage } from './browser';
import { buildFull, control, request, signedIn, spawnStart, startEnv, stopStart, writeHeaders, type StartProcess } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

const chromium = findChromium();

interface Served {
  readonly start: StartProcess;
  readonly port: number;
  readonly commonDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/** coreTest plus a `start` serving clone a (with a tracker), stopped after the test. */
const startTest = coreTest.extend('served', async ({ world, grimoire: _ }, { onCleanup }) => {
  const { env } = await startEnv(world.root);
  const start = await spawnStart(bin, world.a.dir, env);
  const commonDir = path.join(world.a.dir, '.git');
  onCleanup(async () => {
    await stopStart(start, commonDir, env);
  });
  const served: Served = { start, port: start.port, commonDir, env };
  return served;
});

type Answer = { ok: true; result: Record<string, any> } | { ok: false; status: number; error: { code: string; message: string; details: Record<string, unknown> } };

/** The dashboard's client, as the page uses it: reads by GET, writes by POST, with the session cookie. */
async function client(served: Served) {
  const cookie = await signedIn(served.port, served.commonDir, served.env);
  const answer = (status: number, body: string): Answer => {
    const value = JSON.parse(body) as Record<string, any>;
    return status === 200 ? { ok: true, result: value } : { ok: false, status, error: value.error };
  };
  return {
    async get(op: string, input: Record<string, unknown> = {}): Promise<Answer> {
      const reply = await request(served.port, { path: `/api/op/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, headers: { cookie } });
      return answer(reply.status, reply.body);
    },
    async post(op: string, input: Record<string, unknown>): Promise<Answer> {
      const reply = await request(served.port, { method: 'POST', path: `/api/op/${op}`, headers: writeHeaders(served.port, cookie), body: JSON.stringify(input) });
      return answer(reply.status, reply.body);
    },
  };
}

function ok(answer: Answer): Record<string, any> {
  if (!answer.ok) throw new Error(`expected success, got ${JSON.stringify(answer.error)}`);
  return answer.result;
}

function refused(answer: Answer): string {
  if (answer.ok) throw new Error(`expected a refusal, got ${JSON.stringify(answer.result)}`);
  return answer.error.code;
}

describe('the Issues actions over /api/op', () => {
  startTest('create, comment, field deltas, take it myself, close, and the human-only ops, all as the person through the dashboard', async ({ served, world, grimoire }) => {
    const api = await client(served);
    const bob: CallContext = agentContext(world.b, world.a);
    const me = world.a.identity.email;

    const blocker = ok(await api.post('create', { title: 'Blocker' })).id as string;
    const parent = ok(await api.post('create', { title: 'Parent', body: 'line one\nline two\n', labels: ['map'] })).id as string;
    const child = ok(await api.post('create', { title: 'Child', parent, blocked_by: [blocker] })).id as string;

    // Field deltas, and a body edit as the shared patch module derives it.
    const updated = ok(await api.post('update', { id: parent, title: 'Parent, renamed', labels_add: ['wayfinder'], labels_remove: ['map'], links_add: [{ target: 'https://example.com/spec', title: 'Spec' }] }));
    const patched = ok(await api.post('update', { id: parent, body_patch: derivePatch('line one\nline two\n', 'line one\nline 2\n') }));
    const cycle = refused(await api.post('update', { id: child, blocked_by_add: [parent] }));
    ok(await api.post('update', { id: child, blocked_by_remove: [blocker] }));
    const commented = ok(await api.post('comment', { id: parent, body: 'Looks right.' }));

    // Take it myself, then close my attempt.
    const mine = ok(await api.post('claim', { id: blocker }));
    const closedMine = ok(await api.post('close', { id: blocker, reason: 'done', attempt: mine.attempt, comment: 'Done by hand.' }));
    // An issue nobody holds: an unclaimed close.
    const loose = ok(await api.post('create', { title: 'Loose' })).id as string;
    const closedLoose = ok(await api.post('close', { id: loose, reason: 'canceled' }));

    // Someone else's attempt: closing is refused until it ends; reassign and release as abandoned are human-only.
    const held = ok(await api.post('create', { title: 'Held' })).id as string;
    const bobClaim = await grimoire.core.call('claim', { id: held }, bob);
    if (!bobClaim.ok) throw new Error(JSON.stringify(bobClaim.error));
    const closeHeld = refused(await api.post('close', { id: held, reason: 'done' }));
    const reassigned = ok(await api.post('reassign', { id: held, assignee: 'carol@example.com' }));
    const abandoned = ok(await api.post('release', { id: held, attempt: reassigned.attempt, abandoned: true, comment: 'Carol is away.' }));
    const assigned = ok(await api.post('assign', { id: held, assignee: world.b.identity.email }));

    // Reopen needs a comment; delete refuses an issue with sub-issues.
    const bareReopen = refused(await api.post('reopen', { id: loose }));
    const reopened = ok(await api.post('reopen', { id: loose, comment: 'Not done after all.' }));
    const deleteParent = refused(await api.post('delete', { id: parent }));
    const deleted = ok(await api.post('delete', { id: loose }));

    const shown = ok(await api.get('show', { ref: parent, comments: 'all' }));
    const activity = ok(await api.get('activity', { issue: parent }));
    const heldShown = ok(await api.get('show', { ref: held }));

    expect(updated.noops).toEqual([]);
    expect(patched.revision).not.toBe(updated.revision);
    expect(cycle).toBe('CYCLE');
    expect(commented).toMatchObject({ issue: parent });
    expect(closedMine).toMatchObject({ attempt: mine.attempt, outcome: 'pass' });
    expect(closedLoose).toMatchObject({ outcome: 'none' });
    expect(closeHeld).toBe('ATTEMPT_OPEN');
    expect(reassigned).toMatchObject({ ended: bobClaim.result.attempt, assignee: 'carol@example.com' });
    expect(abandoned).toMatchObject({ attempt: reassigned.attempt, outcome: 'fail' });
    expect(assigned).toMatchObject({ assignee: world.b.identity.email });
    expect(bareReopen).toBe('INVALID');
    expect(reopened).toMatchObject({ id: loose });
    expect(deleteParent).toBe('INVALID');
    expect(deleted).toMatchObject({ id: loose });
    expect(shown).toMatchObject({
      title: 'Parent, renamed',
      labels: ['wayfinder'],
      links: [{ target: 'https://example.com/spec', title: 'Spec' }],
      body: 'line one\nline 2\n',
      children: [{ id: child, status: 'open' }],
      comments: [{ body: 'Looks right.', actor: { person: me, kind: 'human', client: 'dashboard' } }],
    });
    expect(heldShown.open_attempts).toMatchObject([{ assignee: world.b.identity.email }]);
    expect(heldShown.past_attempts.map((a: { ended: string }) => a.ended)).toEqual(['reassign', 'release-abandoned']);
    // Every write was recorded as the person, through the dashboard.
    const ops = activity.entries.map((entry: { op: string; person: string; actor: Record<string, string>; fields?: string[] }) => [entry.op, entry.person, entry.actor.kind, entry.actor.client, entry.fields ?? null]);
    expect(ops).toEqual([
      ['comment', me, 'human', 'dashboard', null],
      ['update', me, 'human', 'dashboard', ['body']],
      ['update', me, 'human', 'dashboard', ['labels', 'links', 'title']],
      ['create', me, 'human', 'dashboard', null],
    ]);
  });

  startTest('resolve settles a field conflict from the dashboard', async ({ served, world, grimoire }) => {
    const api = await client(served);
    const id = ok(await api.post('create', { title: 'Shared' })).id as string;
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const bobCore = grimoire.makeCore();
    ok(await api.post('update', { id, title: 'Alice’s title' }));
    const bobs = await bobCore.call('update', { id, title: 'Bob’s title' }, agentContext(world.b));
    if (!bobs.ok) throw new Error(JSON.stringify(bobs.error));
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const conflicted = ok(await api.get('show', { ref: id }));
    const resolved = ok(await api.post('resolve', { id, fields: { title: 'theirs' } }));
    const after = ok(await api.get('show', { ref: id }));

    expect(conflicted).toMatchObject({ ready: false, conflict: { fields: ['title'] } });
    expect(resolved).toEqual({ id, resolved: [{ field: 'title', took: 'theirs' }] });
    expect(after).toMatchObject({ conflict: null, ready: true, title: conflicted.conflict.theirs.title });
  });

  startTest('the Ready view never shows an issue whose claim would fail', async ({ served, world, grimoire }) => {
    const api = await client(served);
    const bob = agentContext(world.b, world.a);
    const create = async (input: Record<string, unknown>) => ok(await api.post('create', input)).id as string;
    const plain = await create({ title: 'Plain' });
    const blocker = await create({ title: 'Blocker' });
    await create({ title: 'Blocked', blocked_by: [blocker] });
    const parent = await create({ title: 'Parent' });
    await create({ title: 'Kid', parent });
    const claimed = await create({ title: 'Claimed' });
    expect((await grimoire.core.call('claim', { id: claimed }, bob)).ok).toBe(true);
    const closed = await create({ title: 'Closed' });
    ok(await api.post('close', { id: closed, reason: 'done' }));

    const ready = ok(await api.get('list', { view: 'ready' })).rows.map((row: { id: string }) => row.id) as string[];
    const claims = await Promise.all(ready.map(async (id) => [id, (await api.post('claim', { id })).ok] as const));

    expect(ready).toContain(plain);
    expect(ready).not.toContain(claimed);
    expect(ready).not.toContain(parent);
    expect(ready).not.toContain(closed);
    for (const [id, claimedOk] of claims) expect(claimedOk, id).toBe(true);
  });
});

// ---------- the dashboard in a browser ----------

const MAP_LINES = Array.from({ length: 80 }, (_, i) => `- line ${i + 1} of the map`);
const MAP = `## Destination\n\nA v2 payments API spec, ready to slice.\n\n## Notes\n\n${MAP_LINES.join('\n')}\n\n## Out of scope\n\n- Multi-currency settlement.\n`;

async function signedInPage(served: Served): Promise<HeadlessPage> {
  const page = await openHeadless(chromium!);
  const { url } = (await control(served.commonDir, served.env, 'sign-in')) as { url: string };
  await page.goto(url, `document.querySelector('.live-live') !== null`);
  return page;
}

async function openIssue(page: HeadlessPage, served: Served, id: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${served.port}/issues/${id}`, `document.querySelector('.edit-body') !== null && document.querySelector('.live-live') !== null`);
}

/** Types `text` into the body editor as a person would: the value, then an input event. */
const typeDraft = (text: string) =>
  `(() => { const t = document.querySelector('.body-editor'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); t.setSelectionRange(7, 7); window.__editor = t; return true; })()`;

describe('the Issues screens in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('a body edit merges with an agent’s insert elsewhere, and the draft, focus and scroll survive the live update', async ({ served, world, grimoire }) => {
    const agent = agentContext(world.b, world.a);
    const created = await grimoire.core.call('create', { title: 'Map', body: MAP }, agent);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.result.id;
    const page = await signedInPage(served);
    try {
      await openIssue(page, served, id);
      await page.evaluate(`document.querySelector('.edit-body').click()`);
      await page.waitFor(`document.querySelector('.body-editor') !== null`);
      const draft = MAP.replace('ready to slice.', 'ready to slice into tickets.');
      await page.evaluate(typeDraft(draft));
      const scrolled = await page.evaluate<number>(`(() => { const p = document.querySelector('.detail-pane'); p.scrollTop = 120; return p.scrollTop; })()`);

      // The agent inserts a section far from the edit; the live update shows it as changed while you edit.
      const inserted = await grimoire.core.call('update', { id, body_patch: [{ op: 'insert_before', anchor: '## Out of scope', text: '## Not yet specified\n\n- Refunds.\n\n' }] }, agent);
      expect(inserted.ok).toBe(true);
      await page.waitFor(`document.querySelector('.changed-while-editing') !== null`);
      const kept = await page.evaluate<{ same: boolean; value: string; focused: boolean; caret: number; scroll: number }>(
        `(() => { const t = document.querySelector('.body-editor'); return { same: t === window.__editor, value: t.value, focused: document.activeElement === t, caret: t.selectionStart, scroll: document.querySelector('.detail-pane').scrollTop }; })()`,
      );

      await page.evaluate(`document.querySelector('.save-body').click()`);
      await page.waitFor(`document.querySelector('.body-editor') === null && document.querySelector('.body-conflict') === null`);
      const shown = await grimoire.core.call('show', { ref: id }, agent);

      expect(kept).toMatchObject({ same: true, value: draft, focused: true, caret: 7 });
      // Not reset: the browser may move it down by what was inserted above (scroll anchoring), never back to the top.
      expect(kept.scroll).toBeGreaterThanOrEqual(scrolled);
      expect(scrolled).toBeGreaterThan(0);
      expect(shown.ok && shown.result.body).toBe(MAP.replace('ready to slice.', 'ready to slice into tickets.').replace('## Out of scope', '## Not yet specified\n\n- Refunds.\n\n## Out of scope'));
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });

  startTest.skipIf(!chromium)('an overlapping edit saves nothing and shows the conflict view with its three choices', async ({ served, world, grimoire }) => {
    const agent = agentContext(world.b, world.a);
    const created = await grimoire.core.call('create', { title: 'Map', body: MAP }, agent);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.result.id;
    const page = await signedInPage(served);
    try {
      await openIssue(page, served, id);
      await page.evaluate(`document.querySelector('.edit-body').click()`);
      await page.waitFor(`document.querySelector('.body-editor') !== null`);
      await page.evaluate(typeDraft(MAP.replace('A v2 payments API spec, ready to slice.', 'A v2 payments API spec, sliced.')));
      const rewritten = await grimoire.core.call('update', { id, body_patch: [{ op: 'replace', anchor: 'A v2 payments API spec, ready to slice.', text: 'A v3 payments API spec.' }] }, agent);
      expect(rewritten.ok).toBe(true);
      await page.waitFor(`document.querySelector('.changed-while-editing') !== null`);
      const before = await trackerTip(world.a);

      await page.evaluate(`document.querySelector('.save-body').click()`);
      await page.waitFor(`document.querySelector('.body-conflict') !== null`);
      const choices = await page.evaluate<string[]>(`[...document.querySelectorAll('.body-conflict .actions button')].map((b) => b.textContent.trim())`);
      const after = await trackerTip(world.a);
      // Redo puts the current text in the editor, the draft kept beside it for copying.
      await page.evaluate(`document.querySelector('.body-conflict .redo').click()`);
      await page.waitFor(`document.querySelector('.body-editor') !== null`);
      const redone = await page.evaluate<string>(`document.querySelector('.body-editor').value`);

      expect(after).toBe(before);
      expect(choices).toEqual(['Redo my edit on the current text', 'Replace the body with my draft…', 'Discard my draft']);
      expect(redone).toBe(MAP.replace('A v2 payments API spec, ready to slice.', 'A v3 payments API spec.'));
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });

  startTest.skipIf(!chromium)('agent-authored text renders inert: a script tag is text and images are never fetched; dialogs name the recorded actor, and delete needs the typed id', async ({ served, world, grimoire }) => {
    const agent = agentContext(world.b, world.a);
    const evil = `http://127.0.0.1:${served.port}/evil.png`;
    const body = `<script>window.__pwned = 1</script>\n\n<img src="${evil}?raw" onerror="window.__pwned = 2">\n\n![a chart](${evil}?md) and [a link](javascript:window.__pwned=3) and [docs](https://example.com/docs)`;
    const created = await grimoire.core.call('create', { title: '<b>bold?</b>', body }, agent);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.result.id;
    expect((await grimoire.core.call('comment', { id, body: `<script>window.__pwned = 4</script> ![x](${evil}?comment)` }, agent)).ok).toBe(true);
    const page = await signedInPage(served);
    try {
      await openIssue(page, served, id);
      await page.waitFor(`document.querySelector('.tl-item.comment') !== null`);
      const facts = await page.evaluate<Record<string, unknown>>(`(() => ({
        scripts: document.querySelectorAll('.issue script').length,
        images: document.querySelectorAll('.issue img').length,
        text: document.querySelector('.body').innerText,
        title: document.querySelector('.issue-title').innerText,
        pwned: window.__pwned ?? null,
        javascriptLinks: [...document.querySelectorAll('.issue a')].filter((a) => a.getAttribute('href')?.startsWith('javascript:')).length,
        hosts: [...document.querySelectorAll('.body .md-host')].map((h) => h.textContent.trim()),
      }))()`);
      await page.evaluate(`document.querySelector('.delete-issue').click()`);
      await page.waitFor(`document.querySelector('.modal') !== null`);
      const dialog = await page.evaluate<string>(`document.querySelector('.modal .recorded').textContent`);
      // Delete needs the typed id: without it nothing is sent.
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.dialog-error') !== null`);
      const untyped = await page.evaluate<string>(`document.querySelector('.dialog-error').textContent`);
      const kept = await grimoire.core.call('show', { ref: id }, agent);
      await page.evaluate(`document.querySelector('.modal input[name="__typed"]').value = ${JSON.stringify(id)}`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.modal') === null && location.pathname === '/issues'`);
      const gone = await grimoire.core.call('show', { ref: id }, agent);

      expect(facts).toMatchObject({ scripts: 0, images: 0, pwned: null, javascriptLinks: 0, title: '<b>bold?</b> edit' });
      expect(facts.text).toContain('<script>window.__pwned = 1</script>');
      expect(facts.text).toContain('image: a chart');
      expect(facts.hosts).toContain('↗ example.com');
      expect(page.requests().filter((url) => url.includes('evil.png'))).toEqual([]);
      expect(dialog).toBe(`🔒 human-only · recorded as ${world.a.identity.email} through the dashboard`);
      expect(untyped).toBe(`Type ${id} to confirm.`);
      expect(kept.ok).toBe(true);
      expect(gone).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});
