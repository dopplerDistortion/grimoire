// Seam 3: the dashboard's live events, `GET /api/events` (spec §20, SSE).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { coreTest } from '../../core/support';
import { cli } from '../cli/support';
import { buildFull, request, signedIn, spawnStart, SseClient, startEnv, stopStart, type StartProcess } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildFull());
}, 300_000);
afterAll(() => cleanup());

interface Served {
  readonly start: StartProcess;
  readonly port: number;
  readonly cookie: string;
  readonly env: NodeJS.ProcessEnv;
}

const liveTest = coreTest.extend('served', async ({ world, grimoire: _ }, { onCleanup }) => {
  const { env } = await startEnv(world.root);
  const start = await spawnStart(bin, world.a.dir, env);
  const commonDir = path.join(world.a.dir, '.git');
  onCleanup(async () => {
    await stopStart(start, commonDir, env);
  });
  const served: Served = { start, port: start.port, cookie: await signedIn(start.port, commonDir, env), env };
  return served;
});

describe('start: live events', () => {
  liveTest('a tracker write by another process produces a change event naming its issue within ~2 s', async ({ world, grimoire, served }) => {
    const { port, cookie } = served;
    const events = await SseClient.connect(port, cookie);
    const ready = await events.next((event) => event.event === 'ready');

    // This test process is the other process: an agent's write through its own core.
    const created = await grimoire.makeCore().call('create', { title: 'Written by another process' }, grimoire.ctx);
    const written = Date.now();
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const change = await events.next((event) => event.event === 'change');
    events.close();

    expect(ready.id).toMatch(/^[0-9a-f]{40}:0:[0-9a-f]{12}$/);
    expect(change.data).toMatchObject({ issues: [created.result.id], attempts: [], knowledge: false, settings: false, sync: true, agent: true });
    expect((change.data.tips as { local: string }).local).toBe(await world.a.git(['rev-parse', 'refs/grimoire/tracker']));
    expect(change.id).toMatch(new RegExp(`^${(change.data.tips as { local: string }).local}:0:[0-9a-f]{12}$`));
    // The tips are checked about every second: ~2 s, with room for a loaded machine.
    expect(change.receivedAt - written).toBeLessThan(3_000);
  });

  liveTest('Last-Event-ID resumes without loss: writes made while the stream was down arrive on reconnect', async ({ world, served }) => {
    const { port, cookie, env } = served;
    const first = await SseClient.connect(port, cookie);
    const ready = await first.next((event) => event.event === 'ready');
    first.close();

    const one = (await cli(bin, ['create', '--title', 'While away 1'], { cwd: world.a.dir, env })).json.id as string;
    const two = (await cli(bin, ['create', '--title', 'While away 2'], { cwd: world.a.dir, env })).json.id as string;
    const resumed = await SseClient.connect(port, cookie, ready.id!);
    const change = await resumed.next((event) => event.event === 'change');
    const unknown = await SseClient.connect(port, cookie, 'not-an-id');
    const reload = await unknown.next(() => true);
    const current = await SseClient.connect(port, cookie, change.id!);
    const upToDate = await current.next(() => true);
    resumed.close();
    unknown.close();
    current.close();

    expect([...(change.data.issues as string[])].sort()).toEqual([one, two].sort());
    expect(reload.event).toBe('reload');
    expect(upToDate.event).toBe('ready');
    expect(upToDate.id).toBe(change.id);
  });

  liveTest('when the launch worktree comes to pin another version, an instance change names it and /api/instance carries the restart notice', async ({ world, served }) => {
    const { port, cookie } = served;
    const events = await SseClient.connect(port, cookie);
    await events.next((event) => event.event === 'ready');
    const before = await request(port, { path: '/api/instance', headers: { cookie } });

    // A merge or switch brings a config.yml that pins another version.
    await mkdir(path.join(world.a.dir, '.grimoire'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.grimoire', 'config.yml'), 'version: 9.9.9\ninstall_format: 1\n');
    const change = await events.next((event) => event.event === 'change');
    const after = await request(port, { path: '/api/instance', headers: { cookie } });
    events.close();

    expect(before.json()).toMatchObject({ version: '0.0.0', pin: null, pin_differs: false, notice: null, port });
    expect(change.data).toMatchObject({ instance: true, issues: [] });
    expect(after.json()).toMatchObject({ version: '0.0.0', pin: '9.9.9', pin_differs: true, notice: 'this worktree now pins 9.9.9; restart `start`' });
  });
});
