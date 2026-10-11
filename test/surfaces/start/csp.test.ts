// The CSP check (spec Testing Decisions, §20): the built dashboard, served by
// a real `start` under the exact CSP header, loads in a headless Chromium with
// zero violations: no inline script or style, no modulepreload polyfill. The
// build's own files are checked too, so the rule holds even where no browser
// is installed (CI sets CI=1, which makes a missing browser a failure). The
// same browser checks how the shell takes live events: a reload refetches in
// place, and a session lost to a restart shows the signed-out page.
import { readdir, readFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { putMachineSetting } from '../../../src/core/settings';
import { coreTest } from '../../core/support';
import { findChromium, openHeadless } from './browser';
import { buildFull, control, signedIn, spawnStart, SseClient, startEnv, stopStart, type StartProcess } from './support';

let bin: string;
let dist: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, dist, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

const chromium = findChromium();

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('the dashboard under its CSP', () => {
  test('the built app has no inline script or style and no modulepreload polyfill', async () => {
    const root = path.join(dist, 'dashboard');
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const assets = await readdir(path.join(root, 'assets'));
    const scripts = await Promise.all(assets.filter((name) => name.endsWith('.js')).map((name) => readFile(path.join(root, 'assets', name), 'utf8')));

    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scriptTags) {
      expect(attributes).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
      expect(body!.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    for (const script of scripts) {
      // Vite's modulepreload polyfill feature-tests relList.supports("modulepreload").
      expect(script).not.toContain('relList');
    }
  });

  if (!chromium && process.env.CI) {
    test('a Chromium-family browser is installed for the CSP check', () => {
      expect(chromium, 'install Chrome, Chromium or Edge, or set GRIMOIRE_TEST_BROWSER').not.toBeNull();
    });
  }

  coreTest.skipIf(!chromium)('the signed-out page and the signed-in shell load with zero CSP violations', async ({ world }) => {
    const { env } = await startEnv(world.root);
    const commonDir = path.join(world.a.dir, '.git');
    const start = await spawnStart(bin, world.a.dir, env);
    const page = await openHeadless(chromium!);
    try {
      await page.goto(`http://127.0.0.1:${start.port}/`, `document.body.innerText.includes('Open the dashboard from your terminal')`);
      const signedOut = await page.report();
      const { url } = (await control(commonDir, env, 'sign-in')) as { url: string };
      await page.goto(url, `document.querySelector('.live-live') !== null`);
      const signedIn = await page.report();
      const address = await page.evaluate<string>('location.href');
      const styled = await page.evaluate<string>('getComputedStyle(document.querySelector(".shell")).display');

      expect(signedOut).toEqual({ violations: [], errors: [] });
      expect(signedIn).toEqual({ violations: [], errors: [] });
      // The code left the address bar; the stylesheet applied.
      expect(address).toBe(`http://127.0.0.1:${start.port}/`);
      expect(styled).toBe('grid');
    } finally {
      await page.close();
      await stopStart(start, commonDir, env);
    }
  });
});

describe('the shell’s live events in a browser', () => {
  coreTest.skipIf(!chromium)('a reload event refetches without reloading the page, so drafts, focus and scroll survive', async ({ world, grimoire }) => {
    const { env } = await startEnv(world.root);
    const commonDir = path.join(world.a.dir, '.git');
    const start = await spawnStart(bin, world.a.dir, env);
    const page = await openHeadless(chromium!);
    try {
      const core = grimoire.makeCore();
      await core.call('create', { title: 'Before' }, grimoire.ctx);
      const before = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);
      const { url } = (await control(commonDir, env, 'sign-in')) as { url: string };
      await page.goto(url, `document.querySelector('.live-live') !== null`);
      // Another stream on the same instance shows when the server has seen each tip.
      const watcher = await SseClient.connect(start.port, await signedIn(start.port, commonDir, env));
      await watcher.next((event) => event.event === 'ready');
      await page.evaluate(`window.__draft = 'kept'`);
      const count = (path: string) => page.requests().filter((requested) => new URL(requested).pathname === path).length;
      const instanceReads = count('/api/instance');
      const streams = count('/api/events');

      await core.call('create', { title: 'Rewound' }, grimoire.ctx);
      await watcher.next((event) => event.event === 'change');
      // A rewritten history: the tip the stream saw is no longer in the new one.
      await world.a.git(['update-ref', 'refs/grimoire/tracker', before]);
      await watcher.next((event) => event.event === 'reload');
      for (const until = Date.now() + 10_000; count('/api/instance') === instanceReads && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 100));
      watcher.close();

      // It read the instance again, on the same page and the same stream.
      expect(count('/api/instance')).toBeGreaterThan(instanceReads);
      expect(await page.evaluate<string>('window.__draft')).toBe('kept');
      expect(count('/api/events')).toBe(streams);
      expect(await page.report()).toEqual({ violations: [], errors: [] });
    } finally {
      await page.close();
      await stopStart(start, commonDir, env);
    }
  });

  coreTest.skipIf(!chromium)('after start restarts, an open tab whose session is gone shows the signed-out page', async ({ world }) => {
    const { env } = await startEnv(world.root);
    const commonDir = path.join(world.a.dir, '.git');
    // Both starts listen on the same port, as a restart does.
    const port = await freePort();
    await putMachineSetting(commonDir, 'dashboard.port', port);
    const first = await spawnStart(bin, world.a.dir, env);
    const page = await openHeadless(chromium!);
    let second: StartProcess | null = null;
    try {
      const { url } = (await control(commonDir, env, 'sign-in')) as { url: string };
      await page.goto(url, `document.querySelector('.live-live') !== null`);

      await stopStart(first, commonDir, env);
      second = await spawnStart(bin, world.a.dir, env);
      await page.waitFor(`document.body.innerText.includes('Open the dashboard from your terminal')`, 20_000);

      expect(first.port).toBe(port);
      expect(second.port).toBe(port);
    } finally {
      await page.close();
      if (second) await stopStart(second, commonDir, env);
    }
  });
});
