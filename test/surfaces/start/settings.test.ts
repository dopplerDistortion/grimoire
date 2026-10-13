// Seam 3 plus the browser smoke test (spec §20 Settings, Shell, Full-page
// states; §12 the pin banner; §14 The setting): the real `start` serving the
// built dashboard to a headless Chromium under the exact CSP.
//
// - A store-setting change shows the scope dialog; the excerpt mode re-shows
//   the disclosure, and tightening strips open attempts' excerpt text in the
//   same commit. Cancelling a change commits nothing.
// - Machine settings save at once, on this machine only; the runner, session
//   and purged-records panels render.
// - Sync now runs fetch → fold → push, and the panel and the footer's chip
//   follow live.
// - NOT_SYNCED and UPGRADE_REQUIRED are full pages with their remedies, never
//   an empty board; a pin change under a running start shows the banner while
//   serving goes on.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { sessionKey } from '../../../src/capture/seen-here';
import { MachineLocalStore } from '../../../src/machine-local';
import { agentContext, commitToTracker, coreTest, fetchTracker, pushTracker, TRACKER_REF, trackerTip } from '../../core/support';
import { nameRoot, remoteTracker, rootOf } from '../../core/sync-support';
import { findChromium, openHeadless, type HeadlessPage } from './browser';
import { buildFull, control, request, spawnStart, startEnv, stopStart, type StartProcess } from './support';

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

/** coreTest plus `serve(dir)`: a `start` in `dir`, stopped before the world is removed. */
const servingTest = coreTest.extend('serve', async ({ world, grimoire: _ }, { onCleanup }) => {
  const started: Served[] = [];
  onCleanup(async () => {
    for (const served of started.reverse()) await stopStart(served.start, served.commonDir, served.env);
  });
  return async (dir: string, name = 'env', useBin = bin): Promise<Served> => {
    const { env } = await startEnv(path.join(world.root, name));
    const start = await spawnStart(useBin, dir, env);
    const served: Served = { start, port: start.port, commonDir: path.join(dir, '.git'), env };
    started.push(served);
    return served;
  };
});

const browserTest = servingTest.extend('page', async ({ serve: _ }, { onCleanup }) => {
  const pages: HeadlessPage[] = [];
  onCleanup(async () => {
    for (const page of pages) await page.close();
  });
  return {
    /** A headless page signed in to `served`, landing on `at`, once `ready` holds. */
    async open(served: Served, at: string, ready: string): Promise<HeadlessPage> {
      const page = await openHeadless(chromium!);
      pages.push(page);
      const { url } = (await control(served.commonDir, served.env, 'sign-in')) as { url: string };
      await page.goto(url, `document.querySelector('.live-live') !== null || document.querySelector('.gate') !== null`);
      await page.goto(`http://127.0.0.1:${served.port}${at}`, ready);
      return page;
    },
  };
});

/** Picks `value` in the select of setting `key`, as a person would. */
const pick = (key: string, value: string) =>
  `(() => { const s = document.querySelector('.setting-row[data-key="${key}"] select'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const text = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`;
const SETTINGS_READY = `document.querySelector('.setting-row[data-key="excerpts"] select') !== null && document.querySelector('.live-live') !== null`;

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

describe('the Settings screen in a browser, under the CSP', () => {
  browserTest.skipIf(!chromium)('the excerpt mode: the scope dialog, the disclosure again, and tightening strips open attempts’ text in the same commit', async ({ world, grimoire, page, serve }) => {
    const served = await serve(world.a.dir);
    const tab = await page.open(served, '/settings', SETTINGS_READY);

    // Loosening facts → excerpts: the scope dialog, then the disclosure with the warning.
    await tab.evaluate(pick('excerpts', 'excerpts'));
    await tab.waitFor(`document.querySelector('.modal') !== null`);
    const scope = await tab.evaluate<string>(text('.modal'));
    await tab.evaluate(`document.querySelector('.modal button.ok').click()`);
    await tab.waitFor(`document.querySelector('.modal .disclosure') !== null`);
    const loosened = await tab.evaluate<string>(text('.modal .disclosure'));
    await tab.evaluate(`document.querySelector('.modal button.ok').click()`);
    await tab.waitFor(`document.querySelector('.modal') === null`);

    // An open attempt whose session record carries excerpt text.
    const agent = agentContext(world.b, world.a);
    const created = await grimoire.core.call('create', { title: 'Still open' }, agent);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = created.result.id;
    const claimed = await grimoire.core.call('claim', { id }, agent);
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const record = sessionRecord();
    const recordPath = `attempts/${id[3]}/${id[4]}/${id}/${claimed.result.attempt}/sessions/${record.key}.md`;
    await commitToTracker(world.a, { [recordPath]: record.bytes });
    const before = (await trackerTip(world.a))!;

    // Tightening excerpts → facts.
    await tab.waitFor(`document.querySelector('.setting-row[data-key="excerpts"] select').value === 'excerpts'`);
    await tab.evaluate(pick('excerpts', 'facts'));
    await tab.waitFor(`document.querySelector('.modal') !== null`);
    const tightening = await tab.evaluate<string>(text('.modal'));
    await tab.evaluate(`document.querySelector('.modal button.ok').click()`);
    await tab.waitFor(`document.querySelector('.modal .disclosure') !== null`);
    const tightened = await tab.evaluate<string>(text('.modal .disclosure'));
    const after = (await trackerTip(world.a))!;

    expect(scope).toContain('Change Session excerpts in traces?');
    expect(scope).toContain('Committed on grimoire/tracker; every worktree now, every clone after sync.');
    expect(scope).toContain(`🔒 human-only · recorded as ${world.a.identity.email} through the dashboard`);
    expect(scope).toContain('teammates aren’t asked');
    expect(loosened).toContain('Excerpt mode: excerpts.');
    expect(loosened).toContain('Redaction is best-effort: a secret can slip through.');
    expect(loosened).toContain('every clone applies it at its next cut, and teammates aren’t asked');
    expect(tightening).toContain('Tightening strips the excerpt text from every open attempt’s session records in the same commit.');
    expect(tightened).toContain('Excerpt mode: facts.');
    expect(tightened).toContain('Stripped the excerpt text from 1 open attempt session record in the same commit.');
    // One commit, by the person through the dashboard: the setting and the stripped record.
    expect(await world.a.git(['rev-list', '--count', `${before}..${after}`])).toBe('1');
    expect((await world.a.git(['diff', '--name-only', before, after])).split('\n').sort()).toEqual([recordPath, 'settings.yml'].sort());
    expect(await world.a.git(['cat-file', 'blob', `${after}:${recordPath}`])).not.toContain('a token pasted here');
    const message = await world.a.git(['log', '-1', '--format=%B', after]);
    expect(message).toContain('Grimoire-Op: settings-set');
    expect(message).toContain('"kind":"human","client":"dashboard"');
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });

  browserTest.skipIf(!chromium)('a cancelled store change commits nothing; machine settings save at once; the runner, session and purged panels render', async ({ world, page, serve }) => {
    const served = await serve(world.a.dir);
    const tab = await page.open(served, '/settings', SETTINGS_READY);
    const before = await trackerTip(world.a);

    await tab.evaluate(pick('skills.delivery', 'false'));
    await tab.waitFor(`document.querySelector('.modal') !== null`);
    const delivery = await tab.evaluate<string>(text('.modal'));
    await tab.evaluate(`document.querySelector('.modal button.cancel').click()`);
    await tab.waitFor(`document.querySelector('.modal') === null`);
    const reverted = await tab.evaluate<string>(`document.querySelector('.setting-row[data-key="skills.delivery"] select').value`);

    await tab.evaluate(pick('knowledge.pickup', 'auto'));
    await tab.waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.innerText.includes('Saved on this machine only.'))`);
    const pickup = await new MachineLocalStore(served.commonDir).records.read('machine-settings', 'knowledge.pickup');
    const panels = await tab.evaluate<Record<string, string>>(`({ runner: ${text('.runner-panel')}, session: ${text('.session-panel')}, purged: ${text('.purged-panel')} })`);

    expect(delivery).toContain('Turning delivery off removes every evolved-skill copy and stub from every worktree');
    expect(reverted).toBe('true');
    expect(await trackerTip(world.a)).toBe(before);
    expect(pickup).toBe('auto');
    expect(panels.runner).toContain('Not enabled on this machine.');
    expect(panels.runner).toContain('grimoire runner enable claude');
    expect(panels.session).toContain(`Signed in as ${world.a.identity.email}`);
    expect(panels.purged).toContain('None.');
    expect(panels.purged).toContain('Pushed git history keeps purged content');
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });

  browserTest.skipIf(!chromium)('Sync now runs fetch → fold → push, and the panel and the footer chip follow live', async ({ world, grimoire, page, serve }) => {
    // Both clones write apart from one published tracker: a is ahead of what it last fetched, and the remote has b's write.
    await pushTracker(world.a);
    await fetchTracker(world.a);
    await fetchTracker(world.b);
    const bob = agentContext(world.b);
    const theirs = await grimoire.core.call('create', { title: 'Bob’s' }, bob);
    expect(theirs.ok).toBe(true);
    await pushTracker(world.b);
    const mine = await grimoire.core.call('create', { title: 'Alice’s' }, agentContext(world.a));
    expect(mine.ok).toBe(true);
    const served = await serve(world.a.dir);
    const tab = await page.open(served, '/settings', `${SETTINGS_READY} && document.querySelector('.sync-chip') !== null && document.querySelector('.sync-position') !== null`);
    const chipBefore = await tab.evaluate<string>(text('.sync-chip'));
    const positionBefore = await tab.evaluate<string>(text('.sync-position'));

    await tab.evaluate(`document.querySelector('.sync-panel .sync-now').click()`);
    await tab.waitFor(`${text('.sync-chip')}.startsWith('in sync') && ${text('.sync-position')}.startsWith('in sync')`, 60_000);
    const last = await tab.evaluate<string>(text('.sync-last'));

    expect(chipBefore).toMatch(/^↑1/);
    expect(positionBefore).toContain('↑1');
    expect(last).toContain('just now');
    expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
    // The fold kept both writes.
    expect(await world.a.git(['log', '--format=%s', TRACKER_REF])).toMatch(/fold/);
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });
});

describe('full pages and the pin banner, in a browser', () => {
  browserTest.skipIf(!chromium)('a clone whose config.yml names a root no ref holds shows NOT_SYNCED with its remedy, never an empty board; Sync now brings the board', async ({ world, page, serve }) => {
    await nameRoot(world.b.dir, await rootOf(world.a));
    // Run as the version copy a join leaves (pkg/<v>/dist beside .complete): the checkout's pin, run here.
    const copy = path.join(world.root, 'pkg', '0.0.0');
    await cp(path.dirname(bin), path.join(copy, 'dist'), { recursive: true });
    await writeFile(path.join(copy, '.complete'), '{}');
    const served = await serve(world.b.dir, 'b-env', path.join(copy, 'dist', 'grimoire.mjs'));
    const tab = await page.open(served, '/issues', `document.querySelector('.gate') !== null`);
    const gate = await tab.evaluate<{ text: string; sidebar: boolean; rows: number }>(
      `({ text: ${text('.gate-not-synced')}, sidebar: document.querySelector('.sidebar') !== null, rows: document.querySelectorAll('table tr').length })`,
    );

    await pushTracker(world.a);
    await tab.evaluate(`document.querySelector('.gate .sync-now').click()`);
    await tab.waitFor(`document.querySelector('.gate') === null && document.querySelector('.sidebar') !== null`, 60_000);

    expect(gate.text).toContain('NOT_SYNCED');
    expect(gate.text).toContain("isn't in this clone yet");
    expect(gate.text).toContain('run `grimoire sync` (or a plain `git fetch`) to fetch grimoire/tracker from the remote');
    expect(gate.sidebar).toBe(false);
    expect(gate.rows).toBe(0);
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });

  browserTest.skipIf(!chromium)('UPGRADE_REQUIRED renders its remedies in order', async ({ world, page, serve }) => {
    // Machine-local data from a newer release.
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, 'format'), 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');
    const served = await serve(world.a.dir);
    const tab = await page.open(served, '/', `document.querySelector('.gate-upgrade') !== null`);
    const remedies = await tab.evaluate<string[]>(`[...document.querySelectorAll('.gate-upgrade .remedy')].map((li) => li.innerText)`);
    const sidebar = await tab.evaluate<boolean>(`document.querySelector('.sidebar') !== null`);

    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toContain('npx @goksening/grimoire@2.0.0 init --upgrade');
    expect(remedies[1]).toContain('join grimoire 2.0.0 on this machine');
    expect(sidebar).toBe(false);
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });

  browserTest.skipIf(!chromium)('a pin change under a running start shows the banner, and serving goes on', async ({ world, grimoire, page, serve }) => {
    const created = await grimoire.core.call('create', { title: 'Still served' }, agentContext(world.a));
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const served = await serve(world.a.dir);
    const tab = await page.open(served, '/issues', `document.querySelector('.live-live') !== null && document.body.innerText.includes('Still served')`);
    const bannerBefore = await tab.evaluate<boolean>(`document.querySelector('.pin-banner') !== null`);

    await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), 'version: 9.9.9\ninstall_format: 1\n');
    await tab.waitFor(`document.querySelector('.pin-banner') !== null`);
    const banner = await tab.evaluate<string>(text('.pin-banner'));
    await tab.goto(`http://127.0.0.1:${served.port}/issues`, `document.querySelector('.pin-banner') !== null && document.body.innerText.includes('Still served')`);
    const health = await request(served.port, { path: '/health' });

    expect(bannerBefore).toBe(false);
    expect(banner).toBe('this worktree now pins 9.9.9; restart `start`');
    expect(health.status).toBe(200);
    expect(served.start.child.exitCode).toBeNull();
    expect(await tab.report()).toEqual({ violations: [], errors: [] });
  });
});
