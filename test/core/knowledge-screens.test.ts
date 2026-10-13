// The reads behind the dashboard's Knowledge screens (spec §20 Knowledge,
// Attention; §16 due-ness, set-aside pairs and chore-run records; §17; §18):
// `knowledge_overview`, `chore_runs`, the knowledge items of `attention`, and
// what `skill_show` adds for the Skills list and detail. Seam 1: the core
// against real git in temp repos.
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { describe, expect } from 'vitest';
import { writeSkillChange, type SkillChange } from '../../src/knowledge';
import { bundledRules, createScanner } from '../../src/scanner';
import { openTracker } from '../../src/tracker';
import type { Clone, GitWorld } from '#harness';
import { pinAndCommit } from '../generated/support';
import { choreAgent, Clock, commitChoreRun, compileRecord, dashboard, putPage, terminal, workPair } from './chore-support';
import { ok, PAGE, patchResult, proposer, readAll, SKILL, submit } from './proposer-support';
import { commitToTracker, coreTest as test, fetchTracker, fetchTrackerFrom, pushTracker, T0, TRACKER_REF } from './support';

describe('knowledge_overview', () => {
  test('the tiles, what is due, the pending proposal with its red-flag and cited-trace counts, the recent decisions and chore runs; a purge raises the live red flag', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const human = dashboard(grimoire.ctx);

    const pending = ok(await p.core.call('knowledge_overview', {}, human));
    ok(await p.core.call('purge_trace', { attempt: p.fails[0], reason: 'held a customer name' }, terminal(grimoire.ctx)));
    ok(await p.core.call('purge_trace', { attempt: p.fails[1], reason: 'held a customer name' }, terminal(grimoire.ctx)));
    const flagged = ok(await p.core.call('knowledge_overview', {}, human));
    p.clock.advance(3);
    ok(await p.core.call('proposal_accept', { id: proposal, ack: ['evidence'] }, human));
    const decided = ok(await p.core.call('knowledge_overview', {}, human));

    expect(pending).toMatchObject({
      loop: 'on',
      delivery: 'on',
      pickup: 'ask',
      pending: { id: proposal, skill: SKILL, action: 'patch', age_hours: 0, red_flags: 0, traces: 4, pages: 1 },
      pending_count: 1,
      pending_limit: 1,
      backlog: { pairs: 0, fails: 0, passes: 0 },
      last_compile: { run: 'cr-0000000001' },
      cap: { active: 1, max: 8, over: false },
      due: { paused: false, next: null, 'wiki-maintainer': { due: false }, 'skill-proposer': { due: false } },
      counts: { stale: 0, lapsed: 0, contested: 0, forks: 0, set_aside: 0, quarantined: 0 },
      history: { decided: 0, accept_rate: null },
      decisions: [],
      set_aside: [],
    });
    expect(pending.due['skill-proposer'].why).toMatch(/pending/);
    expect(pending.runs.map((run) => [run.kind, run.outcome, run.origin, run.isolation])).toEqual([
      ['skill-proposer', 'proposed', 'session', 'claude-chore-agent'],
      ['wiki-maintainer', 'compiled', 'session', 'claude-chore-agent'],
    ]);
    expect(pending.runs[0]).toMatchObject({ proposal, where: 'tracker' });
    expect(pending.runs[1]).toMatchObject({ id: 'cr-0000000001', pages: [PAGE] });
    expect(flagged.pending).toMatchObject({ id: proposal, red_flags: 1 });
    expect(decided).toMatchObject({
      pending: null,
      pending_count: 0,
      history: { decided: 1, accepted: 1, accept_rate: 1, median_hours_to_decision: 3 },
      decisions: [{ id: proposal, skill: SKILL, action: 'patch', status: 'accepted', by: grimoire.ctx.person.email, hours: 3 }],
    });
  });

  test('a pair struck by two failed compiles is set aside: listed with its trace and strikes, counted, and an attention item; quarantining the trace takes it out and counts it', async ({
    world,
    grimoire,
  }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const human = dashboard(grimoire.ctx);
    const trace = await workPair(core, grimoire.ctx, 'fail', 'Port clash');
    clock.advance(25);
    const failed = (id: string) => ({
      ...compileRecord(id, clock.now().toISOString(), []),
      result: 'failed',
      consumption: [],
      reasons: ['page_too_long'],
      pairs: [`${trace}@fail`],
    });
    await commitChoreRun(world.a, world.a, failed('cr-0000000001'));
    await commitChoreRun(world.a, world.a, failed('cr-0000000002'));

    const overview = ok(await core.call('knowledge_overview', {}, human));
    const attention = ok(await core.call('attention', {}, human));
    ok(await core.call('quarantine', { trace, reason: 'it trips the compile' }, human));
    const after = ok(await core.call('knowledge_overview', {}, human));

    expect(overview.set_aside).toEqual([{ pair: `${trace}@fail`, trace, issue: expect.stringMatching(/^gr-/), outcome: 'fail', strikes: 2, ended_at: T0.toISOString() }]);
    expect(overview.counts.set_aside).toBe(1);
    expect(overview.runs.map((run) => [run.id, run.outcome, run.reasons])).toEqual([
      ['cr-0000000002', 'failed', ['page_too_long']],
      ['cr-0000000001', 'failed', ['page_too_long']],
    ]);
    expect(attention.items).toEqual([{ kind: 'set_aside', pair: `${trace}@fail`, trace, issue: overview.set_aside[0]!.issue, outcome: 'fail', strikes: 2 }]);
    expect(after.set_aside).toEqual([]);
    expect(after.counts).toMatchObject({ set_aside: 0, quarantined: 1 });
  });

  test('is for people: an agent surface gets HUMAN_ONLY', async ({ grimoire }) => {
    expect(await grimoire.core.call('knowledge_overview', {}, grimoire.ctx)).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
  });
});

describe('chore_runs', () => {
  test('lists origin, isolation, outcome and reason codes; a refused result’s text is kept here and shown with `run`, never after a secret-scan failure; an open run shows only on this machine', async ({
    grimoire,
  }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const human = dashboard(grimoire.ctx);
    ok(await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx)));
    await workPair(core, grimoire.ctx, 'fail', 'Port clash');
    clock.advance(25);
    const chores = await choreAgent(grimoire.ctx);
    const token = ['ghp', 'R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u'].join('_');
    const page = (body: string) => ({ op: 'create', slug: 'ci-pushes', title: 'CI pushes', kind: 'failure', summary: 'About CI pushes.', body });

    // A run refused twice for a secret: failed, and no text kept.
    const secret = ok(await core.call('chore_start', {}, chores));
    await readAll(core, chores, secret.run);
    const consumption = secret.pairs.map((pair) => ({ pair: pair.pair, slugs: ['ci-pushes'] }));
    for (let i = 0; i < 2; i++) await core.call('chore_submit', { run: secret.run, result: { pages: [page(`Push with ${token}.\n`)], consumption } }, chores);
    // A run refused once without a secret, still open: its text is kept here.
    clock.advance(1);
    const open = ok(await core.call('chore_start', {}, chores));
    await readAll(core, chores, open.run);
    const refused = { pages: [page('Push again KEEP-ME-LOCAL.\n')], consumption: [] };
    ok(await core.call('chore_submit', { run: open.run, result: refused }, chores));

    const listed = ok(await core.call('chore_runs', {}, human));
    const one = ok(await core.call('chore_runs', { run: open.run }, human));
    const failedOne = ok(await core.call('chore_runs', { run: secret.run }, human));

    expect(listed.runs.map((run) => [run.id, run.kind, run.origin, run.isolation, run.outcome, run.reasons, run.where])).toEqual([
      [open.run, 'wiki-maintainer', 'session', 'claude-chore-agent', 'open', [], 'this machine'],
      [secret.run, 'wiki-maintainer', 'session', 'claude-chore-agent', 'failed', ['secret'], 'tracker'],
    ]);
    expect(listed.runs[1]!.kept).toEqual([
      { n: 1, at: expect.any(String), reasons: ['secret'], rules: ['github-pat'], text_kept: false },
      { n: 2, at: expect.any(String), reasons: ['secret'], rules: ['github-pat'], text_kept: false },
    ]);
    expect(listed.runs[0]!.kept).toEqual([{ n: 1, at: expect.any(String), reasons: ['missing_pair'], rules: [], text_kept: true }]);
    expect(JSON.stringify(listed)).not.toContain('KEEP-ME-LOCAL');
    expect(one.runs).toHaveLength(1);
    expect(one.runs[0]!.kept[0]).toMatchObject({ text_kept: true, text: JSON.stringify(refused) });
    expect(failedOne.runs[0]!.kept.map((kept) => kept.text)).toEqual([null, null]);
    expect(JSON.stringify(failedOne)).not.toContain(token);
  });
});

describe('attention: the knowledge items', () => {
  test('the pending proposal leads the queue with its age and red-flag and cited-trace counts', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    p.clock.advance(5);
    ok(await p.core.call('purge_trace', { attempt: p.fails[0], reason: 'held a customer name' }, terminal(grimoire.ctx)));
    ok(await p.core.call('purge_trace', { attempt: p.fails[1], reason: 'held a customer name' }, terminal(grimoire.ctx)));

    const seen = ok(await p.core.call('attention', {}, dashboard(grimoire.ctx)));

    expect(seen.items).toEqual([
      { kind: 'pending_proposal', proposal: { id: proposal, skill: SKILL, action: 'patch', at: expect.any(String), age_hours: 5, red_flags: 1, traces: 4, pages: 1 } },
    ]);
  });

  test('a fork across clones is an item whose choices are its sides, the standing one marked; acknowledging one clears it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    ok(await core.call('skill_edit', { name: 'release-notes', text: notes('Create `changes/<slug>.md`.'), base: null }, terminal(ctx)));
    await share(world);
    const fromAlice = notes('Create `changes/<slug>.md` with a `kind:` line.');
    const fromBob = notes('Create `changes/<slug>.md` with a `summary:` line.');
    await decide(world.a, { kind: 'accept', skill: 'release-notes', proposal: 'pr-alice', text: fromAlice });
    await decide(world.b, { kind: 'accept', skill: 'release-notes', proposal: 'pr-bob', text: fromBob });
    await fetchTrackerFrom(world.a, world.b);
    const [lower, higher] = [versionOf(fromAlice), versionOf(fromBob)].sort() as [string, string];

    const seen = ok(await core.call('attention', {}, dashboard(ctx)));
    ok(await core.call('skill_acknowledge', { name: 'release-notes', version: higher }, dashboard(ctx)));
    const after = ok(await core.call('attention', {}, dashboard(ctx)));
    const shown = ok(await core.call('skill_show', { name: 'release-notes' }, dashboard(ctx)));

    expect(seen.items).toEqual([
      {
        kind: 'skill_fork',
        skill: 'release-notes',
        current: lower,
        fork: true,
        contested: [],
        choices: [lower, higher].map((version) => ({ version, standing: version === lower, kind: 'accept', by: expect.stringContaining('@'), at: expect.any(String) })),
      },
    ]);
    expect(after.items).toEqual([]);
    expect(shown.skills[0]).toMatchObject({ current: higher, superseded: [] });
  });

  test('a conflicted wiki page, and a page a quarantined trace flags, are items', async ({ world, grimoire }) => {
    const human = dashboard(grimoire.ctx);
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const trace = await workPair(core, grimoire.ctx, 'fail', 'Port clash');
    const version = await putPage(world.a, world.a, 'port-clash', [trace]);
    await commitChoreRun(world.a, world.a, compileRecord('cr-0000000001', T0.toISOString(), [[trace, 'fail']], { 'port-clash': version }));
    await conflictedPage(world);
    ok(await core.call('quarantine', { trace, reason: 'a customer name' }, human));

    const seen = ok(await core.call('attention', {}, human));

    expect(seen.items).toEqual([
      { kind: 'wiki_conflict', slug: 'flaky-port-binding', title: 'Flaky port binding', sides: 1 },
      { kind: 'flagged_page', slug: 'port-clash', title: 'Page port-clash', flagged_by: [trace] },
    ]);
  });
});

describe('skill_show for the Skills screens', () => {
  test('each skill carries its version count, last change and pending proposal; with a name, every worktree’s copy state and the worktrees eject may pick', async ({
    world,
    grimoire,
  }) => {
    // Pinned first: the skill's creation refreshes this worktree's copy; worktree b, added later, has none yet.
    await pinAndCommit(world.a);
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const human = dashboard(grimoire.ctx);
    await p.core.close();
    const b = await world.a.addWorktree('b');

    const all = ok(await grimoire.makeCore({ clock: p.clock.now }).call('skill_show', {}, human));
    const one = ok(await grimoire.makeCore({ clock: p.clock.now }).call('skill_show', { name: SKILL }, human));

    expect(all.skills[0]).toMatchObject({ name: SKILL, versions: 1, last_change: { kind: 'edit', version: p.base }, pending_proposal: proposal });
    expect(one.skills[0]!.worktrees).toEqual([await realpath(world.a.dir), await realpath(b.dir)]);
    expect(one.skills[0]!.copies).toEqual([
      { worktree: await realpath(world.a.dir), version: p.base, state: 'current' },
      { worktree: await realpath(b.dir), version: null, state: 'none' },
    ]);
  });
});

/** The forks' skill text: release-notes with one line. */
function notes(line: string): string {
  return `---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\n${line}\n`;
}

function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Records one decision in `clone`'s tracker, as a human in the dashboard would. */
async function decide(clone: Clone, change: SkillChange): Promise<void> {
  const store = await openTracker(clone.dir);
  try {
    const author = { name: clone.identity.name, email: clone.identity.email };
    await store.transact({ op: change.kind, author, actor: { kind: 'human', client: 'dashboard', nonce: 'n' } }, async (draft) => {
      await writeSkillChange(draft, createScanner(bundledRules), change, {
        actor: { kind: 'human' },
        by: clone.identity.email,
        surface: 'dashboard',
        clone: clone.identity.email.startsWith('alice') ? 'c10e00000000000a' : 'c10e00000000000b',
      });
      return { result: null };
    });
  } finally {
    await store.close();
  }
}

/** Clone b takes a's tracker as its own, so the two write apart until they fold. */
async function share(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

/** A page two clones changed apart on overlapping lines: clone a reads it conflicted. */
async function conflictedPage(world: GitWorld): Promise<void> {
  const file = 'knowledge/wiki/pages/flaky-port-binding.md';
  const record = (body: string, sources: string[], at: Date) =>
    [
      '---',
      'slug: "flaky-port-binding"',
      'title: "Flaky port binding"',
      'kind: "failure"',
      'summary: "Tests fail when two servers race for one port."',
      `sources: ${JSON.stringify(sources)}`,
      `generated: "${at.toISOString()}"`,
      'verified: null',
      `updated_at: "${at.toISOString()}"`,
      '---',
      body,
    ].join('\n');
  const lines = 'Bind to port 0.\nRead the port back.\nPass it to the client.\n';
  await commitToTracker(world.a, { [file]: record(lines, ['at-aaaaaa'], T0) });
  await share(world);
  await commitToTracker(world.a, { [file]: record(lines.replace('Read the port back.', 'Read it from the log.'), ['at-bbbbbb'], new Date(T0.getTime() + 60_000)) });
  await commitToTracker(world.b, { [file]: record(lines.replace('Read the port back.', 'Ask the OS.'), ['at-cccccc'], new Date(T0.getTime() + 120_000)) });
  await fetchTrackerFrom(world.a, world.b);
}
