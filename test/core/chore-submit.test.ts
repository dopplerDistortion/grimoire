// Seam 1 (spec §16 Results: Wiki Maintainer, Failures and replays, Chore-run
// records; §17 pages, folds, reconcile; ADR 0006): a Wiki Maintainer run
// submits page ops and a consumption map; grimoire checks them fail-closed and
// writes every page itself, regenerating the index and deriving the log, with
// the chore-run record in the same tracker commit. An invalid result gets
// reason codes and exactly one fix-up; a second failure ends the run `failed`.
// Committed records carry no LLM free text.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, ChoreBrief, ChoreReadResult, Core } from '../../src/core';
import { servedLog } from '../../src/knowledge/chores';
import { MachineLocalStore } from '../../src/machine-local';
import { choreAgent, Clock, DEBRIEF, terminal } from './chore-support';
import { coreTest as test, T0, trackerFile, trackerTip, TRACKER_REF, type Grimoire } from './support';

function ok<T>(outcome: { ok: true; result: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw new Error(`call failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

/** An attempt on a new issue ended as a pass (closed done) or a fail (released). */
async function work(core: Core, ctx: CallContext, verdict: 'pass' | 'fail', title: string): Promise<string> {
  const { id } = ok(await core.call('create', { title, body: `Body of ${title}` }, ctx));
  const { attempt } = ok(await core.call('claim', { id }, ctx));
  if (verdict === 'pass') ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  else ok(await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx));
  return attempt;
}

/** Every page of a run, in order. */
async function readAll(core: Core, ctx: CallContext, run: string): Promise<ChoreReadResult[]> {
  const pages: ChoreReadResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = ok(await core.call('chore_read', { run, ...(cursor ? { cursor } : {}) }, ctx));
    pages.push(page);
    if (!page.cursor) return pages;
    cursor = page.cursor;
  }
  throw new Error('chore_read never ended');
}

interface Due {
  core: Core;
  clock: Clock;
  chores: CallContext;
  fails: string[];
  passes: string[];
}

/** Settled pairs (2 fails, 1 pass), the Wiki Maintainer due at 1 pair. */
async function due(grimoire: Grimoire, counts = { fails: 2, passes: 1 }, options: Parameters<Grimoire['makeCore']>[0] = {}): Promise<Due> {
  const clock = new Clock(T0);
  const core = grimoire.makeCore({ clock: clock.now, ...options });
  await core.call('settings_set', { key: 'chores.compile_pairs', value: 1 }, terminal(grimoire.ctx));
  const fails: string[] = [];
  const passes: string[] = [];
  for (let i = 0; i < counts.fails; i++) fails.push(await work(core, grimoire.ctx, 'fail', `Fail ${i}`));
  for (let i = 0; i < counts.passes; i++) passes.push(await work(core, grimoire.ctx, 'pass', `Pass ${i}`));
  clock.advance(25);
  return { core, clock, chores: await choreAgent(grimoire.ctx), fails, passes };
}

/** Starts the due compile and reads everything it is served. */
async function startAndRead(d: Due): Promise<ChoreBrief> {
  const brief = ok(await d.core.call('chore_start', {}, d.chores));
  await readAll(d.core, d.chores, brief.run);
  return brief;
}

const PORT_BODY = 'Tests that bind a fixed port fail when another run holds it.\n\nBind to port 0 and read the port back.\n';

describe('chore_submit: a Wiki Maintainer result', () => {
  test('a valid result writes the pages with sources from the map, regenerates the index and log, and commits the run record in the same commit', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire);
    const brief = await startAndRead(d);
    const before = (await trackerTip(world.a))!;
    const [fail0, fail1] = d.fails as [string, string];
    const [pass0] = d.passes as [string];

    const submitted = ok(
      await d.core.call(
        'chore_submit',
        {
          run: brief.run,
          result: {
            pages: [
              { op: 'create', slug: 'fixed-port-collisions', title: 'Fixed port collisions', kind: 'failure', summary: 'Tests on fixed ports collide.', body: PORT_BODY },
              { op: 'create', slug: 'pin-the-seed', title: 'Pin the seed', kind: 'strategy', summary: 'Pinning the random seed settles flaky tests.', body: 'Pin the seed.\n' },
            ],
            consumption: [
              { pair: `${fail0}@fail`, slugs: ['fixed-port-collisions'] },
              { pair: `${fail1}@fail`, slugs: ['fixed-port-collisions', 'pin-the-seed'] },
              { pair: `${pass0}@pass`, no_pattern: 'IGNORE-ME a one-off typo fix' },
            ],
            client: 'claude-code',
            model: 'claude-opus-5-5',
          },
        },
        d.chores,
      ),
    );

    const tip = (await trackerTip(world.a))!;
    // One commit on top of the tip the run started from.
    expect(await world.a.git(['rev-parse', `${tip}^`])).toBe(before);
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('compile');
    const changed = (await world.a.git(['diff', '--name-only', before, tip])).split('\n').sort();
    const record = changed.find((file) => file.startsWith('knowledge/chore-runs/'))!;
    expect(record).toBe(`knowledge/chore-runs/${brief.run[3]}/${brief.run[4]}/${brief.run}.md`);
    expect(changed).toEqual(
      [
        record,
        'knowledge/wiki/index.md',
        'knowledge/wiki/log.md',
        'knowledge/wiki/pages/fixed-port-collisions.md',
        'knowledge/wiki/pages/pin-the-seed.md',
      ].sort(),
    );

    const page = await trackerFile(world.a, tip, 'knowledge/wiki/pages/fixed-port-collisions.md');
    expect(page).toBe(
      [
        '---',
        'slug: "fixed-port-collisions"',
        'title: "Fixed port collisions"',
        'kind: "failure"',
        'summary: "Tests on fixed ports collide."',
        `sources: ${JSON.stringify([fail0, fail1].sort())}`,
        `generated: "${d.clock.now().toISOString()}"`,
        'verified: null',
        `updated_at: "${d.clock.now().toISOString()}"`,
        '---',
        PORT_BODY,
      ].join('\n'),
    );
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/pages/pin-the-seed.md')).toContain(`sources: ["${fail1}"]`);
    const index = await trackerFile(world.a, tip, 'knowledge/wiki/index.md');
    expect(index).toContain('- [Fixed port collisions](pages/fixed-port-collisions.md) (failure): Tests on fixed ports collide.');
    expect(index).toContain('- [Pin the seed](pages/pin-the-seed.md) (strategy): Pinning the random seed settles flaky tests.');
    const log = (await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).split('\n').filter((line) => line.startsWith('- '));
    expect(log).toEqual([
      `- ${d.clock.now().toISOString()}: Wiki Maintainer run ${brief.run} compiled 3 traces into 2 pages: [fixed-port-collisions](pages/fixed-port-collisions.md), [pin-the-seed](pages/pin-the-seed.md)`,
    ]);

    // The record: no free text, the consumption map without the no_pattern reason, page versions, served ids and hashes.
    const text = await trackerFile(world.a, tip, record);
    expect(text).not.toContain('IGNORE-ME');
    expect(text).not.toContain('Fixed port collisions');
    const served = await servedLog(new MachineLocalStore(path.join(world.a.dir, '.git')), brief.run);
    const versions = {
      'fixed-port-collisions': createHashOf(page),
      'pin-the-seed': createHashOf(await trackerFile(world.a, tip, 'knowledge/wiki/pages/pin-the-seed.md')),
    };
    expect(text.split('\n')).toEqual([
        '---',
        'kind: "wiki-maintainer"',
        'result: "compiled"',
        'origin: "session"',
        'isolation: "claude-chore-agent"',
        'unverified: {"client":"claude-code","model":"claude-opus-5-5"}',
        expect.stringMatching(/^actor: \{"person":"alice@example\.com","kind":"agent",.*\}$/),
        `started_at: "${d.clock.now().toISOString()}"`,
        `at: "${d.clock.now().toISOString()}"`,
        `consumption: ${JSON.stringify([
          { trace: fail0, outcome: 'fail', slugs: ['fixed-port-collisions'], no_pattern: false },
          { trace: fail1, outcome: 'fail', slugs: ['fixed-port-collisions', 'pin-the-seed'], no_pattern: false },
          { trace: pass0, outcome: 'pass', slugs: [], no_pattern: true },
        ])}`,
        `pages: ${JSON.stringify(versions)}`,
        `served: ${JSON.stringify(served.items.map((entry) => ({ item: entry.item, hash: entry.hash })))}`,
        'consumed: []',
        'proposal: null',
        'reasons: []',
        'pairs: []',
      'resolved: []',
      '---',
      '',
    ]);
    // The no_pattern reason stays in this machine's served-item log.
    expect(served.no_pattern).toEqual({ [`${pass0}@pass`]: 'IGNORE-ME a one-off typo fix' });

    // The result: counts and ids only.
    expect(submitted).toMatchObject({ run: brief.run, kind: 'wiki-maintainer', result: 'compiled' });
    expect(submitted.summary).toBe(`grimoire chores: compile done, 3 traces, 2 pages (2 created, 0 updated); run ${brief.run}`);
    // The pairs are compiled: the Wiki Maintainer isn't due any more (the Skill Proposer is, with 2 fails compiled).
    expect(await d.core.call('chore_start', { kind: 'wiki-maintainer' }, d.chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
  });
});

/** Maps every pair of the brief to no_pattern. */
function allNoPattern(brief: ChoreBrief) {
  return brief.pairs.map((pair) => ({ pair: pair.pair, no_pattern: 'nothing recurring' }));
}

describe('chore_submit: refusals and the one fix-up', () => {
  test('an invalid result gets reason codes and one fix-up; a fixed result then compiles', async ({ world, grimoire }) => {
    const d = await due(grimoire);
    const brief = await startAndRead(d);
    const before = await trackerTip(world.a);

    const refused = ok(
      await d.core.call(
        'chore_submit',
        { run: brief.run, result: { pages: [{ op: 'create', slug: 'Not A Slug', title: 'T', kind: 'pattern', summary: 's', body: 'b' }], consumption: allNoPattern(brief).slice(1) } },
        d.chores,
      ),
    );

    expect(refused).toMatchObject({ run: brief.run, result: 'invalid', fix_ups_left: 1, reasons: ['bad_slug', 'missing_pair'] });
    expect(refused.problems).toMatchObject({ 'pages[0].slug': expect.any(String), consumption: expect.stringContaining(brief.pairs[0]!.pair) });
    expect(refused.summary).toBe(`grimoire chores: compile result refused (bad_slug, missing_pair); one fix-up left; run ${brief.run}`);
    expect(await trackerTip(world.a)).toBe(before);

    const fixed = ok(await d.core.call('chore_submit', { run: brief.run, result: { pages: [], consumption: allNoPattern(brief) } }, d.chores));
    expect(fixed).toMatchObject({ result: 'compiled', traces: 3, pages: 0 });
    expect(fixed.summary).toBe(`grimoire chores: compile done, 3 traces, 0 pages (0 created, 0 updated); run ${brief.run}`);
    // A compile writing no page is still in the log.
    const log = await trackerFile(world.a, (await trackerTip(world.a))!, 'knowledge/wiki/log.md');
    expect(log).toContain(`Wiki Maintainer run ${brief.run} compiled 3 traces, writing no pages`);
  });

  test('a second failure ends the run failed, committing reason codes and served pairs; after a second failed run the pairs are set aside', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const bad = { pages: [], consumption: [] };
    for (let round = 1; round <= 2; round++) {
      const brief = await startAndRead(d);
      // One strike leaves the pair offered.
      expect(brief.pairs.map((pair) => pair.trace), `round ${round}`).toEqual([d.fails[0]]);
      const before = (await trackerTip(world.a))!;
      expect(ok(await d.core.call('chore_submit', { run: brief.run, result: bad }, d.chores))).toMatchObject({ result: 'invalid' });
      const failed = ok(await d.core.call('chore_submit', { run: brief.run, result: { ...bad, extra: true } }, d.chores));

      expect(failed).toMatchObject({ result: 'failed', fix_ups_left: 0, reasons: ['shape'] });
      expect(failed.summary).toBe(`grimoire chores: compile failed after its fix-up (shape); nothing written; run ${brief.run}`);
      const tip = (await trackerTip(world.a))!;
      expect(await world.a.git(['rev-parse', `${tip}^`])).toBe(before);
      const record = await trackerFile(world.a, tip, `knowledge/chore-runs/${brief.run[3]}/${brief.run[4]}/${brief.run}.md`);
      expect(record).toContain('result: "failed"');
      expect(record).toContain('reasons: ["shape"]');
      expect(record).toContain(`pairs: ["${d.fails[0]}@fail"]`);
      expect(record).toContain('unverified: {"client":null,"model":null}');
      // The run ended: it takes no more submits or reads.
      expect(await d.core.call('chore_read', { run: brief.run }, d.chores)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    // Two strikes: set aside, and nothing else makes the chore due.
    expect(await d.core.call('chore_start', { kind: 'wiki-maintainer' }, d.chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
  });
});

function createHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
