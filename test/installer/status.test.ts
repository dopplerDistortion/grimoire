// Seam 1 for `status` (spec Testing Decisions; §12 status): readStatus driven
// directly against a clone with a tracker. Seam 3 (health.test.ts) runs it
// through the shim and asserts it writes nothing.
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { makeTempDir, removeDir, type GitWorld } from '#harness';
import { skillVersionOf } from '../../src/knowledge';
import { openTracker, randomProposalId, randomRunId } from '../../src/tracker';
import { commitChoreRun, compileRecord, terminal, workPair } from '../core/chore-support';
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

/** A create proposal pending human review, made at `at`, as a Skill Proposer run writes it. */
async function proposalAt(world: GitWorld, at: Date): Promise<void> {
  const tracker = await openTracker(world.a.dir, { clock: () => at });
  try {
    await tracker.transact({ op: 'propose', author: { name: world.a.identity.name, email: world.a.identity.email }, actor: { kind: 'agent', client: 'test', nonce: 'n' } }, async (draft) => {
      const text = '---\nname: port-picking\ndescription: Pick free ports in tests.\n---\nBind port 0.\n';
      await draft.proposals.add({
        id: randomProposalId(),
        action: 'create',
        skill: 'port-picking',
        base: null,
        after: [],
        version: skillVersionOf(text),
        ops: [],
        citations: [],
        served: [],
        pages: [],
        traces: [],
        claims: { rationale: 'PROPOSAL-RATIONALE', failures: [], expected_signal: 'PROPOSAL-RATIONALE', provenance: 'PROPOSAL-RATIONALE' },
        flags: [],
        tokens: [],
        run: 'cr-test',
        origin: 'session',
        isolation: 'claude-chore-agent',
        unverified: { client: null, model: null },
        actor: { kind: 'agent' },
        at: at.toISOString(),
        text,
      });
      return { result: null };
    });
  } finally {
    await tracker.close();
  }
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

  test('the knowledge facts: what is due or why not, the paused loop, a pending proposal and its age, set-aside pairs and active skills with flags', async ({
    world,
    grimoire,
  }) => {
    const root = world.a.dir;
    const { core, ctx } = grimoire;
    const facts = STATUS_FACTS.filter((fact) => fact.key === 'knowledge');
    const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

    const idle = await readStatus({ root, facts, now: at(1) });
    expect(idle.report.knowledge).toMatchObject({
      loop: 'on',
      pickup: 'ask',
      next: null,
      chores: { 'wiki-maintainer': { due: false, why: 'no uncompiled settled traces' }, 'skill-proposer': { due: false } },
      pending_proposals: [],
      set_aside: [],
      skills: [],
    });
    expect(idle.lines).toContain('Chores: none due (Wiki Maintainer: no uncompiled settled traces; Skill Proposer: 0 failing traces in compiles not yet proposed from, below the threshold)');

    await ok(core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(ctx)));
    const fail = await workPair(core, ctx, 'fail');
    const due = await readStatus({ root, facts, now: at(25) });
    expect(due.report.knowledge).toMatchObject({ next: 'wiki-maintainer', chores: { 'wiki-maintainer': { due: true, why: '1 uncompiled traces, 1 failing' } } });
    expect(due.lines).toContain('Chores: the Wiki Maintainer is due (1 uncompiled traces, 1 failing)');

    // Two failed compile runs set the pair aside: shown, never offered.
    for (const id of [randomRunId(), randomRunId()]) {
      await commitChoreRun(world.a, world.a, { ...compileRecord(id, at(26).toISOString(), []), result: 'failed', reasons: ['too_big'], pairs: [`${fail}@fail`] });
    }
    await ok(core.call('skill_edit', { name: 'release-notes', text: '---\nname: release-notes\ndescription: Use when noting a change.\n---\nWrite it down.\n', base: null }, terminal(ctx)));
    await proposalAt(world, at(27));
    await ok(core.call('settings_set', { key: 'knowledge.loop', value: 'paused' }, terminal(ctx)));
    await putMachineSetting(path.join(root, '.git'), 'knowledge.pickup', 'manual');

    const later = await readStatus({ root, facts, now: at(30) });
    const knowledge = later.report.knowledge as Record<string, any>;
    expect(knowledge).toMatchObject({
      loop: 'paused',
      pickup: 'manual',
      next: null,
      chores: { 'wiki-maintainer': { due: false, why: 'the knowledge loop is paused' } },
      set_aside: [{ pair: `${fail}@fail`, strikes: 2 }],
      skills: [{ name: 'release-notes', version: expect.any(String), attention: [] }],
    });
    expect(knowledge.pending_proposals).toEqual([{ id: expect.stringMatching(/^pp-/), skill: 'port-picking', action: 'create', at: at(27).toISOString(), age_hours: 3, flags: [] }]);
    expect(later.lines).toEqual(
      expect.arrayContaining([
        'Chores: none due: the knowledge loop is paused',
        `Skill proposal ${knowledge.pending_proposals[0].id} (create port-picking) awaits human review, 3 h old`,
        `Set aside after 2 failed compiles: ${fail}@fail`,
      ]),
    );
    expect(later.lines.join('\n')).not.toContain('PROPOSAL-RATIONALE');
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

  test('after an upgrade, a changed hook-group hash or a moved position, each with the `/hooks` step', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const home = await makeTempDir('grimoire-codex-home-');
    try {
      const env = { ...process.env, CODEX_HOME: home };
      const facts = STATUS_FACTS.filter((fact) => fact.key === 'codex_hook');
      const declaring = path.join(await realpath(root), '.codex', 'config.toml');
      // Approved before the upgrade, for the definition the old release had.
      await writeFile(path.join(home, 'config.toml'), `[hooks.state.'${declaring}:session_start:0:0']\ntrusted_hash = "sha256:the-old-release-hook"\n`);
      const modified = await readStatus({ root, env, facts });
      // Approved as it is now, then a group lands before grimoire's: its position moves to 1.
      await writeFile(path.join(home, 'config.toml'), `[hooks.state.'${declaring}:session_start:0:0']\ntrusted_hash = "${codexHookHash()}"\n`);
      const toml = path.join(root, '.codex', 'config.toml');
      const { readFile } = await import('node:fs/promises');
      await writeFile(toml, `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo mine"\n\n${await readFile(toml, 'utf8')}`);
      const moved = await readStatus({ root, env, facts });

      expect(modified.report.codex_hook).toMatchObject({ trust: 'modified', position: 0, declared_hash: codexHookHash() });
      expect(modified.lines).toEqual([expect.any(String), expect.stringMatching(/definition changed since it was approved; approve it again in `\/hooks`/)]);
      expect(moved.report.codex_hook).toMatchObject({ trust: 'needs-approval', position: 1, key: `${declaring}:session_start:1:0` });
      expect(moved.lines[1]).toMatch(/until you approve it in `\/hooks`/);
    } finally {
      await removeDir(home);
    }
  });
});
