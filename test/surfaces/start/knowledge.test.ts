// Seam 3 (spec Testing Decisions; §20 Knowledge, Attention, Confirmations,
// Rendering): the Knowledge screens of the built dashboard, served by the real
// `start` against temp repos and driven in a headless Chromium under the exact
// CSP. After a purge of one of a proposal's cited failing traces, the
// proposal screen shows the live red flag and Accept stays disabled until it
// is acknowledged, and the acknowledgement is recorded; the Restore dialog
// lists and diffs the dropped versions; Eject asks for a worktree and refuses
// an existing target; Attention's stray-edit Record and Discard and a fork's
// Acknowledge work end to end; the chore-runs list shows origin, isolation,
// outcome and reason codes, and no text for a secret-scan failure. Every view
// reads the live store; skill text, proposals and diffs render as source text.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { setAsideStrayEdit } from '../../../src/generated/stray';
import { writeSkillChange, type SkillChange } from '../../../src/knowledge';
import { MachineLocalStore } from '../../../src/machine-local';
import { bundledRules, createScanner } from '../../../src/scanner';
import { openTracker } from '../../../src/tracker';
import type { Clone, GitWorld } from '#harness';
import { choreAgent, dashboard, terminal, workPair } from '../../core/chore-support';
import { ok, PAGE, patchResult, proposer, readAll, SKILL, SKILL_V1, submit, type ProposerRun } from '../../core/proposer-support';
import { coreTest, fetchTrackerFrom, TRACKER_REF } from '../../core/support';
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

async function signedInPage(served: Served): Promise<HeadlessPage> {
  const page = await openHeadless(chromium!);
  const { url } = (await control(served.commonDir, served.env, 'sign-in')) as { url: string };
  await page.goto(url, `document.querySelector('.live-live') !== null`);
  return page;
}

/** One write through the dashboard's own op endpoint, as the signed-in person. */
async function post(served: Served, op: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cookie = await signedIn(served.port, served.commonDir, served.env);
  const reply = await request(served.port, { method: 'POST', path: `/api/op/${op}`, headers: writeHeaders(served.port, cookie), body: JSON.stringify(input) });
  if (reply.status !== 200) throw new Error(`${op} answered ${reply.status}: ${reply.body}`);
  return reply.json();
}

const at = (served: Served, route: string) => `http://127.0.0.1:${served.port}${route}`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;
const click = (page: HeadlessPage, selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

/** A patch citing exactly the evidence minimum: the page, two failing traces and the pass. */
function minimalPatch(p: ProposerRun): Record<string, unknown> {
  const fails = p.fails.slice(0, 2);
  const base = patchResult(p);
  return {
    ...base,
    citations: [`page:${PAGE}`, ...fails.map((t) => `trace:${t}`), `trace:${p.passes[0]}`, `skill:${SKILL}`],
    claims: { ...(base.claims as object), failures: fails.map((trace) => ({ trace, line: 'a fixed port was already taken' })) },
  };
}

describe('the proposal screen in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('after a cited failing trace is purged the live red flag shows; Accept stays disabled until it is acknowledged; the acknowledgement is recorded', async ({ served, world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, minimalPatch(p)));
    await post(served, 'purge_trace', { attempt: p.fails[0], reason: 'held a customer name' });
    const page = await signedInPage(served);
    try {
      // Attention leads with the pending proposal, its red flag counted.
      await page.goto(at(served, '/'), `document.querySelector('.att-proposal') !== null`);
      const item = await page.evaluate<{ title: string; detail: string; review: string }>(`(() => ({
        title: document.querySelector('.att-proposal .att-title').innerText,
        detail: document.querySelector('.att-proposal .att-detail').innerText,
        review: document.querySelector('.att-proposal a.review').getAttribute('href'),
      }))()`);

      await page.goto(at(served, item.review), `document.querySelector('.decbar .red-flag') !== null`);
      const before = await page.evaluate<Record<string, unknown>>(`(() => ({
        flags: [...document.querySelectorAll('.decbar .red-flag')].map((l) => l.innerText.trim()),
        accept: document.querySelector('button.accept').disabled,
        acceptEdit: document.querySelector('button.accept-edit').disabled,
        live: document.querySelector('.risk-flags .live-flag')?.innerText ?? '',
        purged: document.querySelector('.cited-trace[data-trace=${JSON.stringify(p.fails[0])}] .purged')?.innerText ?? '',
        evidence: document.querySelector('.evidence-row').innerText,
        sections: [...document.querySelectorAll('.proposal-screen h3')].map((h) => h.textContent),
        result: document.querySelector('.result-text').textContent,
        bodyDiff: [...document.querySelectorAll('.diff .add')].map((d) => d.textContent),
        scripts: document.querySelectorAll('.proposal-screen script').length,
      }))()`);
      await click(page, '.decbar .red-flag input');
      await page.waitFor(`!document.querySelector('button.accept').disabled`);
      await click(page, 'button.accept');
      await page.waitFor(`document.querySelector('.modal') !== null`);
      const recorded = await page.evaluate<string>(text('.modal .recorded'));
      await click(page, '.modal button.ok');
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.proposal-status')?.innerText.startsWith('accepted')`);
      const decided = await page.evaluate<string>(text('.decbar .decided'));
      const shown = ok(await grimoire.core.call('proposal_show', { id: proposal }, dashboard(grimoire.ctx)));

      expect(item.title).toContain(`Skill proposal pending: patch ${SKILL}`);
      expect(item.detail).toContain('1 red flag');
      expect(item.detail).toContain('3 cited trace');
      expect(item.review).toBe(`/knowledge/proposals/${proposal}`);
      expect(before.flags).toEqual([expect.stringContaining('I have read the red flag (computed now)')]);
      expect(before).toMatchObject({ accept: true, acceptEdit: true, purged: 'purged' });
      expect(before.live).toContain('red · now');
      expect(before.evidence).toContain('below the minimum');
      expect(before.sections).toEqual([
        'Grimoire’s checks',
        'Description change (shown first: it decides when agents load the skill)',
        'Body change',
        'Cited traces',
        'Cited pages',
        `Scorecard of ${SKILL} at its base (watch-only)`,
        `Ledger history for ${SKILL}`,
        'Full result',
        'The drafting agent’s rationale: unverified',
        'Decided proposals',
      ]);
      expect(before.result).toBe(shown.result.text);
      expect(before.bodyDiff).toContain('+ Bind test servers to port 0 and read the port back from the server.');
      expect(before.scripts).toBe(0);
      expect(recorded).toBe(`🔒 human-only · recorded as ${world.a.identity.email} through the dashboard`);
      expect(decided).toContain('acknowledged evidence');
      expect(shown).toMatchObject({ status: 'accepted', decision: { kind: 'accept', acks: ['evidence'], by: world.a.identity.email, actor: { client: 'dashboard' } } });
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});

const SEEDS = '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n';
const TIMEOUTS = '\n## Timeouts\n\nRaise a timeout only after finding what the test waits on.\n';

describe('the skill screens in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('the Restore dialog lists and diffs the dropped versions before restoring; Eject asks for a worktree and refuses an existing target', async ({ served, world, grimoire }) => {
    const { core, ctx } = grimoire;
    const cli = terminal(ctx);
    const v1 = ok(await core.call('skill_edit', { name: SKILL, text: SKILL_V1, base: null }, cli)).version;
    const v2 = ok(await core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${SEEDS}`, base: v1 }, cli)).version;
    const v3 = ok(await core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}${SEEDS}${TIMEOUTS}`, base: v2 }, cli)).version;
    await mkdir(path.join(world.a.dir, '.claude', 'skills', SKILL), { recursive: true });
    await writeFile(path.join(world.a.dir, '.claude', 'skills', SKILL, 'SKILL.md'), 'hand-written\n');
    const page = await signedInPage(served);
    try {
      await page.goto(at(served, '/knowledge/skills'), `document.querySelector('.skill-row') !== null`);
      const row = await page.evaluate<{ versions: string; state: string }>(
        `({ versions: document.querySelector('.skill-row .versions').innerText, state: document.querySelector('.skill-row .skill-state').innerText })`,
      );
      await page.goto(at(served, `/knowledge/skills/${SKILL}`), `document.querySelector('.version-row[data-version="${v1}"] button.restore') !== null`);
      const detail = await page.evaluate<{ text: string; scripts: number; rows: number }>(
        `({ text: document.querySelector('.skill-text').textContent, scripts: document.querySelectorAll('.skill-detail script').length, rows: document.querySelectorAll('.version-row').length })`,
      );
      await click(page, `.version-row[data-version="${v1}"] button.restore`);
      await page.waitFor(`document.querySelector('.modal .restore-plan') !== null`);
      const plan = await page.evaluate<{ undone: string; dropped: number; droppedAdds: string[]; title: string }>(`(() => ({
        title: document.querySelector('.modal h2').innerText,
        undone: document.querySelector('.modal .undone').innerText,
        dropped: document.querySelectorAll('.modal .dropped-version').length,
        droppedAdds: [...document.querySelectorAll('.modal .dropped-version .diff .add')].map((d) => d.textContent),
      }))()`);
      await click(page, '.modal button.ok');
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.version-row[data-version="${v1}"] .chip.acc') !== null`);
      const restored = ok(await core.call('skill_show', { name: SKILL }, dashboard(ctx))).skills[0]!;

      await click(page, 'button.eject');
      await page.waitFor(`document.querySelector('.modal select[name="worktree"]') !== null`);
      const eject = await page.evaluate<{ options: string[]; note: string }>(
        `({ options: [...document.querySelectorAll('.modal select[name="worktree"] option')].map((o) => o.value), note: document.querySelector('.modal .banner').innerText })`,
      );
      await click(page, '.modal button.ok');
      await page.waitFor(`document.querySelector('.dialog-error') !== null`);
      const refused = await page.evaluate<string>(text('.dialog-error'));
      await click(page, '.modal button.cancel');

      expect(row).toEqual({ versions: '3', state: 'active' });
      expect(detail).toMatchObject({ text: `${SKILL_V1}${SEEDS}${TIMEOUTS}`, scripts: 0, rows: 3 });
      expect(plan.title).toBe(`Restore ${SKILL} to ${v1.slice(0, 10)}?`);
      expect(plan.undone).toContain(v3.slice(0, 10));
      expect(plan.dropped).toBe(1);
      expect(plan.droppedAdds).toContain('+ ## Seeds');
      expect(restored).toMatchObject({ current: v1 });
      expect(restored.history!.at(-1)).toMatchObject({ kind: 'restore', version: v1 });
      expect(eject.options).toEqual([await realpath(world.a.dir)]);
      expect(eject.note).toContain('Commit and merge the ejected files');
      expect(refused).toContain(`.claude/skills/${SKILL} already exists`);
      expect(ok(await core.call('skill_show', { name: SKILL }, dashboard(ctx))).skills[0]).toMatchObject({ status: 'active', blocked: false });
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});

describe('the knowledge items of Attention in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('a stray edit’s Record makes it a version and Discard drops another; a fork’s Acknowledge picks the standing version', async ({ served, world, grimoire }) => {
    const { core, ctx } = grimoire;
    // No background push: the fork below is made by hand between the two clones.
    ok(await core.call('settings_set', { key: 'auto-sync', value: false }, terminal(ctx)));
    const v1 = ok(await core.call('skill_edit', { name: 'release-notes', text: notes('Create `changes/<slug>.md`.'), base: null }, terminal(ctx))).version;
    const store = new MachineLocalStore(served.commonDir);
    const copy = '.claude/skills/grimoire-release-notes/SKILL.md';
    const kept = notes('Create `changes/<slug>.md`, then bump the version.');
    const recordable = await setAsideStrayEdit(store, { skill: 'release-notes', worktree: world.a.dir, path: copy, text: kept, base: v1, served: v1 });
    const dropped = await setAsideStrayEdit(store, { skill: 'release-notes', worktree: world.a.dir, path: copy, text: notes('Never mind.'), base: v1, served: v1 });
    const page = await signedInPage(served);
    try {
      await page.goto(at(served, '/'), `document.querySelectorAll('.att-stray').length === 2`);
      // Record the first, discard the second.
      await recordOrDiscard(page, recordable.id, 'record');
      await page.waitFor(`document.querySelectorAll('.att-stray').length === 1`);
      await recordOrDiscard(page, dropped.id, 'discard');
      await page.waitFor(`document.querySelectorAll('.att-stray').length === 0`);
      const afterStrays = ok(await core.call('skill_show', { name: 'release-notes' }, dashboard(ctx))).skills[0]!;
      const left = ok(await core.call('skill_strays', {}, dashboard(ctx))).stray_edits;

      // A fork: two clones accept apart from the recorded version, and clone a fetches b's.
      await share(world);
      const fromAlice = notes('Alice’s way.');
      const fromBob = notes('Bob’s way.');
      await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-alice', text: fromAlice });
      await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-bob', text: fromBob });
      await fetchTrackerFrom(world.a, world.b);
      await page.waitFor(`document.querySelector('.att-fork') !== null`, 30_000);
      const fork = await page.evaluate<string>(text('.att-fork .att-title'));
      const standing = ok(await core.call('skill_show', { name: 'release-notes' }, dashboard(ctx))).skills[0]!.current!;
      await click(page, '.att-fork button.acknowledge');
      await page.waitFor(`document.querySelector('.modal input[name="version"]') !== null`);
      const choices = await page.evaluate<{ value: string; checked: boolean }[]>(`[...document.querySelectorAll('.modal input[name="version"]')].map((i) => ({ value: i.value, checked: i.checked }))`);
      await click(page, '.modal button.ok');
      await page.waitFor(`document.querySelector('.modal') === null && document.querySelector('.att-fork') === null`);
      const settled = ok(await core.call('skill_show', { name: 'release-notes' }, dashboard(ctx))).skills[0]!;

      expect(afterStrays.history!.at(-1)).toMatchObject({ kind: 'record' });
      expect(afterStrays.text).toBe(kept);
      expect(left).toEqual([]);
      expect(fork).toBe('Skill fork to pick: release-notes');
      expect(choices).toHaveLength(2);
      expect(choices.filter((choice) => choice.checked)).toEqual([{ value: standing, checked: true }]);
      expect(settled).toMatchObject({ current: standing, superseded: [], acknowledge: [] });
      expect(settled.history!.at(-1)).toMatchObject({ kind: 'acknowledge', version: standing });
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});

describe('chore runs and the overview in a browser, under the CSP', () => {
  startTest.skipIf(!chromium)('the list shows origin, isolation, outcome and reason codes; a refused result’s kept text is viewable here, and a secret-scan failure has none', async ({ served, grimoire }) => {
    // On the real clock, as start reads it: an open run's lease is live, and pairs settle at once.
    const core = grimoire.makeCore({ clock: () => new Date() });
    ok(await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx)));
    ok(await core.call('settings_set', { key: 'chores.settle_hours', value: 0 }, terminal(grimoire.ctx)));
    await workPair(core, grimoire.ctx, 'fail', 'Port clash');
    const chores = await choreAgent(grimoire.ctx);
    const token = ['ghp', 'R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u'].join('_');
    const create = (body: string) => ({ op: 'create', slug: 'ci-pushes', title: 'CI pushes', kind: 'failure', summary: 'About CI pushes.', body });
    const secret = ok(await core.call('chore_start', {}, chores));
    await readAll(core, chores, secret.run);
    const consumption = secret.pairs.map((pair) => ({ pair: pair.pair, slugs: ['ci-pushes'] }));
    for (let i = 0; i < 2; i++) await core.call('chore_submit', { run: secret.run, result: { pages: [create(`Push with ${token}.\n`)], consumption } }, chores);
    const open = ok(await core.call('chore_start', {}, chores));
    await readAll(core, chores, open.run);
    const refused = { pages: [create('<img src=x onerror="window.__pwned=1"> KEEP-ME-LOCAL\n')], consumption: [] };
    ok(await core.call('chore_submit', { run: open.run, result: refused }, chores));
    const page = await signedInPage(served);
    try {
      await page.goto(at(served, '/knowledge/runs'), `document.querySelectorAll('.chore-run').length === 2`);
      const rows = await page.evaluate<Record<string, unknown>[]>(`[...document.querySelectorAll('.chore-run')].map((row) => ({
        run: row.dataset.run,
        origin: row.querySelector('.origin').innerText,
        outcome: row.querySelector('.outcome').innerText,
        reasons: row.querySelector('.reasons')?.innerText ?? '',
        secret: row.querySelector('.kept-secret')?.innerText ?? '',
        view: row.querySelector('.view-kept') !== null,
      }))`);
      const body = await page.evaluate<string>('document.body.innerText');
      await click(page, `.chore-run[data-run="${open.run}"] .view-kept`);
      await page.waitFor(`document.querySelector('.modal .kept-text') !== null`);
      const keptText = await page.evaluate<{ text: string; images: number; pwned: unknown }>(
        `({ text: document.querySelector('.modal .kept-text').textContent, images: document.querySelectorAll('.modal img').length, pwned: window.__pwned ?? null })`,
      );
      await click(page, '.modal button.ok');

      await page.goto(at(served, '/knowledge'), `document.querySelector('.knowledge-tiles') !== null && document.querySelector('.runner-panel') !== null`);
      const overview = await page.evaluate<Record<string, string>>(`({
        tiles: document.querySelector('.knowledge-tiles').innerText,
        due: document.querySelector('.due-panel').innerText,
        runner: document.querySelector('.runner-panel').innerText,
        runs: String(document.querySelectorAll('.overview .chore-run').length),
      })`);

      expect(rows).toEqual([
        { run: open.run, origin: 'session · claude-chore-agent', outcome: 'open', reasons: '', secret: '', view: true },
        { run: secret.run, origin: 'session · claude-chore-agent', outcome: 'failed', reasons: 'secret', secret: 'secret-scan failure: no text kept (rules github-pat)', view: false },
      ]);
      expect(body).not.toContain(token);
      expect(body).not.toContain('KEEP-ME-LOCAL');
      expect(keptText).toEqual({ text: JSON.stringify(refused), images: 0, pwned: null });
      expect(overview.tiles).toContain('Knowledge loop');
      expect(overview.tiles).toContain('0 / 8');
      expect(overview.due).toContain('Wiki Maintainer');
      expect(overview.runner).toContain('Not enabled on this machine');
      expect(overview.runs).toBe('2');
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
    }
  });
});

/** Clicks Record or Discard on the stray-edit row of `id` and confirms. */
async function recordOrDiscard(page: HeadlessPage, id: string, action: 'record' | 'discard'): Promise<void> {
  const button = action === 'record' ? 'button.record-stray' : 'button.discard-stray';
  await page.evaluate(`document.querySelector('.att-stray[data-id=${JSON.stringify(id)}] ${button}').click()`);
  await page.waitFor(`document.querySelector('.modal') !== null`);
  await page.evaluate(`document.querySelector('.modal button.ok').click()`);
  await page.waitFor(`document.querySelector('.modal') === null`);
}

function notes(line: string): string {
  return `---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\n${line}\n`;
}

async function decide(clone: Clone, change: SkillChange): Promise<void> {
  const store = await openTracker(clone.dir);
  try {
    const author = { name: clone.identity.name, email: clone.identity.email };
    await store.transact({ op: change.kind, author, actor: { kind: 'human', client: 'dashboard', nonce: 'n' } }, async (draft) => {
      await writeSkillChange(draft, createScanner(bundledRules), change, {
        actor: { kind: 'human' },
        by: clone.identity.email,
        surface: 'dashboard',
        clone: clone.identity.email.startsWith('alice') ? 'c10e00000000000a' : 'c10e00000000000b',
      });
      return { result: null };
    });
  } finally {
    await store.close();
  }
}

/** Clone b takes a's tracker as its own (straight from a, never through the remote), so the two write apart from here. */
async function share(world: GitWorld): Promise<void> {
  await fetchTrackerFrom(world.b, world.a);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}
