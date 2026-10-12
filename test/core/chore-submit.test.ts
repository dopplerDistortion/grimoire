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
import type { Clone, GitWorld } from '#harness';
import { openTracker } from '../../src/tracker';
import { choreAgent, Clock, DEBRIEF, putPage, terminal } from './chore-support';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  fetchTracker,
  fetchTrackerFrom,
  pushTracker,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
  type Grimoire,
} from './support';

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
    // Nowhere on the tracker: the no_pattern reason is never committed.
    expect(await world.a.git(['grep', '-c', 'IGNORE-ME', tip]).catch(() => 'no match')).toBe('no match');
    expect(await world.a.git(['log', '-p', '--format=%B', TRACKER_REF])).not.toContain('IGNORE-ME');
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

/** A create op for `slug` with `body`. */
const create = (slug: string, body = 'Pin the seed.\n') => ({ op: 'create', slug, title: `About ${slug}`, kind: 'failure', summary: `About ${slug}.`, body });
/** Every pair of the brief to `slug`. */
const allTo = (brief: ChoreBrief, slug: string) => brief.pairs.map((pair) => ({ pair: pair.pair, slugs: [slug] }));
const store = (world: { a: { dir: string } }) => new MachineLocalStore(path.join(world.a.dir, '.git'));

describe('chore_submit: the fail-closed guards', () => {
  test('a page over 12,000 characters and a 9th page write are refused; 12,000 characters, and a shrink of exactly 25%, are not; more is', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const first = await startAndRead(d);
    const tooLong = ok(await d.core.call('chore_submit', { run: first.run, result: { pages: [create('long', 'x'.repeat(12_001))], consumption: allTo(first, 'long') } }, d.chores));
    expect(tooLong).toMatchObject({ result: 'invalid', reasons: ['page_too_long'], problems: { 'pages[0].body': expect.stringContaining('12,001') } });
    const nine = Array.from({ length: 9 }, (_, i) => create(`page-${i}`));
    const tooMany = ok(await d.core.call('chore_submit', { run: first.run, result: { pages: nine, consumption: allTo(first, 'page-0') } }, d.chores));
    expect(tooMany).toMatchObject({ result: 'failed', reasons: ['too_many_pages'] });

    // One strike: the pair is offered again, and exactly 12,000 characters fit.
    const second = await startAndRead(d);
    const full = 'y'.repeat(11_999) + '\n';
    expect(ok(await d.core.call('chore_submit', { run: second.run, result: { pages: [create('long', full)], consumption: allTo(second, 'long') } }, d.chores))).toMatchObject({
      result: 'compiled',
      pages: 1,
    });

    // A new pair: an update may shrink the page by 25% of its 12,000 characters, no more.
    d.clock.advance(1);
    const another = await work(d.core, grimoire.ctx, 'fail', 'Another fail');
    d.clock.advance(25);
    const third = await startAndRead(d);
    const page = ok(await d.core.call('chore_read', { run: third.run, item: 'page:long' }, d.chores)).items[0]!;
    const update = (body: string) => ({ op: 'update', slug: 'long', base_hash: page.version, body });
    const shrunk = ok(await d.core.call('chore_submit', { run: third.run, result: { pages: [update('z'.repeat(8_999))], consumption: allTo(third, 'long') } }, d.chores));
    expect(shrunk).toMatchObject({ result: 'invalid', reasons: ['page_shrinks'], problems: { 'pages[0].body': expect.stringContaining('12,000') } });
    const quarter = ok(await d.core.call('chore_submit', { run: third.run, result: { pages: [update('z'.repeat(9_000))], consumption: allTo(third, 'long') } }, d.chores));
    expect(quarter).toMatchObject({ result: 'compiled', pages: 1 });
    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/pages/long.md')).toContain(`sources: ${JSON.stringify([another, d.fails[0]].sort())}`);
  });

  test('a secret blocks the write: the codes and rule ids are kept, the result text is not, and the error never quotes it', async ({ world, grimoire }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const brief = await startAndRead(d);
    const token = ['ghp', 'R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u'].join('_');
    const before = await trackerTip(world.a);

    const leaked = ok(
      await d.core.call(
        'chore_submit',
        { run: brief.run, result: { pages: [create('ci-pushes', `Push with ${token} when CI fails.\n`)], consumption: allTo(brief, 'ci-pushes') } },
        d.chores,
      ),
    );
    expect(leaked).toMatchObject({ result: 'invalid', reasons: ['secret'], problems: { 'pages[0].body': expect.stringContaining('github-pat') } });
    expect(JSON.stringify(leaked)).not.toContain(token);
    expect(await trackerTip(world.a)).toBe(before);
    // A secret in a no_pattern reason, kept on this machine only, is refused the same way.
    const inReason = ok(await d.core.call('chore_submit', { run: brief.run, result: { pages: [], consumption: [{ pair: brief.pairs[0]!.pair, no_pattern: `see ${token}` }] } }, d.chores));
    expect(inReason).toMatchObject({ result: 'failed', reasons: ['secret'] });

    const kept = await store(world).records.list<Record<string, unknown>>('chore-results');
    expect(kept.map((entry) => entry.value)).toEqual([
      { run: brief.run, at: expect.any(String), reasons: ['secret'], rules: ['github-pat'] },
      { run: brief.run, at: expect.any(String), reasons: ['secret'], rules: ['github-pat'] },
    ]);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['grep', '-c', token, tip]).catch(() => 'no match')).toBe('no match');
    expect((await servedLog(store(world), brief.run)).no_pattern).toBeUndefined();
  });

  test('a refused result without a secret keeps its text on this machine only', async ({ world, grimoire }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const brief = await startAndRead(d);
    const result = { pages: [create('a-page', 'The body KEEP-ME-LOCAL.\n')], consumption: [] };
    ok(await d.core.call('chore_submit', { run: brief.run, result }, d.chores));
    const kept = await store(world).records.list<{ text?: string; reasons: string[] }>('chore-results');
    expect(kept.map((entry) => entry.value)).toMatchObject([{ reasons: ['missing_pair'], text: JSON.stringify(result) }]);
  });
});

/** Clone b takes clone a's tracker as its own: from here the two write apart until they fold. */
async function bothClones(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

async function fold(checkout: Clone): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.fold({ author: { ...checkout.identity }, actor: { kind: 'human', client: 'cli', nonce: 'fold' } });
  } finally {
    await tracker.close();
  }
}

describe('chore_submit: clones, late submits and replays', () => {
  test('two clones compiling the same batch merge their records by union: both pages, both runs in the log, the pairs compiled', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire, { fails: 2, passes: 0 });
    await bothClones(world);
    const onB = { core: grimoire.makeCore({ clock: d.clock.now }), chores: await choreAgent(agentContext(world.b)) };
    const runA = await startAndRead(d);
    const runB = await startAndRead({ ...d, ...onB });
    expect(runB.pairs).toEqual(runA.pairs);

    ok(await d.core.call('chore_submit', { run: runA.run, result: { pages: [create('a-page')], consumption: allTo(runA, 'a-page') } }, d.chores));
    ok(await onB.core.call('chore_submit', { run: runB.run, result: { pages: [create('b-page')], consumption: allTo(runB, 'b-page') } }, onB.chores));
    await fetchTrackerFrom(world.a, world.b);
    await fold(world.a);

    const tip = (await trackerTip(world.a))!;
    const records = (await world.a.git(['ls-tree', '-r', '--name-only', tip, 'knowledge/chore-runs/'])).split('\n').sort();
    expect(records).toEqual([runA.run, runB.run].map((run) => `knowledge/chore-runs/${run[3]}/${run[4]}/${run}.md`).sort());
    const log = (await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).split('\n').filter((line) => line.startsWith('- '));
    expect(log.sort()).toEqual(
      [
        `- ${d.clock.now().toISOString()}: Wiki Maintainer run ${runA.run} compiled 2 traces into 1 page: [a-page](pages/a-page.md)`,
        `- ${d.clock.now().toISOString()}: Wiki Maintainer run ${runB.run} compiled 2 traces into 1 page: [b-page](pages/b-page.md)`,
      ].sort(),
    );
    const index = await trackerFile(world.a, tip, 'knowledge/wiki/index.md');
    expect(index).toContain('[About a-page](pages/a-page.md)');
    expect(index).toContain('[About b-page](pages/b-page.md)');
    expect(await d.core.call('chore_start', { kind: 'wiki-maintainer' }, d.chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
  });

  test('a late submit is accepted while nothing newer started and its inputs are unconsumed; after a newer run, or a compile of its pairs, RUN_SUPERSEDED', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const result = (brief: ChoreBrief) => ({ pages: [], consumption: allNoPattern(brief) });

    // The lease lapsed, and a newer run started: the old one is superseded.
    const old = await startAndRead(d);
    d.clock.advance(1.1);
    const newer = await startAndRead(d);
    const before = await trackerTip(world.a);
    expect(await d.core.call('chore_submit', { run: old.run, result: result(old) }, d.chores)).toMatchObject({ ok: false, error: { code: 'RUN_SUPERSEDED' } });
    expect(await trackerTip(world.a)).toBe(before);

    // The newer run's lease lapsed too, but nothing started since and its inputs are unconsumed: accepted.
    d.clock.advance(1.1);
    expect(ok(await d.core.call('chore_submit', { run: newer.run, result: result(newer) }, d.chores))).toMatchObject({ result: 'compiled' });

    // Another clone compiled a late run's pairs meanwhile: superseded.
    d.clock.advance(1);
    await work(d.core, grimoire.ctx, 'fail', 'Later fail');
    d.clock.advance(25);
    const late = await startAndRead(d);
    await bothClones(world);
    const onB = { core: grimoire.makeCore({ clock: d.clock.now }), chores: await choreAgent(agentContext(world.b)) };
    const there = await startAndRead({ ...d, ...onB });
    ok(await onB.core.call('chore_submit', { run: there.run, result: result(there) }, onB.chores));
    await fetchTrackerFrom(world.a, world.b);
    d.clock.advance(1.1);
    expect(await d.core.call('chore_submit', { run: late.run, result: result(late) }, d.chores)).toMatchObject({
      ok: false,
      error: { code: 'RUN_SUPERSEDED', message: expect.stringContaining(there.run) },
    });
  });

  test('a retried submit replays its answer: after a compile nothing is written again; a refused submit retried with its key keeps the fix-up', async ({
    world,
    grimoire,
  }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    const brief = await startAndRead(d);
    const bad = { run: brief.run, result: { pages: [], consumption: [] }, idempotency_key: 'k1' };
    const first = ok(await d.core.call('chore_submit', bad, d.chores));
    expect(ok(await d.core.call('chore_submit', bad, d.chores))).toEqual({ ...first, replayed: true });

    const good = { run: brief.run, result: { pages: [], consumption: allNoPattern(brief) }, idempotency_key: 'k2' };
    const compiled = ok(await d.core.call('chore_submit', good, d.chores));
    expect(compiled).toMatchObject({ result: 'compiled' });
    const tip = await trackerTip(world.a);
    expect(ok(await d.core.call('chore_submit', good, d.chores))).toEqual({ ...compiled, replayed: true });
    expect(ok(await d.core.call('chore_submit', { run: brief.run, result: {} }, d.chores))).toEqual({ ...compiled, replayed: true });
    expect(await trackerTip(world.a)).toBe(tip);
  });

  test('accepted and failed submits ask for the automatic sync of their commit; a refused one does not', async ({ world, grimoire }) => {
    const asked: string[] = [];
    const d = await due(grimoire, { fails: 1, passes: 0 }, { autoSync: ({ tip }) => void asked.push(tip) });
    const before = asked.length;
    const brief = await startAndRead(d);
    ok(await d.core.call('chore_submit', { run: brief.run, result: { pages: [], consumption: [] } }, d.chores));
    expect(asked.length).toBe(before);
    ok(await d.core.call('chore_submit', { run: brief.run, result: { pages: [], consumption: [] } }, d.chores));
    const failedAt = await trackerTip(world.a);
    const again = await startAndRead(d);
    ok(await d.core.call('chore_submit', { run: again.run, result: { pages: [], consumption: allNoPattern(again) } }, d.chores));
    await d.core.close();
    expect(asked.slice(before)).toEqual([failedAt, await trackerTip(world.a)]);
  });
});

describe('chore_submit: citations and conflicted pages', () => {
  test('only served items may be cited: an unread trace, or an update of an unread page, is refused', async ({ world, grimoire }) => {
    const d = await due(grimoire, { fails: 1, passes: 0 });
    await putPage(world.a, world.a, 'known', []);
    const brief = ok(await d.core.call('chore_start', {}, d.chores));
    const refused = ok(
      await d.core.call(
        'chore_submit',
        { run: brief.run, result: { pages: [{ op: 'update', slug: 'known', base_hash: 'x', body: 'How known goes wrong, again.\n' }], consumption: allTo(brief, 'known') } },
        d.chores,
      ),
    );
    expect(refused).toMatchObject({ result: 'invalid', reasons: ['unserved'] });
    expect(Object.keys(refused.problems!).sort()).toEqual(['consumption[0].pair', 'consumption[0].slugs', 'pages[0].slug']);
  });

  test('a reconciling update clears the conflicted mark, records the side it resolved, keeps both sides’ sources and measures the shrink against the larger side', async ({
    world,
    grimoire,
  }) => {
    const clock = new Clock(T0);
    const core = grimoire.makeCore({ clock: clock.now });
    const chores = await choreAgent(grimoire.ctx);
    await putPage(world.a, world.a, 'port-binding', ['at-aaaaaa']);
    const sideBody = 'The other clone’s much longer account of the port binding failure.\n'.repeat(60);
    const side = `---\nslug: "port-binding"\nfields: ["body"]\nsources: ["at-bbbbbb"]\nat: "${T0.toISOString()}"\n---\n${sideBody}`;
    const sideId = createHash('sha256').update(side).digest('hex');
    await commitToTracker(world.a, { [`knowledge/wiki/conflicts/port-binding/${sideId}.md`]: side });

    const brief = ok(await core.call('chore_start', {}, chores));
    expect(brief.conflicted).toEqual(['port-binding']);
    const items = (await readAll(core, chores, brief.run)).flatMap((page) => page.items);
    const version = items.find((item) => item.item === 'page:port-binding')!.version as string;
    const update = (body: string) => ({ run: brief.run, result: { pages: [{ op: 'update', slug: 'port-binding', base_hash: version, body }], consumption: [] } });

    const shrunk = ok(await core.call('chore_submit', update(sideBody.slice(0, Math.floor(sideBody.length * 0.7))), chores));
    expect(shrunk).toMatchObject({ result: 'invalid', reasons: ['page_shrinks'] });
    const reconciled = ok(await core.call('chore_submit', update(sideBody.slice(0, Math.ceil(sideBody.length * 0.8))), chores));

    expect(reconciled).toMatchObject({ result: 'compiled', pages: 1 });
    expect(reconciled.summary).toBe(`grimoire chores: compile done, 0 traces, 1 page (0 created, 1 updated), 1 conflict resolved; run ${brief.run}`);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['ls-tree', '-r', '--name-only', tip, 'knowledge/wiki/conflicts/'])).toBe('');
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/pages/port-binding.md')).toContain('sources: ["at-aaaaaa","at-bbbbbb"]');
    expect(await trackerFile(world.a, tip, `knowledge/chore-runs/${brief.run[3]}/${brief.run[4]}/${brief.run}.md`)).toContain(`resolved: ["port-binding/${sideId}"]`);
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).toContain(`compiled 0 traces into 1 page: [port-binding](pages/port-binding.md), resolving 1 conflict`);
    const listed = ok(await core.call('wiki_list', {}, terminal(grimoire.ctx)));
    expect(listed.pages).toMatchObject([{ slug: 'port-binding', conflicted: false }]);
  });
});

function createHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
