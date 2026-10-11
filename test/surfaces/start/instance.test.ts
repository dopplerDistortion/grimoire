// Seam 3: one `start` per clone (spec §12): the start lock, a second `start`,
// the control channel, `open`, and `show`'s `local_link`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { cloneId, MachineLocalStore } from '../../../src/machine-local';
import { callControl, ControlError, controlPaths } from '../../../src/surfaces/start/control';
import { coreTest } from '../../core/support';
import { cli, cliAtTerminal, lastJsonOnScreen } from '../cli/support';
import { buildFull, codeOf, exchange, request, signedIn, spawnStart, startEnv, startLockOf, stopStart, type StartProcess } from './support';

let bin: string;
let otherBin: string;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  const [main, other] = await Promise.all([buildFull(), buildFull('9.9.9', 'cli')]);
  bin = main.bin;
  otherBin = other.bin;
  cleanups.push(main.cleanup, other.cleanup);
}, 300_000);
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const MARKED = { AI_AGENT: 'claude-code_2-1-296_agent', CLAUDE_CODE_CHILD_SESSION: '1' };

/** coreTest plus what a `start` in clone a needs; every start a test spawns is stopped after it. */
const instanceTest = coreTest.extend('clone', async ({ world, grimoire: _ }, { onCleanup }) => {
  const { env, opened } = await startEnv(world.root);
  const commonDir = path.join(world.a.dir, '.git');
  const started: StartProcess[] = [];
  onCleanup(async () => {
    for (const start of started.reverse()) await stopStart(start, commonDir, env);
  });
  return {
    dir: world.a.dir,
    commonDir,
    env,
    opened,
    async start(args?: readonly string[], useBin = bin): Promise<StartProcess> {
      const start = await spawnStart(useBin, world.a.dir, env, args);
      started.push(start);
      return start;
    },
  };
});

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('start: one instance per clone', () => {
  instanceTest('a second start signs a browser in to the running one and exits 0', async ({ clone }) => {
    const first = await clone.start();

    const second = await cli(bin, ['start'], { cwd: clone.dir, env: clone.env });
    const [url] = await clone.opened();
    const { cookie } = await exchange(first.port, codeOf(url!));
    const lock = await startLockOf(clone.commonDir);

    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({
      running: { url: `http://127.0.0.1:${first.port}/`, port: first.port, version: '0.0.0', pid: first.child.pid },
      signed_in: true,
      version_differs: false,
    });
    // No secret on stdout without a terminal.
    expect(second.stdout).not.toContain(codeOf(url!));
    expect(cookie).not.toBeNull();
    expect(lock?.pid).toBe(first.child.pid);
  });

  instanceTest('at a terminal, a second start of another version says so and offers to take over: declined, it signs in to the running one', async ({ clone }) => {
    const first = await clone.start();

    const run = await cliAtTerminal(otherBin, ['start', '--no-open'], {
      cwd: clone.dir,
      env: clone.env,
      answers: [{ when: /Stop it and start 9\.9\.9 instead\? \[y\/N\]/, type: 'n' }],
    });

    expect(run.code).toBe(0);
    expect(run.screen).toContain('grimoire start 0.0.0 already serves this clone');
    expect(run.screen).toMatch(/Sign in: http:\/\/127\.0\.0\.1:\d+\/login#code=/);
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ running: { port: first.port, version: '0.0.0' }, version_differs: true });
    expect((await startLockOf(clone.commonDir))?.pid).toBe(first.child.pid);
  });

  instanceTest('accepted, the takeover stops the running start over the control channel and serves in its place', async ({ clone }) => {
    const first = await clone.start();

    const run = cliAtTerminal(otherBin, ['start', '--no-open'], {
      cwd: clone.dir,
      env: clone.env,
      answers: [{ when: /Stop it and start 9\.9\.9 instead\? \[y\/N\]/, type: 'y' }],
    });
    const firstExit = await first.exited;
    await until(async () => {
      const lock = await startLockOf(clone.commonDir);
      return lock !== null && lock.pid !== first.child.pid;
    }, 'the takeover to hold the start lock');
    const taken = (await startLockOf(clone.commonDir))!;
    const health = await request(taken.port, { path: '/health' });
    await callControl(controlPaths(await cloneId(clone.commonDir), taken.nonce, clone.env), 'stop');
    const done = await run;

    expect(firstExit).toBe(0);
    expect(health.json()).toEqual({ service: 'grimoire-start', nonce: taken.nonce });
    expect(done.code).toBe(0);
    expect(done.screen).toContain('grimoire start 9.9.9 serves this clone');
  });

  instanceTest('a start lock whose port fails the nonce-echo probe is stale, though its process lives: start takes it over', async ({ clone }) => {
    const impostor = http.createServer((_, response) => response.end(JSON.stringify({ service: 'grimoire-start', nonce: 'ffffffffffffffff' })));
    await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve));
    const store = new MachineLocalStore(clone.commonDir);
    // This test process lives, so only the probe can find the lock stale.
    const held = await store.locks.acquire('start', { data: { port: (impostor.address() as AddressInfo).port, nonce: '0123456789abcdef' } });

    const start = await clone.start();
    const lock = await startLockOf(clone.commonDir);
    impostor.close();

    expect(held.status).toBe('acquired');
    expect(lock).toMatchObject({ port: start.port, pid: start.child.pid });
  });

  instanceTest('stop over the control channel ends start, frees its lock and removes its secret and process record', async ({ clone }) => {
    const start = await clone.start();
    const store = new MachineLocalStore(clone.commonDir);
    const lock = (await startLockOf(clone.commonDir))!;
    const paths = controlPaths(await cloneId(clone.commonDir), lock.nonce, clone.env);
    const secretWhileServing = existsSync(paths.secretFile);
    const recordWhileServing = await store.processes.live({ role: 'start' });
    // Upkeep runs at launch (spec §13): its clone-wide parts leave their stamps.
    await until(async () => (await store.coordination.list('upkeep-runs')).length > 0, 'the upkeep pass at launch');

    const code = await stopStart(start, clone.commonDir, clone.env);

    expect(secretWhileServing).toBe(true);
    expect(recordWhileServing).toEqual([expect.objectContaining({ pid: start.child.pid, role: 'start', worktree: clone.dir, pin: '0.0.0' })]);
    expect(code).toBe(0);
    expect(await startLockOf(clone.commonDir)).toBeNull();
    expect(existsSync(paths.secretFile)).toBe(false);
    expect(await store.processes.live({ role: 'start' })).toEqual([]);
  });

  instanceTest('it keeps serving through NOT_SYNCED and UPGRADE_REQUIRED', async ({ world, clone }) => {
    // Clone b has no tracker: reads answer NOT_SYNCED.
    const { env } = await startEnv(path.join(world.root, 'b-env'));
    const commonDirB = path.join(world.b.dir, '.git');
    const inB = await spawnStart(bin, world.b.dir, env);
    try {
      const { url } = (await callControl(controlPaths(await cloneId(commonDirB), (await startLockOf(commonDirB))!.nonce, env), 'sign-in')) as { url: string };
      const { cookie } = await exchange(inB.port, codeOf(url));
      const listed = await request(inB.port, { path: '/api/op/list?input=%7B%7D', headers: { cookie: cookie! } });
      expect(listed.json()).toMatchObject({ error: { code: 'NOT_SYNCED' } });
    } finally {
      await stopStart(inB, commonDirB, env);
    }

    // Machine-local data from a newer release: coordination still works, records give UPGRADE_REQUIRED.
    const store = new MachineLocalStore(clone.commonDir);
    await mkdir(store.dir, { recursive: true });
    await writeFile(path.join(store.dir, 'format'), 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');
    const start = await clone.start();
    const cookie = await signedIn(start.port, clone.commonDir, clone.env);
    const shown = await request(start.port, { path: `/api/op/settings_get?input=${encodeURIComponent('{}')}`, headers: { cookie } });
    const health = await request(start.port, { path: '/health' });

    expect(shown.json()).toMatchObject({ error: { code: 'UPGRADE_REQUIRED', details: { marker: 'machine' } } });
    expect(health.status).toBe(200);
  });
});

describe('start: the control channel', () => {
  instanceTest('a request without the secret is refused unanswered; with it, sign-in answers a fresh code', async ({ clone }) => {
    const start = await clone.start();
    const lock = (await startLockOf(clone.commonDir))!;
    const paths = controlPaths(await cloneId(clone.commonDir), lock.nonce, clone.env);

    const wrong = await callControl(paths, 'sign-in', {}, { secret: 'a'.repeat(64) }).catch((error: unknown) => error);
    const stopWrong = await callControl(paths, 'stop', {}, { secret: 'b'.repeat(64) }).catch((error: unknown) => error);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(paths.endpoint, () => socket.write('{"v":1,"op":"sign-in","args":"{}"}\n'));
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString()));
      socket.on('close', () => resolve(received));
      socket.on('error', reject);
    });
    const right = (await callControl(paths, 'sign-in')) as { url: string };
    const health = await request(start.port, { path: '/health' });

    expect(wrong).toBeInstanceOf(ControlError);
    expect((wrong as ControlError).reason).toBe('refused');
    expect((stopWrong as ControlError).reason).toBe('refused');
    expect(raw).toBe('');
    expect(right.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${start.port}/login#code=`));
    // The refused stop stopped nothing.
    expect(health.status).toBe(200);
  });
});

describe('start: open, gates and links', () => {
  instanceTest('start and open refuse agent markers; open with no start running says so', async ({ clone }) => {
    const env = { ...clone.env, ...MARKED };
    const start = await cli(bin, ['start', '--no-open'], { cwd: clone.dir, env });
    const open = await cli(bin, ['open'], { cwd: clone.dir, env });
    const nothingRunning = await cli(bin, ['open'], { cwd: clone.dir, env: clone.env });

    expect(start.code).toBe(1);
    expect(start.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(open.code).toBe(1);
    expect(open.json).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    expect(JSON.stringify(open.json)).not.toMatch(/AI_AGENT|CLAUDE_CODE/);
    expect(nothingRunning.code).toBe(1);
    expect(nothingRunning.json).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await startLockOf(clone.commonDir)).toBeNull();
  });

  instanceTest('open gets a fresh code over the control channel and opens a tab that lands on the ref, printing no secret', async ({ clone }) => {
    const start = await clone.start();

    const open = await cli(bin, ['open', 'see https://forge.example/x/GR-7K2PQ for it'], { cwd: clone.dir, env: clone.env });
    const [url] = await clone.opened();
    const fragment = new URLSearchParams(new URL(url!).hash.slice(1));
    const { answer } = await exchange(start.port, codeOf(url!));
    const landing = await request(start.port, { path: fragment.get('next')! });
    const attempt = await request(start.port, { path: `/open?ref=${encodeURIComponent('trace at-abc234')}` });
    const nothing = await request(start.port, { path: '/open?ref=gr-7k' });

    expect(open.code).toBe(0);
    expect(open.json).toEqual({ opened: true, port: start.port, ref: 'see https://forge.example/x/GR-7K2PQ for it' });
    expect(open.stdout + open.stderr).not.toContain(codeOf(url!));
    expect(answer.status).toBe(200);
    expect(landing.status).toBe(302);
    expect(landing.headers.location).toBe('/issues/gr-7k2pq');
    expect(attempt.headers.location).toBe('/attempts/at-abc234');
    expect(nothing.headers.location).toBe('/');
  });

  instanceTest('the port: the next of 9 when the chosen one is taken, and show’s local_link carries the running port', async ({ clone }) => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

    const start = await clone.start(['--no-open', '--port', String(port)]);
    const created = await cli(bin, ['create', '--title', 'Linked'], { cwd: clone.dir, env: clone.env });
    const shown = await cli(bin, ['show', created.json.id as string], { cwd: clone.dir, env: clone.env });
    blocker.close();

    expect(start.port).toBeGreaterThan(port);
    expect(start.port).toBeLessThanOrEqual(port + 9);
    expect(shown.json.local_link).toBe(`http://127.0.0.1:${start.port}/issues/${created.json.id as string}`);
  });
});
