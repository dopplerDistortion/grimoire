// Seam 3: `grimoire start` over HTTP, SSE and its control channel (spec §12,
// §20). Thin: transport and gating, never business rules, which seam 1 covers.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { coreTest } from '../../core/support';
import {
  buildFull,
  codeOf,
  control,
  exchange,
  request,
  signedIn,
  spawnStart,
  startEnv,
  stopStart,
  writeHeaders,
  type StartProcess,
} from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface Served {
  readonly start: StartProcess;
  readonly port: number;
  readonly commonDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly opened: () => Promise<string[]>;
}

/** coreTest plus a `start` serving clone a (with a tracker), stopped after the test. */
const startTest = coreTest.extend('served', async ({ world, grimoire: _ }, { onCleanup }) => {
  const { env, opened } = await startEnv(world.root);
  const start = await spawnStart(bin, world.a.dir, env);
  const commonDir = path.join(world.a.dir, '.git');
  onCleanup(async () => {
    await stopStart(start, commonDir, env);
  });
  const served: Served = { start, port: start.port, commonDir, env, opened };
  return served;
});

describe('start: sign-in and sessions', () => {
  startTest('a code exchange sets the session cookie; every /api path without it is 401 NO_SESSION; the static app is public', async ({ served }) => {
    const { port, commonDir, env } = served;
    const app = await request(port, { path: '/' });
    const deepRoute = await request(port, { path: '/issues/gr-7k2pq' });
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(app.body)?.[1];
    const asset = await request(port, { path: script ?? '/missing' });
    const unauthenticated = await Promise.all(
      [
        { path: '/api/op/list?input=%7B%7D' },
        { path: '/api/events' },
        { path: '/api/instance' },
        { path: '/api/session' },
        { path: '/api/nothing-here' },
        { method: 'POST', path: '/api/op/create', headers: writeHeaders(port), body: '{"title":"x"}' },
        { method: 'DELETE', path: '/api/session', headers: writeHeaders(port) },
      ].map((options) => request(port, options)),
    );

    const { url } = (await control(commonDir, env, 'sign-in')) as { url: string };
    const { answer, cookie } = await exchange(port, codeOf(url));
    const again = await exchange(port, codeOf(url));
    const withCookie = await request(port, { path: '/api/op/list?input=%7B%7D', headers: { cookie: cookie! } });

    expect(app.status).toBe(200);
    expect(app.headers['content-type']).toContain('text/html');
    expect(app.headers['cache-control']).toBe('no-cache');
    expect(deepRoute.body).toBe(app.body);
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const refused of unauthenticated) {
      expect(refused.status).toBe(401);
      expect((refused.json().error as { code: string }).code).toBe('NO_SESSION');
    }
    expect(new URL(url).pathname).toBe('/login');
    expect(new URL(url).host).toBe(`127.0.0.1:${port}`);
    expect(answer.status).toBe(200);
    const setCookie = answer.headers['set-cookie']![0]!;
    expect(setCookie).toMatch(/^grimoire_[0-9a-f]{16}=[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(again.answer.status).toBe(401);
    expect(again.cookie).toBeNull();
    expect(withCookie.status).toBe(200);
  });

  startTest('DELETE /api/session signs out', async ({ served }) => {
    const { port, commonDir, env } = served;
    const cookie = await signedIn(port, commonDir, env);
    const before = await request(port, { path: '/api/session', headers: { cookie } });
    const out = await request(port, { method: 'DELETE', path: '/api/session', headers: writeHeaders(port, cookie) });
    const after = await request(port, { path: '/api/session', headers: { cookie } });

    expect(before.status).toBe(200);
    expect(before.json()).toMatchObject({ signed_in: true, identity: { email: 'alice@example.com' } });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']![0]).toContain('Max-Age=0');
    expect(after.status).toBe(401);
  });
});

describe('start: hosts, origins and headers', () => {
  startTest('a wrong Host, a cross-origin Origin or a missing X-Grimoire is refused', async ({ served }) => {
    const { port, commonDir, env } = served;
    const cookie = await signedIn(port, commonDir, env);
    const create = (headers: Record<string, string>) =>
      request(port, { method: 'POST', path: '/api/op/create', headers: { 'content-type': 'application/json', cookie, ...headers }, body: '{"title":"Refused"}' });

    const wrongHosts = await Promise.all(['evil.example', `evil.example:${port}`, `127.0.0.2:${port}`, `localhost.evil.example:${port}`].map((host) => request(port, { path: '/', host })));
    const allowedHosts = await Promise.all([`localhost:${port}`, `[::1]:${port}`, '127.0.0.1', `LOCALHOST:9`].map((host) => request(port, { path: '/', host })));
    const crossOrigin = await create({ origin: 'http://evil.example', 'x-grimoire': '1' });
    const otherPort = await create({ origin: `http://127.0.0.1:${port + 1}`, 'x-grimoire': '1' });
    const noOrigin = await create({ 'x-grimoire': '1' });
    const noHeader = await create({ origin: `http://127.0.0.1:${port}` });
    const sameOrigin = await create({ origin: `http://127.0.0.1:${port}`, 'x-grimoire': '1' });
    const listed = await request(port, { path: `/api/op/list?input=${encodeURIComponent('{}')}`, headers: { cookie } });

    for (const refused of wrongHosts) expect(refused.status).toBe(403);
    for (const allowed of allowedHosts) expect(allowed.status).toBe(200);
    for (const refused of [crossOrigin, otherPort, noOrigin, noHeader]) {
      expect(refused.status).toBe(403);
      expect((refused.json().error as { code: string }).code).toBe('INVALID');
    }
    expect(sameOrigin.status).toBe(200);
    // Only the same-origin write went through.
    expect((listed.json().rows as { title: string }[]).map((row) => row.title)).toEqual(['Refused']);
  });

  startTest('every response carries the security headers with the exact CSP', async ({ served }) => {
    const { port } = served;
    const answers = await Promise.all([
      request(port, { path: '/' }),
      request(port, { path: '/api/op/list' }),
      request(port, { path: '/health' }),
      request(port, { path: '/', host: 'evil.example' }),
    ]);

    for (const answer of answers) {
      expect(answer.headers['content-security-policy']).toBe(CSP);
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      expect(answer.headers['referrer-policy']).toBe('no-referrer');
      expect(answer.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(answer.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });
});

describe('start: the op API', () => {
  startTest('a read and a write through /api/op/<name>, with the core’s shapes and errors, as the git identity through the dashboard', async ({ world, served }) => {
    const { port, commonDir, env } = served;
    const cookie = await signedIn(port, commonDir, env);
    const created = await request(port, { method: 'POST', path: '/api/op/create', headers: writeHeaders(port, cookie), body: JSON.stringify({ title: 'From the dashboard' }) });
    const id = created.json().id as string;
    const shown = await request(port, { path: `/api/op/show?input=${encodeURIComponent(JSON.stringify({ ref: id }))}`, headers: { cookie } });
    const missing = await request(port, { path: `/api/op/show?input=${encodeURIComponent(JSON.stringify({ ref: 'gr-zzzzz' }))}`, headers: { cookie } });
    const readByPost = await request(port, { method: 'POST', path: '/api/op/show', headers: writeHeaders(port, cookie), body: JSON.stringify({ ref: id }) });
    const writeByGet = await request(port, { path: `/api/op/create?input=${encodeURIComponent('{"title":"x"}')}`, headers: { cookie } });
    const badJson = await request(port, { path: '/api/op/show?input=%7Bnope', headers: { cookie } });
    const actor = await world.a.git(['log', '-1', '--format=%an <%ae>%n%(trailers:key=Grimoire-Actor,valueonly)', 'refs/grimoire/tracker']);

    expect(created.status).toBe(200);
    expect(id).toMatch(/^gr-[0-9a-z]{5}$/);
    expect(shown.status).toBe(200);
    expect(shown.json()).toMatchObject({ id, title: 'From the dashboard', local_link: `http://127.0.0.1:${port}/issues/${id}` });
    expect(missing.status).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String), retryable: false, details: expect.any(Object) } });
    expect(readByPost.status).toBe(400);
    expect(writeByGet.status).toBe(400);
    expect((badJson.json().error as { code: string }).code).toBe('INVALID');
    const [author, trailer] = actor.split('\n');
    expect(author).toBe('Alice Example <alice@example.com>');
    expect(JSON.parse(trailer!)).toMatchObject({ kind: 'human', client: 'dashboard' });
  });
});

