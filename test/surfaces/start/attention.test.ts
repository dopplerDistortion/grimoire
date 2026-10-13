// Seam 3 (spec Testing Decisions, §20 Attention and Attempt page): the home's
// attention queue, its live activity feed and the attempt page through the
// real `start`, over `/api/op/<name>` with the core's shapes; then the built
// dashboard in a headless Chromium under the exact CSP: a stale claim is
// released as abandoned from Attention and its outcome reads fail, a rejected
// sync shows with the remote's message and Sync now, the feed updates live,
// and the attempt page shows capture statuses, facts_complete, the
// wiki-exposed basis and commits with `via`, with excerpts as inert text and
// the confirmations the spec asks for.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { serializeSessionRecord } from '../../../src/capture/session-record';
import { openTracker } from '../../../src/tracker';
import type { Checkout } from '#harness';
import { agentContext, coreTest, T0 } from '../../core/support';
import { REJECTING_HOOK } from '../../core/sync-support';
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

type Answer = { ok: true; result: Record<string, any> } | { ok: false; status: number; error: { code: string; message: string } };

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

async function okCall<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(JSON.stringify(settled.error));
  return settled.result;
}

/** Commits in `checkout` at a fixed time (a `Refs:` trailer names an issue). */
async function commitAt(checkout: Checkout, at: string, file: string, message: string): Promise<string> {
  await mkdir(path.dirname(path.join(checkout.dir, file)), { recursive: true });
  await writeFile(path.join(checkout.dir, file), `${message}\n`);
  await checkout.git(['add', '-f', '--', file]);
  await checkout.git(['commit', '--quiet', '-m', message], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  return checkout.git(['rev-parse', 'HEAD']);
}

/** Attaches a session record to the open attempt `handle`, as a sweep would: its excerpt holds `text`. */
async function attachRecord(checkout: Checkout, handle: string, key: string, text: string): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact({ op: 'capture', author: { name: 'Alice', email: 'alice@example.com' }, actor: { kind: 'agent', client: 'test', nonce: 'sweep' } }, (draft) => {
      draft.putSessionRecord(
        handle,
        key,
        serializeSessionRecord({
          client: 'claude-code',
          client_version: '2.1.296',
          reader_version: 1,
          session: 'sess-1',
          context: 'main',
          source: 'hint',
          window_start: null,
          window_end: null,
          steps: 3,
          steps_kept: 3,
          characters: text.length,
          excerpt: 'cut',
          excerpt_notes: [],
          facts: 'scanned',
          skills_read: [],
          commits: [],
          reach: null,
          cut_at: T0.toISOString(),
          roots: [],
          text,
          extra: {},
        }),
      );
      return { result: null };
    });
  } finally {
    await tracker.close();
  }
}

describe('Attention and the attempt page over /api/op', () => {
  startTest('a stale claim is an attention item; releasing it as abandoned removes it and its outcome reads fail; a rejected sync is an item with the remote’s message', async ({ served, world, grimoire }) => {
    const api = await client(served);
    const agent = agentContext(world.b, world.a);
    // The agent claimed at T0: older than the 24 h threshold by the time `start` reads it.
    const id = (await okCall(grimoire.core.call('create', { title: 'Forgotten' }, agent))).id;
    const { attempt } = await okCall(grimoire.core.call('claim', { id }, agent));

    const stale = ok(await api.get('attention'));
    ok(await api.post('release', { id, attempt, abandoned: true }));
    const after = ok(await api.get('attention'));
    const shown = ok(await api.get('attempt_show', { attempt }));

    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), REJECTING_HOOK, { mode: 0o755 });
    const synced = ok(await api.post('sync', {}));
    const rejected = ok(await api.get('attention'));

    expect(stale.items).toMatchObject([{ kind: 'stale_claim', issue: id, attempt: { attempt, assignee: world.b.identity.email, stale: true } }]);
    expect(stale.counts).toMatchObject({ claimed: 1, stale: 1 });
    expect(after.items).toEqual([]);
    expect(shown).toMatchObject({ attempt, state: 'ended', end: { ended: 'release-abandoned', ended_by: { person: world.a.identity.email, client: 'dashboard' } }, outcome: { verdict: 'fail' } });
    expect(synced).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'rejected' } });
    expect(rejected.items).toMatchObject([{ kind: 'sync_failure', class: 'rejected', client: 'dashboard', surface: 'dashboard' }]);
    expect(rejected.items[0].message).toContain('GH013: Repository rule violations found for refs/heads/grimoire/tracker.');
  });
});

// ---------- the dashboard in a browser ----------

async function signedInPage(served: Served): Promise<HeadlessPage> {
  const page = await openHeadless(chromium!);
  const { url } = (await control(served.commonDir, served.env, 'sign-in')) as { url: string };
  await page.goto(url, `document.querySelector('.live-live') !== null`);
  return page;
}

const home = (served: Served) => `http://127.0.0.1:${served.port}/`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;

describe('Attention and the attempt page in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('a stale claim shows with Release as abandoned; acting removes it and the empty state shows; the feed updates live; the attempt’s outcome reads fail', async ({ served, world, grimoire }) => {
    const agent = agentContext(world.b, world.a);
    const id = (await okCall(grimoire.core.call('create', { title: 'Forgotten' }, agent))).id;
    const { attempt } = await okCall(grimoire.core.call('claim', { id }, agent));
    const page = await signedInPage(served);
    try {
      await page.goto(home(served), `document.querySelector('.att-stale') !== null`);
      const item = await page.evaluate<{ title: string; actions: string[]; tiles: string }>(`(() => ({
        title: document.querySelector('.att-stale .att-title').innerText,
        actions: [...document.querySelectorAll('.att-stale .att-actions button, .att-stale .att-actions a')].map((b) => b.textContent.trim()),
        tiles: document.querySelector('.tiles').innerText,
      }))()`);
      await page.evaluate(`document.querySelector('.att-stale button.abandon').click()`);
      await page.waitFor(`document.querySelector('.modal') !== null`);
      const recorded = await page.evaluate<string>(text('.modal .recorded'));
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.attention-empty') !== null`);
      const empty = await page.evaluate<string>(text('.attention-empty'));
      const shown = await okCall(grimoire.core.call('attempt_show', { attempt }, { ...agent, surface: 'dashboard', client: null, evidence: {} }));

      // An agent writes: the feed shows it without a reload.
      const feedBefore = await page.evaluate<number>(`document.querySelectorAll('.feed-entry').length`);
      await page.evaluate(`window.__sameDocument = true`);
      const other = (await okCall(grimoire.core.call('create', { title: 'Next thing' }, agent))).id;
      await page.waitFor(`[...document.querySelectorAll('.feed-entry')].some((e) => e.innerText.includes(${JSON.stringify(other)}))`);
      const fed = await page.evaluate<{ first: string; same: boolean; count: number }>(
        `({ first: document.querySelector('.feed-entry').innerText, same: window.__sameDocument === true, count: document.querySelectorAll('.feed-entry').length })`,
      );

      await page.goto(`http://127.0.0.1:${served.port}/attempts/${attempt}`, `document.querySelector('.outcome-panel .outcome') !== null`);
      const outcome = await page.evaluate<string>(text('.outcome-panel .outcome'));

      expect(item.title).toBe(`Stale claim: ${id} Forgotten`);
      expect(item.actions).toEqual(['Release as abandoned… 🔒', 'Open']);
      expect(item.tiles).toMatch(/1\s*Claimed/);
      expect(recorded).toBe(`🔒 human-only · recorded as ${world.a.identity.email} through the dashboard`);
      expect(empty).toBe('Nothing needs you. Agents are working through the frontier.');
      expect(shown).toMatchObject({ outcome: { verdict: 'fail' }, end: { ended: 'release-abandoned' } });
      expect(fed.same).toBe(true);
      expect(fed.count).toBeGreaterThan(feedBefore);
      expect(fed.first).toContain('via claude-code');
      expect(fed.first).toContain('created');
      expect(outcome).toBe('fail');
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });

  startTest.skipIf(!chromium)('a rejected sync shows the remote’s message, the fix and Sync now; once the remote takes it, Sync now clears the item', async ({ served, world }) => {
    const api = await client(served);
    ok(await api.post('create', { title: 'Something to push' }));
    const hook = path.join(world.remote, 'hooks', 'pre-receive');
    await writeFile(hook, REJECTING_HOOK, { mode: 0o755 });
    ok(await api.post('sync', {}));
    const page = await signedInPage(served);
    try {
      await page.goto(home(served), `document.querySelector('.att-sync') !== null`);
      const item = await page.evaluate<{ message: string; fix: string; actions: string[] }>(`(() => ({
        message: document.querySelector('.att-sync .remote-message').innerText,
        fix: document.querySelector('.att-sync .sync-fix').innerText,
        actions: [...document.querySelectorAll('.att-sync .att-actions button, .att-sync .att-actions a')].map((b) => b.textContent.trim()),
      }))()`);
      await writeFile(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await page.evaluate(`document.querySelector('.att-sync button.sync-now').click()`);
      await page.waitFor(`document.querySelector('.att-sync') === null && document.querySelector('.attention-empty') !== null`);

      expect(item.message).toContain('GH013: Repository rule violations found for refs/heads/grimoire/tracker.');
      expect(item.fix).toContain('grimoire/tracker');
      expect(item.actions).toEqual(['Sync settings', 'Sync now']);
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });

  startTest.skipIf(!chromium)('the attempt page: capture statuses, facts_complete, the wiki-exposed basis and commits with via; excerpts are inert text; override needs a reason, purges need the typed id and say pushed history keeps it, and a session-record purge offers both scopes', async ({ served, world, grimoire }) => {
    const agent = agentContext(world.b, world.a);
    const evil = `http://127.0.0.1:${served.port}/evil.png`;
    const excerpt = `user: run it\n<script>window.__pwned = 1</script>\n<img src="${evil}" onerror="window.__pwned = 2">\ntool Bash: ok`;
    const id = (await okCall(grimoire.core.call('create', { title: 'Audited' }, agent))).id;
    const { attempt } = await okCall(grimoire.core.call('claim', { id }, agent));
    const key = 'a1b2c3d4e5f60718';
    await attachRecord(world.a, attempt, key, excerpt);
    const page = await signedInPage(served);
    try {
      // Open: the session record, its statuses and the purge with both scopes.
      await page.goto(`http://127.0.0.1:${served.port}/attempts/${attempt}`, `document.querySelector('.session') !== null`);
      const open = await page.evaluate<Record<string, unknown>>(`(() => ({
        statuses: [...document.querySelectorAll('.context-row')].map((r) => [r.querySelector('.excerpt-status').innerText, r.querySelector('.facts-status').innerText]),
        complete: document.querySelector('.facts-complete').innerText,
        wiki: document.querySelector('.wiki-basis').innerText,
        excerpt: document.querySelector('.excerpt-text').textContent,
        collapsed: !document.querySelector('details.excerpt').open,
        scripts: document.querySelectorAll('.attempt script').length,
        images: document.querySelectorAll('.attempt img').length,
        pwned: window.__pwned ?? null,
      }))()`);
      await page.evaluate(`document.querySelector('button.purge-session').click()`);
      await page.waitFor(`document.querySelector('.modal') !== null`);
      const scopes = await page.evaluate<string[]>(`[...document.querySelectorAll('.modal input[name="scope"]')].map((i) => i.value + ':' + i.parentElement.innerText.trim())`);
      const sessionWarning = await page.evaluate<string>(text('.modal .banner'));
      await page.evaluate(`document.querySelector('.modal textarea[name="reason"]').value = 'a token in the excerpt'`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.dialog-error') !== null`);
      const untypedSession = await page.evaluate<string>(text('.dialog-error'));
      await page.evaluate(`document.querySelector('.modal input[name="__typed"]').value = ${JSON.stringify(attempt)}`);
      await page.evaluate(`document.querySelector('.modal input[name="scope"][value="facts"]').click()`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.facts-status')?.innerText === 'purged'`);

      // The agent commits with a Refs trailer, then a human closes it later: a referenced commit.
      const hash = await commitAt(world.a, new Date(T0.getTime() + 30 * 60_000).toISOString(), 'src/fix.txt', `Fix it\n\nRefs: ${id}`);
      const later = grimoire.makeCore({ clock: () => new Date(T0.getTime() + 3_600_000) });
      await okCall(later.call('close', { id, reason: 'done', attempt, debrief: { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' } }, agent));
      await page.waitFor(`document.querySelector('.commit-row') !== null && document.querySelector('.outcome-panel .outcome') !== null`);
      const ended = await page.evaluate<Record<string, unknown>>(`(() => ({
        commit: document.querySelector('.commit-row').innerText,
        endFacts: document.querySelector('.end-facts').innerText,
        wiki: document.querySelector('.wiki-basis').innerText,
      }))()`);

      // Override needs a reason.
      await page.evaluate(`document.querySelector('button.override').click()`);
      await page.waitFor(`document.querySelector('.modal') !== null`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.dialog-error') !== null`);
      const noReason = await page.evaluate<string>(text('.dialog-error'));
      await page.evaluate(`document.querySelector('.modal input[name="verdict"][value="none"]').click()`);
      await page.evaluate(`document.querySelector('.modal textarea[name="reason"]').value = 'the work was thrown away'`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.outcome-history') !== null`);
      const overridden = await page.evaluate<{ chip: string; history: string }>(`({ chip: document.querySelector('.outcome-panel .outcome').innerText, history: document.querySelector('.outcome-history').innerText })`);

      // Purge trace: the typed id and a reason, and it says pushed history keeps it.
      await page.evaluate(`document.querySelector('button.purge-trace').click()`);
      await page.waitFor(`document.querySelector('.modal') !== null`);
      const purgeDialog = await page.evaluate<{ history: string; typed: boolean; recorded: string }>(
        `({ history: document.querySelector('.modal .purge-history').innerText, typed: document.querySelector('.modal input[name="__typed"]') !== null, recorded: document.querySelector('.modal .recorded').innerText })`,
      );
      await page.evaluate(`document.querySelector('.modal textarea[name="reason"]').value = 'secrets'`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.dialog-error') !== null`);
      const untyped = await page.evaluate<string>(text('.dialog-error'));
      await page.evaluate(`document.querySelector('.modal input[name="__typed"]').value = ${JSON.stringify(attempt)}`);
      await page.evaluate(`document.querySelector('.modal button.ok').click()`);
      await page.waitFor(`document.querySelector('.purged-attempt') !== null`);
      const purged = await page.evaluate<string>(text('.purged-attempt .banner'));

      expect(open).toMatchObject({ statuses: [['cut', 'scanned']], collapsed: true, scripts: 0, images: 0, pwned: null });
      expect(open.complete).toBe('facts_complete: true');
      expect(open.wiki).toContain('Wiki-exposed: no');
      expect(open.excerpt).toBe(excerpt);
      expect(page.requests().filter((url) => url.includes('evil.png'))).toEqual([]);
      expect(scopes).toEqual(['excerpt:The excerpt alone (its facts stay on the tombstone)', 'facts:The excerpt with its facts']);
      expect(sessionWarning).toContain('Pushed git history still keeps it');
      expect(untypedSession).toBe(`Type ${attempt} to confirm.`);
      expect(ended.commit).toContain(hash.slice(0, 12));
      expect(ended.commit).toContain('via referenced');
      expect(ended.commit).toContain('Fix it');
      expect(ended.endFacts).toContain('closed as done');
      expect(ended.wiki).toContain('at the seal (the OR of binding writes): no');
      expect(noReason).toBe('Give a reason: an override needs one.');
      expect(overridden.chip).toBe('none');
      expect(overridden.history).toContain('pass (grimoire');
      expect(purgeDialog.history).toContain('Pushed git history still keeps it');
      expect(purgeDialog.typed).toBe(true);
      expect(purgeDialog.recorded).toBe(`🔒 human-only · recorded as ${world.a.identity.email} through the dashboard`);
      expect(untyped).toBe(`Type ${attempt} to confirm.`);
      expect(purged).toContain('Purged by');
      expect(purged).toContain('secrets');
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});
