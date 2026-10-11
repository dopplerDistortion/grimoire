// Seam 1 for `status` (spec Testing Decisions; §12 status): readStatus driven
// directly against a clone with a tracker. Seam 3 (health.test.ts) runs it
// through the shim and asserts it writes nothing.
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { makeTempDir, removeDir } from '#harness';
import { putMachineSetting } from '../../src/core/settings';
import { codexHookHash } from '../../src/installer';
import { noteClientRuntime } from '../../src/installer/client-runtime';
import { writeJoinRecord } from '../../src/installer/records';
import { readStatus, STATUS_FACTS } from '../../src/installer/status';
import { MachineLocalStore } from '../../src/machine-local';
import { VERSION } from '../../src/version';
import { coreTest as test, T0 } from '../core/support';
import { installed } from '../upkeep/support';

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(`call failed: ${JSON.stringify(settled.error)}`);
  return settled.result;
}

async function pinned(root: string): Promise<void> {
  await mkdir(path.join(root, '.grimoire'), { recursive: true });
  await writeFile(path.join(root, '.grimoire', 'config.yml'), `version: ${VERSION}\ninstall_format: 1\n`);
}

describe('status', () => {
  test('stale claims by this machine’s dashboard.stale_after', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id } = await ok(core.call('create', { title: 'Left hanging' }, ctx));
    const { attempt } = await ok(core.call('claim', { id }, ctx));
    await ok(core.call('create', { title: 'Nobody holds this' }, ctx));
    await putMachineSetting(path.join(world.a.dir, '.git'), 'dashboard.stale_after', '1h');

    const later = await readStatus({ root: world.a.dir, now: new Date(T0.getTime() + 2 * 3_600_000) });
    const soon = await readStatus({ root: world.a.dir, now: new Date(T0.getTime() + 30 * 60_000) });

    expect(later.report.stale_claims).toEqual({
      stale_after: '1h',
      claims: [{ issue: id, title: 'Left hanging', attempt, assignee: 'alice@example.com', since: T0.toISOString(), last_activity_at: T0.toISOString() }],
    });
    expect(later.lines.some((line) => line.startsWith(`Stale claim: ${id}`))).toBe(true);
    expect(soon.report.stale_claims).toEqual({ stale_after: '1h', claims: [] });
  });

  test('the excerpt mode changed since this machine joined', async ({ world, grimoire }) => {
    expect(grimoire.core).toBeDefined(); // the fixture initializes clone a's tracker
    const root = world.a.dir;
    await pinned(root);
    const store = new MachineLocalStore(path.join(root, '.git'));
    // This machine joined when the store said excerpts; the tracker has no mode set (facts) now.
    await writeJoinRecord(store, VERSION, { excerpt_mode: 'excerpts', codex_hook_hash: null, joined_at: T0.getTime() });

    const { report, lines } = await readStatus({ root });

    expect(report.excerpt_mode).toEqual({ store: 'facts', joined: 'excerpts', changed: true });
    expect(lines).toContain('The excerpt mode changed since this machine joined: it was excerpts, it is facts now (see the disclosure: grimoire init)');
  });

  test('the Node version and PATH source each client’s servers ran with', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await noteClientRuntime(store, 'codex-mcp-client', VERSION, world.a.dir);

    const { report } = await readStatus({ root: world.a.dir });

    expect(report.node).toEqual({
      this_process: { node: process.version, path_source: path.dirname(process.execPath) },
      clients: [expect.objectContaining({ client: 'codex-mcp-client', node: process.version, path_source: path.dirname(process.execPath), live: false, supported: true })],
    });
  });

  test('a clone without the tracker still gets every fact, the ones that need it saying why not', async ({ world }) => {
    const { report } = await readStatus({ root: world.b.dir });

    expect(report.sync).toMatchObject({ summary: 'never synced on this machine', failure: null });
    expect(report.stale_claims).toMatchObject({ error: { code: 'NOT_SYNCED' } });
    expect(report.excerpt_mode).toMatchObject({ store: null, joined: null, changed: false, error: { code: 'NOT_SYNCED' } });
  });

  test('whether Codex runs grimoire’s hook: needs approval, approved, and unknown when the user’s Codex config can’t be read', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const store = new MachineLocalStore(path.join(root, '.git'));
    await writeJoinRecord(store, VERSION, { excerpt_mode: 'facts', codex_hook_hash: codexHookHash(), joined_at: T0.getTime() });
    const home = await makeTempDir('grimoire-codex-home-');
    try {
      const env = { ...process.env, CODEX_HOME: home };
      const facts = STATUS_FACTS.filter((fact) => fact.key === 'codex_hook');
      const key = `${path.join(await realpath(root), '.codex', 'config.toml')}:session_start:0:0`;
      const userConfig = path.join(home, 'config.toml');

      const fresh = await readStatus({ root, env, facts });
      await writeFile(userConfig, `[hooks.state.'${key}']\ntrusted_hash = "${codexHookHash()}"\n`);
      const approved = await readStatus({ root, env, facts });
      // A folder where the config should be: grimoire can't read the trust, so it falls back to what it announced.
      await rm(userConfig);
      await mkdir(userConfig);
      const announced = await readStatus({ root, env, facts });
      await writeJoinRecord(store, VERSION, { excerpt_mode: 'facts', codex_hook_hash: 'sha256:an-older-hook', joined_at: T0.getTime() });
      const changed = await readStatus({ root, env, facts });

      expect(fresh.report.codex_hook).toMatchObject({ trust: 'needs-approval', key, position: 0, last: true, declared_hash: codexHookHash(), expected_hash: codexHookHash() });
      expect(fresh.lines).toContain('Codex hook: Codex skips grimoire’s SessionStart hook until you approve it in `/hooks` (once per clone of this repo)');
      expect(approved.report.codex_hook).toMatchObject({ trust: 'approved', key });
      expect(announced.report.codex_hook).toMatchObject({ trust: 'unknown', announced_hash: codexHookHash(), summary: expect.stringContaining('announced for approval on this machine') });
      expect(changed.report.codex_hook).toMatchObject({ trust: 'unknown', summary: expect.stringContaining('changed since it was last announced') });
    } finally {
      await removeDir(home);
    }
  });
});
