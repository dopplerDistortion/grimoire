// Seam 3 (spec §16 The runner, Triggers and Caps; §20 Settings: runner
// status): the real `start`, with a stand-in `claude` enabled as this
// machine's runner. A trace write by another process makes `start` evaluate
// due-ness and spawn the runner within the caps: the 6th run of the day
// spawns, the 7th doesn't. `/api/runner` shows the status, the trigger's last
// evaluation and the commands.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { MachineLocalStore } from '../../../src/machine-local';
import { openTracker } from '../../../src/tracker';
import { terminal } from '../../core/chore-support';
import { coreTest } from '../../core/support';
import { enabled, noPatternAnswer, ok } from '../../runner/scenario';
import { authStatus, claudeAnswer } from '../../runner/support';
import { buildFull, request, signedIn, spawnStart, startEnv, stopStart } from './support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildFull(undefined, 'cli'));
}, 300_000);
afterAll(() => cleanup());

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('start drives the runner', () => {
  coreTest('a trace write by another process spawns the runner within the caps: the 6th run of the day spawns, the 7th doesn’t', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    // One settled pass makes the Wiki Maintainer due.
    for (const [key, value] of [['chores.compile_pairs', 1], ['chores.compile_fails', 0], ['chores.settle_hours', 0]] as const) {
      ok(await core.call('settings_set', { key, value }, terminal(ctx)));
    }
    const fake = await enabled('claude', world.a.dir, { auth: authStatus('claude-ai') });
    // Enabling ran the preflight: that call is the stand-in's only one so far.
    const enabling = fake.calls('claude').length;
    // Five runs already today.
    const commonDir = path.join(world.a.dir, '.git');
    const hour = 3_600_000;
    await new MachineLocalStore(commonDir).coordination.write('runner', 'counters', {
      runs: [5, 4, 3, 2, 1].map((h) => new Date(Date.now() - h * hour).toISOString()),
      consecutive_failures: 0,
      paused_until: null,
      last: null,
    });
    // The stand-ins first on PATH, and none of the outer environment's credentials.
    const agentEnv = fake.env();
    const dropped = Object.fromEntries(Object.keys(process.env).filter((key) => !(key in agentEnv)).map((key) => [key, undefined]));
    const { env } = await startEnv(world.root, { ...dropped, ...agentEnv });
    const start = await spawnStart(bin, world.a.dir, env);
    try {
      const cookie = await signedIn(start.port, commonDir, env);
      const before = (await request(start.port, { path: '/api/runner', headers: { cookie } })).json();
      // The launch evaluation finds nothing due: it starts no client, not even the billing guard.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const atLaunch = fake.calls('claude').length;

      const work = async (title: string): Promise<{ id: string; attempt: string }> => {
        const { id } = ok(await core.call('create', { title }, ctx));
        const { attempt } = ok(await core.call('claim', { id }, ctx));
        return { id, attempt };
      };
      const answers = () => fake.calls('claude').filter((call) => call.type === 'answer');

      const first = await work('First');
      await fake.plan('claude', { auth: authStatus('claude-ai'), answers: [claudeAnswer(noPatternAnswer([`${first.attempt}@pass`]))] });
      ok(await core.call('close', { id: first.id, attempt: first.attempt, reason: 'done', debrief: DEBRIEF }, ctx));
      await until(async () => (await compiledRuns(world.a.dir)) === 1, 'the runner’s compile');

      const second = await work('Second');
      await fake.plan('claude', {
        auth: authStatus('claude-ai'),
        answers: [claudeAnswer(noPatternAnswer([`${first.attempt}@pass`])), claudeAnswer(noPatternAnswer([`${second.attempt}@pass`]))],
      });
      ok(await core.call('close', { id: second.id, attempt: second.attempt, reason: 'done', debrief: DEBRIEF }, ctx));
      await until(() => /used its 6 runs for the day/.test(start.stderr()), 'the daily cap refusing the 7th run');
      const after = (await request(start.port, { path: '/api/runner', headers: { cookie } })).json();

      expect(atLaunch).toBe(enabling);
      expect(answers()).toHaveLength(1);
      expect(before).toMatchObject({
        enabled: true,
        kind: 'claude',
        binary: fake.claude,
        runs_today: 5,
        runs_per_day: 6,
        commands: { enable: ['grimoire runner enable claude', 'grimoire runner enable codex'], disable: 'grimoire runner disable' },
      });
      expect((before.warnings as string[]).join('\n')).toContain('policy gray zone');
      expect(after).toMatchObject({ runs_today: 6, next_run_at: expect.any(String), last: { result: 'compiled', kind: 'wiki-maintainer' } });
      // The trigger's last evaluation, for the Knowledge runner card: the cap refused it (no preflight failure).
      expect(after.trigger).toMatchObject({ outcome: 'refused', code: 'NOT_DUE', preflight: false });
      expect(start.stderr()).toMatch(/grimoire chores: compile done, 1 trace/);
    } finally {
      await stopStart(start, commonDir, env);
    }
  });
});

/** The compiled chore runs the tracker records. */
async function compiledRuns(root: string): Promise<number> {
  const tracker = await openTracker(root);
  try {
    return (await (await tracker.read()).choreRuns.records()).filter((record) => record.result === 'compiled' && record.origin === 'runner').length;
  } finally {
    await tracker.close();
  }
}

