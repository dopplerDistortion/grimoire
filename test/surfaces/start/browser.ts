// A headless Chromium driven over the DevTools protocol, for the CSP check
// (spec Testing Decisions: "a CI check that loads the built dashboard under
// the exact CSP header and fails on any violation"). Node's own WebSocket
// speaks to it, so the check needs no browser-automation dependency: only a
// Chrome, Chromium or Edge on the machine (GRIMOIRE_TEST_BROWSER names one).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, removeDir } from '#harness';

/** A Chromium-family browser on this machine, or null. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GRIMOIRE_TEST_BROWSER) return existsSync(env.GRIMOIRE_TEST_BROWSER) ? env.GRIMOIRE_TEST_BROWSER : null;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) candidates.push(path.join(dir, name));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

/** One DevTools connection: commands with replies, and event listeners. */
class Cdp {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<Listener>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`couldn't connect to ${url}`)), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, listener: Listener): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
  }

  close(): void {
    this.socket.close();
  }
}

/** What a page did under its CSP. */
export interface PageReport {
  /** `securitypolicyviolation` events, and console entries that report a CSP violation. */
  readonly violations: string[];
  /** Uncaught script errors. */
  readonly errors: string[];
}

export interface HeadlessPage {
  /** Navigates and waits until `ready` (a JS expression) is true. */
  goto(url: string, ready: string, timeoutMs?: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** Waits until `ready` (a JS expression) is true on the current page. */
  waitFor(ready: string, timeoutMs?: number): Promise<void>;
  /** The URLs the page requested so far, in order. */
  requests(): string[];
  report(): Promise<PageReport>;
  /** A PNG of the viewport at `width` x `height` (for looking at a failure). */
  screenshot(width?: number, height?: number): Promise<Buffer>;
  close(): Promise<void>;
}

const COLLECT = `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' blocked ' + e.blockedURI + ' at ' + e.sourceFile + ':' + e.lineNumber));`;

/** Launches `executable` headless with a fresh profile and opens one page. */
export async function openHeadless(executable: string): Promise<HeadlessPage> {
  const profile = await makeTempDir('grimoire-chromium-');
  const child: ChildProcess = spawn(
    executable,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore', windowsHide: true },
  );
  const quit = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 5_000);
      });
    }
    await removeDir(profile).catch(() => {});
  };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 30_000;
    let lines: string[] = [];
    while (lines.length < 2) {
      if (Date.now() > deadline) throw new Error(`${executable} didn't open its DevTools port`);
      lines = (await readFile(portFile, 'utf8').catch(() => '')).split('\n').filter((line) => line.trim() !== '');
      if (lines.length < 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cdp = await Cdp.connect(`ws://127.0.0.1:${lines[0]!.trim()}${lines[1]!.trim()}`);
    const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    const consoleViolations: string[] = [];
    const errors: string[] = [];
    const requested: string[] = [];
    cdp.on('Network.requestWillBeSent', (params, from) => {
      if (from === sessionId) requested.push((params.request as { url: string }).url);
    });
    cdp.on('Log.entryAdded', (params, from) => {
      const entry = params.entry as { text?: string; source?: string };
      if (from === sessionId && /Content Security Policy/i.test(entry.text ?? '')) consoleViolations.push(entry.text ?? '');
    });
    cdp.on('Runtime.consoleAPICalled', (params, from) => {
      const text = JSON.stringify(params.args ?? []);
      if (from === sessionId && /Content Security Policy/i.test(text)) consoleViolations.push(text);
    });
    cdp.on('Runtime.exceptionThrown', (params, from) => {
      if (from === sessionId) errors.push(JSON.stringify((params.exceptionDetails as { text?: string; exception?: { description?: string } }).exception?.description ?? params.exceptionDetails));
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT }, sessionId);

    const evaluate = async <T>(expression: string): Promise<T> => {
      const { result, exceptionDetails } = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)) as {
        result: { value?: T };
        exceptionDetails?: unknown;
      };
      if (exceptionDetails) throw new Error(`evaluating ${expression} threw: ${JSON.stringify(exceptionDetails)}`);
      return result.value as T;
    };
    let collected: string[] = [];
    const harvest = async () => {
      collected = [...collected, ...((await evaluate<string[] | undefined>('window.__cspViolations ?? []')) ?? [])];
    };
    const waitFor = async (ready: string, timeoutMs = 20_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const done = await evaluate<boolean>(`Boolean(${ready})`).catch(() => false);
        if (done) return;
        if (Date.now() > until) throw new Error(`the page never became ready (${ready}); page text: ${await evaluate<string>('document.body?.innerText ?? ""').catch(() => '?')}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return {
      async goto(url, ready, timeoutMs = 20_000) {
        await harvest().catch(() => {});
        await cdp.send('Page.navigate', { url }, sessionId);
        await waitFor(ready, timeoutMs);
      },
      evaluate,
      waitFor,
      requests: () => [...requested],
      async report() {
        await harvest();
        const violations = [...collected, ...consoleViolations];
        collected = [];
        return { violations, errors: [...errors] };
      },
      async screenshot(width = 1400, height = 900) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)) as { data: string };
        return Buffer.from(data, 'base64');
      },
      async close() {
        await cdp.send('Browser.close').catch(() => {});
        cdp.close();
        await quit();
      },
    };
  } catch (error) {
    await quit();
    throw error;
  }
}
