// The CSP check (spec Testing Decisions, §20): the built dashboard, served by
// a real `start` under the exact CSP header, loads in a headless Chromium with
// zero violations: no inline script or style, no modulepreload polyfill. The
// build's own files are checked too, so the rule holds even where no browser
// is installed (CI sets CI=1, which makes a missing browser a failure).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { coreTest } from '../../core/support';
import { findChromium, openHeadless } from './browser';
import { buildFull, control, spawnStart, startEnv, stopStart } from './support';

let bin: string;
let dist: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, dist, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

const chromium = findChromium();

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
