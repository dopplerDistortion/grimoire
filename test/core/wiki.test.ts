// The wiki on the tracker (spec §17): pages, their derived index and log, the
// human edit, its guards, folds across two clones, and page quarantine.
import { createHash } from 'node:crypto';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import type { GitWorld } from '#harness';
import { openTracker } from '../../src/tracker';
import { VERSION } from '../../src/version';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  expectRefUnmoved,
  fetchTracker,
  fetchTrackerFrom,
  pushTracker,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
} from './support';

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

const PAGE = {
  slug: 'flaky-port-binding',
  title: 'Flaky port binding',
  kind: 'failure',
  summary: 'Tests fail when two servers race for one port.',
  body: 'Bind to port 0 and read the port back.\n',
};

async function edit(core: Core, ctx: CallContext, input: Record<string, unknown>) {
  const result = await core.call('wiki_edit', input, ctx);
  if (!result.ok) throw new Error(`wiki_edit failed: ${JSON.stringify(result.error)}`);
  return result.result as { slug: string; created: boolean; changed: boolean; base: string; resolved: string[] };
}

describe('wiki edit', () => {
  test('creates a page as one tracker commit, with the index and the log regenerated', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const before = (await trackerTip(world.a))!;

    const created = await edit(core, terminal(ctx), { ...PAGE, base: null });

    expect(created).toEqual({ slug: PAGE.slug, created: true, changed: true, base: expect.stringMatching(/^[0-9a-f]{64}$/), resolved: [] });
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${before}`);
    const changed = (await world.a.git(['diff-tree', '-r', '--name-only', before, tip])).split('\n');
    expect(changed.filter((file) => !file.startsWith('knowledge/wiki/edits/'))).toEqual([
      'knowledge/wiki/index.md',
      'knowledge/wiki/log.md',
      'knowledge/wiki/pages/flaky-port-binding.md',
    ]);
    expect(changed.filter((file) => file.startsWith('knowledge/wiki/edits/'))).toHaveLength(1);
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/pages/flaky-port-binding.md')).toBe(
      [
        '---',
        'slug: "flaky-port-binding"',
        'title: "Flaky port binding"',
        'kind: "failure"',
        'summary: "Tests fail when two servers race for one port."',
        'sources: []',
        'generated: null',
        `verified: "${T0.toISOString()}"`,
        `updated_at: "${T0.toISOString()}"`,
        '---',
        'Bind to port 0 and read the port back.\n',
      ].join('\n'),
    );
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/index.md')).toBe(
      [
        '---',
        `generated-by: "${VERSION}"`,
        '---',
        '# Wiki index',
        '',
        '- [Flaky port binding](pages/flaky-port-binding.md) (failure): Tests fail when two servers race for one port.',
        '',
      ].join('\n'),
    );
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).toBe(
      [
        '---',
        `generated-by: "${VERSION}"`,
        '---',
        '# Wiki log',
        '',
        `- ${T0.toISOString()}: alice@example.com created [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
        '',
      ].join('\n'),
    );
    const message = await world.a.git(['log', '-1', '--format=%B', tip]);
    expect(message.split('\n')[0]).toBe('grimoire: wiki-edit');
    expect(message).toContain('Grimoire-Op: wiki-edit');
  });
});

describe('wiki edit, updating', () => {
  test('an update is one more tracker commit: the page moves to a new version, verified now, and the log gains a line', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const created = await edit(core, terminal(ctx), { ...PAGE, base: null });
    const before = (await trackerTip(world.a))!;

    const updated = await edit(core, terminal(ctx), {
      slug: PAGE.slug,
      base: created.base,
      body: 'Bind to port 0 and read the port back.\nNever hard-code 8080 in tests.\n',
    });

    expect(updated).toEqual({ slug: PAGE.slug, created: false, changed: true, base: expect.stringMatching(/^[0-9a-f]{64}$/), resolved: [] });
    expect(updated.base).not.toBe(created.base);
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${before}`);
    const changed = (await world.a.git(['diff-tree', '-r', '--name-only', before, tip])).split('\n');
    expect(changed.filter((file) => !file.startsWith('knowledge/wiki/edits/'))).toEqual([
      'knowledge/wiki/log.md',
      'knowledge/wiki/pages/flaky-port-binding.md',
    ]);
    const log = await trackerFile(world.a, tip, 'knowledge/wiki/log.md');
    expect(log.split('\n').filter((line) => line.startsWith('- '))).toEqual([
      `- ${T0.toISOString()}: alice@example.com created [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
      `- ${T0.toISOString()}: alice@example.com updated [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
    ]);
    const shown = await core.call('wiki_show', { slug: PAGE.slug }, terminal(ctx));
    expect(shown).toEqual({
      ok: true,
      result: {
        slug: PAGE.slug,
        title: PAGE.title,
        kind: 'failure',
        summary: PAGE.summary,
        sources: [],
        purged_sources: [],
        generated: null,
        verified: T0.toISOString(),
        updated_at: T0.toISOString(),
        conflicted: false,
        quarantined: false,
        flagged_by: [],
        body: 'Bind to port 0 and read the port back.\nNever hard-code 8080 in tests.\n',
        base: updated.base,
        sides: [],
        link: null,
      },
    });
  });

  test('an edit that changes nothing writes nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const created = await edit(core, terminal(ctx), { ...PAGE, base: null });

    const again = await expectRefUnmoved(world.a, () => edit(core, terminal(ctx), { slug: PAGE.slug, base: created.base, body: PAGE.body }));

    expect(again).toEqual({ slug: PAGE.slug, created: false, changed: false, base: created.base, resolved: [] });
  });

  test('wiki list shows every page by slug, and the page text never lands in a checkout', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, terminal(ctx), { ...PAGE, base: null });
    await edit(core, terminal(ctx), {
      slug: 'retry-with-backoff',
      base: null,
      title: 'Retry with backoff',
      kind: 'strategy',
      summary: 'Retry flaky network calls with jittered backoff.',
      body: 'Use exponential backoff with jitter.\n',
    });

    const listed = await core.call('wiki_list', {}, terminal(ctx));

    expect(listed.ok && listed.result.pages.map((page) => [page.slug, page.kind, page.conflicted, page.quarantined])).toEqual([
      ['flaky-port-binding', 'failure', false, false],
      ['retry-with-backoff', 'strategy', false, false],
    ]);
    expect(await world.a.git(['status', '--porcelain', '--ignored', '--untracked-files=all'])).toBe('');
  });
});

describe('wiki edit guards', () => {
  test('a stale base, or a create over an existing page, gives BASE_MOVED with the ref unmoved', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const created = await edit(core, terminal(ctx), { ...PAGE, base: null });
    await edit(core, terminal(ctx), { slug: PAGE.slug, base: created.base, body: `${PAGE.body}More.\n` });

    const stale = await expectRefUnmoved(world.a, () =>
      core.call('wiki_edit', { slug: PAGE.slug, base: created.base, body: `${PAGE.body}Other.\n` }, terminal(ctx)),
    );
    const recreate = await expectRefUnmoved(world.a, () => core.call('wiki_edit', { ...PAGE, base: null }, terminal(ctx)));

    expect(stale).toMatchObject({ ok: false, error: { code: 'BASE_MOVED', retryable: false } });
    expect(recreate).toMatchObject({ ok: false, error: { code: 'BASE_MOVED' } });
  });

  test('a page over 12,000 characters, or a shrink of more than 25%, is refused', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const body = `${'x'.repeat(99)}\n`.repeat(40); // 4,000 characters
    const created = await edit(core, terminal(ctx), { ...PAGE, base: null, body });

    const tooLong = await expectRefUnmoved(world.a, () =>
      core.call('wiki_edit', { slug: PAGE.slug, base: created.base, body: 'y'.repeat(12_001) }, terminal(ctx)),
    );
    const atCap = await core.call('wiki_edit', { ...PAGE, slug: 'at-the-cap', base: null, body: 'y'.repeat(12_000) }, terminal(ctx));
    const shrunk = await expectRefUnmoved(world.a, () =>
      core.call('wiki_edit', { slug: PAGE.slug, base: created.base, body: body.slice(0, 2_999) }, terminal(ctx)),
    );
    const quarter = await core.call('wiki_edit', { slug: PAGE.slug, base: created.base, body: body.slice(0, 3_000) }, terminal(ctx));

    expect(tooLong).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { body: expect.stringContaining('12,000') } } } });
    expect(atCap).toMatchObject({ ok: true });
    expect(shrunk).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { body: expect.stringContaining('25%') } } } });
    expect(quarter).toMatchObject({ ok: true });
  });

  test('a secret in the text blocks the commit, and the error never quotes it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const token = ['ghp', 'R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u'].join('_');

    const result = await expectRefUnmoved(world.a, () =>
      core.call('wiki_edit', { ...PAGE, base: null, body: `Push with token ${token} when CI fails.\n` }, terminal(ctx)),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { body: expect.stringContaining('github-pat') } } } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test('conflict markers left from reconciling, or hidden characters, are refused', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const markers = `${['<'.repeat(7), 'mine'].join(' ')}\nBind to port 0.\n${'='.repeat(7)}\nAsk the OS.\n${['>'.repeat(7), 'theirs'].join(' ')}\n`;

    const results = await expectRefUnmoved(world.a, () =>
      Promise.all([
        core.call('wiki_edit', { ...PAGE, base: null, body: markers }, terminal(ctx)),
        core.call('wiki_edit', { ...PAGE, base: null, title: `Flaky${String.fromCodePoint(0x200b)} port` }, terminal(ctx)),
      ]),
    );

    expect(results).toMatchObject([
      { ok: false, error: { code: 'INVALID', details: { fields: { body: expect.stringContaining('conflict markers') } } } },
      { ok: false, error: { code: 'INVALID', details: { fields: { title: expect.stringContaining('hidden') } } } },
    ]);
  });

  test('a summary over 200 characters, an unknown kind, a bad slug or a create without its fields is invalid', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const results = await expectRefUnmoved(world.a, () =>
      Promise.all([
        core.call('wiki_edit', { ...PAGE, base: null, summary: 's'.repeat(201) }, terminal(ctx)),
        core.call('wiki_edit', { ...PAGE, base: null, kind: 'pitfall' }, terminal(ctx)),
        core.call('wiki_edit', { ...PAGE, base: null, slug: 'Not A Slug' }, terminal(ctx)),
        core.call('wiki_edit', { slug: 'missing-fields', base: null, body: 'text\n' }, terminal(ctx)),
      ]),
    );

    expect(results.map((r) => (r.ok ? 'ok' : Object.keys(r.error.details.fields as object)))).toEqual([
      ['summary'],
      ['kind'],
      ['slug'],
      ['title', 'kind', 'summary'],
    ]);
  });
});

describe('the wiki is for people only', () => {
  test('wiki show and wiki list under an agent marker, or from MCP, give HUMAN_ONLY; wiki edit needs a terminal', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, terminal(ctx), { ...PAGE, base: null });
    const marked = { ...terminal(ctx), evidence: { agentMarkers: ['CLAUDE_CODE_CHILD_SESSION'] } };
    const noTty = { ...terminal(ctx), tty: false };

    const results = await expectRefUnmoved(world.a, () =>
      Promise.all([
        core.call('wiki_show', { slug: PAGE.slug }, marked),
        core.call('wiki_list', {}, marked),
        core.call('wiki_show', { slug: PAGE.slug }, ctx),
        core.call('wiki_list', {}, ctx),
        core.call('wiki_edit', { slug: PAGE.slug, base: null, body: 'x' }, noTty),
        core.call('wiki_edit', { slug: PAGE.slug, base: null, body: 'x' }, ctx),
        core.call('wiki_show', { slug: PAGE.slug }, noTty),
      ]),
    );

    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'HUMAN_ONLY',
      'HUMAN_ONLY',
      'HUMAN_ONLY',
      'HUMAN_ONLY',
      'HUMAN_ONLY',
      'HUMAN_ONLY',
      'ok',
    ]);
    for (const r of results) if (!r.ok) expect(r.error.message).not.toMatch(/CLAUDE_CODE_CHILD_SESSION/);
    expect(core.ops.filter((op) => op.mcp && /wiki|quarantine/.test(op.name))).toEqual([]);
  });
});

/** Clone b takes clone a's tracker as its own: from here the two write apart until they fold. */
async function bothClones(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

const T1 = new Date(T0.getTime() + 60_000);
const T2 = new Date(T0.getTime() + 120_000);
const T3 = new Date(T0.getTime() + 180_000);

/** A page record as a Wiki Maintainer run would write it (the chore write path is another slice). */
function pageRecord(fields: { body: string; sources: string[]; updated_at: Date; title?: string }): string {
  return [
    '---',
    `slug: "${PAGE.slug}"`,
    `title: ${JSON.stringify(fields.title ?? PAGE.title)}`,
    'kind: "failure"',
    `summary: ${JSON.stringify(PAGE.summary)}`,
    `sources: ${JSON.stringify(fields.sources)}`,
    `generated: "${fields.updated_at.toISOString()}"`,
    'verified: null',
    `updated_at: "${fields.updated_at.toISOString()}"`,
    '---',
    fields.body,
  ].join('\n');
}

const PAGE_FILE = `knowledge/wiki/pages/${PAGE.slug}.md`;
const LINES = 'Bind to port 0.\nRead the port back.\nPass it to the client.\n';

async function show(core: Core, ctx: CallContext, slug = PAGE.slug) {
  const shown = await core.call('wiki_show', { slug }, ctx);
  if (!shown.ok) throw new Error(`wiki_show failed: ${JSON.stringify(shown.error)}`);
  return shown.result;
}

describe('wiki folds across two clones', () => {
  test('overlapping hunks: the later body is kept, the other is set aside with its sources, and the page reads as conflicted on both clones', async ({
    world,
    grimoire,
  }) => {
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T0 }) });
    await bothClones(world);
    const aliceSide = LINES.replace('Read the port back.', 'Read the port back from the server log.');
    const bobSide = LINES.replace('Read the port back.', 'Ask the OS for the port.');
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: aliceSide, sources: ['at-aaaaaa', 'at-bbbbbb'], updated_at: T1 }) });
    await commitToTracker(world.b, { [PAGE_FILE]: pageRecord({ body: bobSide, sources: ['at-aaaaaa', 'at-cccccc'], updated_at: T2 }) });
    await fetchTrackerFrom(world.a, world.b);
    await fetchTrackerFrom(world.b, world.a);
    const alice = terminal(grimoire.ctx);
    const bob = terminal(agentContext(world.b));

    const [onA, onB] = await Promise.all([show(grimoire.core, alice), show(grimoire.core, bob)]);
    const listed = await grimoire.core.call('wiki_list', {}, alice);

    expect(onA).toMatchObject({
      body: bobSide,
      sources: ['at-aaaaaa', 'at-cccccc'],
      updated_at: T2.toISOString(),
      conflicted: true,
      sides: [{ id: expect.stringMatching(/^[0-9a-f]{64}$/), fields: ['body'], body: aliceSide, sources: ['at-aaaaaa', 'at-bbbbbb'], at: T1.toISOString() }],
    });
    expect(onB).toEqual(onA);
    expect(listed.ok && listed.result.pages.map((page) => page.conflicted)).toEqual([true]);
  });

  test('bodies that merge cleanly take the union of sources, and the page is not conflicted', async ({ world, grimoire }) => {
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T0 }) });
    await bothClones(world);
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: `Start a fresh server.\n${LINES}`, sources: ['at-aaaaaa', 'at-bbbbbb'], updated_at: T1 }) });
    await commitToTracker(world.b, { [PAGE_FILE]: pageRecord({ body: `${LINES}Close it after.\n`, sources: ['at-cccccc', 'at-aaaaaa'], updated_at: T2 }) });
    await fetchTrackerFrom(world.a, world.b);

    const shown = await show(grimoire.core, terminal(grimoire.ctx));

    expect(shown).toMatchObject({
      body: `Start a fresh server.\n${LINES}Close it after.\n`,
      sources: ['at-aaaaaa', 'at-bbbbbb', 'at-cccccc'],
      conflicted: false,
      sides: [],
    });
  });

  test('a fold regenerates the index and the log from both sides, never merging them as text', async ({ world, grimoire }) => {
    const created = await edit(grimoire.core, terminal(grimoire.ctx), { ...PAGE, base: null, body: LINES });
    await bothClones(world);
    await edit(grimoire.makeCore({ clock: () => T1 }), terminal(grimoire.ctx), {
      slug: PAGE.slug,
      base: created.base,
      body: LINES.replace('Read the port back.', 'Read the port back from the log.'),
    });
    await edit(grimoire.makeCore({ clock: () => T2 }), terminal(agentContext(world.b)), {
      slug: PAGE.slug,
      base: created.base,
      body: LINES.replace('Read the port back.', 'Ask the OS for the port.'),
    });
    await fetchTrackerFrom(world.a, world.b);
    const store = await openTracker(world.a.dir);
    try {
      await store.fold({ author: { ...world.a.identity }, actor: { kind: 'human', client: 'cli', nonce: 'fold' } });
    } finally {
      await store.close();
    }

    const tip = (await trackerTip(world.a))!;
    // The set-aside side, as the fold committed it: named by the sha256 of its bytes, under the page's slug.
    const conflicts = (await world.a.git(['ls-tree', '-r', '--name-only', tip, 'knowledge/wiki/conflicts/'])).split('\n');
    expect(conflicts).toEqual([expect.stringMatching(/^knowledge\/wiki\/conflicts\/flaky-port-binding\/[0-9a-f]{64}\.md$/)]);
    const side = await trackerFile(world.a, tip, conflicts[0]!);
    expect(conflicts[0]).toBe(`knowledge/wiki/conflicts/flaky-port-binding/${createHash('sha256').update(side).digest('hex')}.md`);
    expect(side).toBe(
      [
        '---',
        'slug: "flaky-port-binding"',
        'fields: ["body"]',
        'sources: []',
        `at: "${T1.toISOString()}"`,
        '---',
        'Bind to port 0.',
        'Read the port back from the log.',
        'Pass it to the client.',
        '',
      ].join('\n'),
    );
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/index.md')).toContain(
      `- [Flaky port binding](pages/flaky-port-binding.md) (failure, conflicted): ${PAGE.summary}`,
    );
    expect((await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).split('\n').filter((line) => line.startsWith('- '))).toEqual([
      `- ${T0.toISOString()}: alice@example.com created [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
      `- ${T1.toISOString()}: alice@example.com updated [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
      `- ${T2.toISOString()}: bob@example.com updated [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit)`,
    ]);
  });

  test('a reconciling edit clears the conflicted mark, records the side it resolved, and keeps both sides’ sources', async ({
    world,
    grimoire,
  }) => {
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T0 }) });
    await bothClones(world);
    const aliceSide = LINES.replace('Read the port back.', 'Read the port back from the server log.');
    const bobSide = LINES.replace('Read the port back.', 'Ask the OS for the port.');
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: aliceSide, sources: ['at-aaaaaa', 'at-bbbbbb'], updated_at: T1 }) });
    await commitToTracker(world.b, { [PAGE_FILE]: pageRecord({ body: bobSide, sources: ['at-aaaaaa', 'at-cccccc'], updated_at: T2 }) });
    await fetchTrackerFrom(world.a, world.b);
    const alice = terminal(grimoire.ctx);
    const conflicted = await show(grimoire.core, alice);
    const side = conflicted.sides[0]!.id;
    const reconciled = LINES.replace('Read the port back.', 'Ask the OS for the port, or read it from the server log.');

    const result = await edit(grimoire.makeCore({ clock: () => T3 }), alice, { slug: PAGE.slug, base: conflicted.base, body: reconciled, resolves: [side] });

    expect(result).toMatchObject({ created: false, changed: true, resolved: [side] });
    const shown = await show(grimoire.core, alice);
    expect(shown).toMatchObject({ body: reconciled, conflicted: false, sides: [], sources: ['at-aaaaaa', 'at-bbbbbb', 'at-cccccc'], verified: T3.toISOString() });
    const tip = (await trackerTip(world.a))!;
    expect((await world.a.git(['rev-list', '--parents', '-n', '1', tip])).split(' ')).toHaveLength(3);
    const files = (await world.a.git(['ls-tree', '-r', '--name-only', tip])).split('\n');
    expect(files.filter((file) => file.startsWith('knowledge/wiki/conflicts/'))).toEqual([]);
    const records = await Promise.all(
      files.filter((file) => file.startsWith('knowledge/wiki/edits/')).map((file) => trackerFile(world.a, tip, file)),
    );
    expect(records).toEqual([expect.stringContaining(`resolved: ["${side}"]`)]);
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).toContain(
      `- ${T3.toISOString()}: alice@example.com updated [flaky-port-binding](pages/flaky-port-binding.md) (human wiki edit, resolving 1 conflict)`,
    );
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/index.md')).toContain('(failure): ');
  });

  test('a reconciling edit measures the shrink guard against the larger side', async ({ world, grimoire }) => {
    const filler = `${'x'.repeat(99)}\n`.repeat(20); // 2,000 characters
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: `${filler}middle\n${filler}`, sources: [], updated_at: T0 }) });
    await bothClones(world);
    const longSide = `${filler}${'y'.repeat(2_999)}\n${filler}`; // 7,000 characters
    const shortSide = `${filler}short\n${filler}`; // 4,006 characters
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: longSide, sources: [], updated_at: T1 }) });
    await commitToTracker(world.b, { [PAGE_FILE]: pageRecord({ body: shortSide, sources: [], updated_at: T2 }) });
    await fetchTrackerFrom(world.a, world.b);
    const alice = terminal(grimoire.ctx);
    const conflicted = await show(grimoire.core, alice);
    expect(conflicted.body).toBe(shortSide);
    const resolves = conflicted.sides.map((side) => side.id);

    const shrunk = await expectRefUnmoved(world.a, () =>
      grimoire.core.call('wiki_edit', { slug: PAGE.slug, base: conflicted.base, body: `${shortSide}${'z'.repeat(1_000)}\n`, resolves }, alice),
    );
    const kept = await grimoire.core.call('wiki_edit', { slug: PAGE.slug, base: conflicted.base, body: `${filler}${'z'.repeat(1_250)}\n${filler}`, resolves }, alice);

    expect(shrunk).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { body: expect.stringContaining('7,000') } } } });
    expect(kept).toMatchObject({ ok: true, result: { resolved: resolves } });
  });
});

describe('sync after a human knowledge edit', () => {
  test('a wiki edit and a quarantine each ask for the automatic sync of the commit they made; an edit that changes nothing does not', async ({
    world,
    grimoire,
  }) => {
    const asked: string[] = [];
    const core = grimoire.makeCore({ autoSync: ({ tip }) => void asked.push(tip) });
    const human = terminal(grimoire.ctx);

    const created = await edit(core, human, { ...PAGE, base: null });
    const afterEdit = await trackerTip(world.a);
    await edit(core, human, { slug: PAGE.slug, base: created.base, body: PAGE.body });
    await core.call('quarantine', { page: PAGE.slug, reason: 'suspicious' }, human);
    const afterMark = await trackerTip(world.a);
    await core.call('unquarantine', { page: PAGE.slug }, human);
    const afterClear = await trackerTip(world.a);
    await core.close();

    expect(asked).toEqual([afterEdit, afterMark, afterClear]);
  });
});

describe('what a newer release wrote', () => {
  test('an edit keeps page keys this release doesn’t know, and never rewrites an index a newer release generated', async ({
    world,
    grimoire,
  }) => {
    const newerIndex = '---\ngenerated-by: "99.0.0"\n---\n# A newer index\n';
    const record = pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T0 }).replace('---\nBind', 'confidence: 0.8\n---\nBind');
    await commitToTracker(world.a, { [PAGE_FILE]: record, 'knowledge/wiki/index.md': newerIndex });
    const human = terminal(grimoire.ctx);
    const shown = await show(grimoire.core, human);

    await edit(grimoire.core, human, { slug: PAGE.slug, base: shown.base, body: `${LINES}Close it after.\n` });

    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, PAGE_FILE)).toContain(`updated_at: "${T0.toISOString()}"\nconfidence: 0.8\n---\n`);
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/index.md')).toBe(newerIndex);
    expect(await trackerFile(world.a, tip, 'knowledge/wiki/log.md')).toContain('alice@example.com updated');
  });
});

describe('what a newer release wrote, across two clones', () => {
  test('a fold keeps page keys this release doesn’t know and an index a newer release generated, in either fold order', async ({
    world,
    grimoire,
  }) => {
    await commitToTracker(world.a, { [PAGE_FILE]: pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T0 }) });
    await bothClones(world);
    const newerIndex = '---\ngenerated-by: "99.0.0"\n---\n# A newer index\n';
    // Clone a runs a newer release: it writes a page key this release doesn't know, and its own index.
    await commitToTracker(world.a, {
      [PAGE_FILE]: pageRecord({ body: LINES, sources: ['at-aaaaaa'], updated_at: T1 }).replace('---\nBind', 'confidence: 0.8\n---\nBind'),
      'knowledge/wiki/index.md': newerIndex,
    });
    // Clone b, on this release, edits the page's body.
    const bob = terminal(agentContext(world.b));
    const onB = await show(grimoire.core, bob);
    await edit(grimoire.makeCore({ clock: () => T2 }), bob, { slug: PAGE.slug, base: onB.base, body: `${LINES}Close it after.\n` });
    await fetchTrackerFrom(world.a, world.b);
    await fetchTrackerFrom(world.b, world.a);

    for (const [checkout, identity] of [
      [world.a, world.a.identity],
      [world.b, world.b.identity],
    ] as const) {
      const store = await openTracker(checkout.dir);
      try {
        await store.fold({ author: { ...identity }, actor: { kind: 'human', client: 'cli', nonce: 'fold' } });
      } finally {
        await store.close();
      }
    }

    const [tipA, tipB] = [(await trackerTip(world.a))!, (await trackerTip(world.b))!];
    expect(await world.a.git(['rev-parse', `${tipA}^{tree}`])).toBe(await world.b.git(['rev-parse', `${tipB}^{tree}`]));
    const page = await trackerFile(world.a, tipA, PAGE_FILE);
    expect(page).toContain(`\nconfidence: 0.8\n---\n${LINES}Close it after.\n`);
    expect(await trackerFile(world.a, tipA, 'knowledge/wiki/index.md')).toBe(newerIndex);
    expect(await trackerFile(world.a, tipA, 'knowledge/wiki/log.md')).toContain('bob@example.com updated');
  });
});

describe('never rolled back', () => {
  test('rebasing, resetting or abandoning a code branch leaves every page unchanged', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, terminal(ctx), { ...PAGE, base: null });
    const tracker = await trackerTip(world.a);
    const before = await core.call('wiki_list', {}, terminal(ctx));
    const main = await world.a.git(['rev-parse', '--abbrev-ref', 'HEAD']);

    await world.a.git(['switch', '--quiet', '-c', 'feature']);
    await world.a.commitFile('src/app.txt', 'feature work\n');
    await world.a.git(['switch', '--quiet', main]);
    await world.a.commitFile('src/other.txt', 'main work\n');
    await world.a.git(['switch', '--quiet', 'feature']);
    await world.a.git(['rebase', '--quiet', main]);
    await world.a.git(['reset', '--quiet', '--hard', 'HEAD~1']);
    await world.a.git(['switch', '--quiet', main]);
    await world.a.git(['branch', '--quiet', '-D', 'feature']);
    await world.a.git(['gc', '--quiet', '--prune=now']);

    expect(await trackerTip(world.a)).toBe(tracker);
    expect(await core.call('wiki_list', {}, terminal(ctx))).toEqual(before);
    expect(await show(core, terminal(ctx))).toMatchObject({ body: PAGE.body, title: PAGE.title });
  });
});

describe('page quarantine', () => {
  test('quarantining a page records a mark, and lifting it records a clear naming that mark; the page is never edited', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const created = await edit(core, terminal(ctx), { ...PAGE, base: null });
    const before = (await trackerTip(world.a))!;

    const marked = await core.call('quarantine', { page: PAGE.slug, reason: 'cites a poisoned trace' }, terminal(ctx));
    const markTip = (await trackerTip(world.a))!;
    const listedWhileMarked = await core.call('wiki_list', {}, terminal(ctx));
    const again = await expectRefUnmoved(world.a, () => core.call('quarantine', { page: PAGE.slug, reason: 'twice' }, terminal(ctx)));
    const cleared = await core.call('unquarantine', { page: PAGE.slug, reason: 'trace was fine' }, terminal(ctx));
    const clearTip = (await trackerTip(world.a))!;
    const shown = await core.call('wiki_show', { slug: PAGE.slug }, terminal(ctx));

    expect(marked).toEqual({ ok: true, result: { page: PAGE.slug, quarantined: true, changed: true, record: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(again).toEqual({ ok: true, result: { page: PAGE.slug, quarantined: true, changed: false } });
    expect(listedWhileMarked.ok && listedWhileMarked.result.pages[0]!.quarantined).toBe(true);
    expect(cleared).toEqual({ ok: true, result: { page: PAGE.slug, quarantined: false, changed: true, record: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(shown.ok && [shown.result.quarantined, shown.result.base]).toEqual([false, created.base]);
    const markId = marked.ok ? marked.result.record! : '';
    const clearId = cleared.ok ? cleared.result.record! : '';
    // Ledger records (spec §18 record kinds: quarantine mark and clear), in the skill ledger's shape.
    expect(await world.a.git(['diff-tree', '-r', '--name-only', before, markTip])).toBe(`knowledge/ledger/${markId}.md`);
    expect(await world.a.git(['diff-tree', '-r', '--name-only', markTip, clearTip])).toBe(`knowledge/ledger/${clearId}.md`);
    const mark = await trackerFile(world.a, markTip, `knowledge/ledger/${markId}.md`);
    expect(mark).toBe(
      [
        '---',
        'kind: "quarantine-mark"',
        'target: {"page":"flaky-port-binding"}',
        'clears: []',
        'reason: "cites a poisoned trace"',
        `from: "${created.base}"`,
        `to: "${created.base}"`,
        `saw: ["${created.base}"]`,
        'basis: "human review"',
        'surface: "cli"',
        'actor: {"person":"alice@example.com","kind":"human","client":"cli","nonce":"nonce-1"}',
        'by: "alice@example.com"',
        `at: "${T0.toISOString()}"`,
        '---',
        '',
      ].join('\n'),
    );
    expect(createHash('sha256').update(mark).digest('hex')).toBe(markId);
    expect(await trackerFile(world.a, clearTip, `knowledge/ledger/${clearId}.md`)).toContain(`kind: "quarantine-clear"\ntarget: {"page":"flaky-port-binding"}\nclears: ["${markId}"]\nreason: "trace was fine"\n`);
    expect(await world.a.git(['log', '-1', '--format=%s', markTip])).toBe('grimoire: quarantine');
  });

  test('the ledger’s other records, and a file not named by the sha256 of its bytes, quarantine nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, terminal(ctx), { ...PAGE, base: null });
    const skillDecision = '---\nkind: "accept"\nskill: "flaky-ports"\nproposal: "pr-1"\nfrom: null\nto: "abc"\nafter: []\nsaw: []\nbasis: "human review"\nsurface: "cli"\nactor: {}\nby: "alice@example.com"\nclone: ""\nat: "2026-01-01T00:00:00.000Z"\n---\n';
    const forged = `---\nkind: "quarantine-mark"\ntarget: {"page":"${PAGE.slug}"}\nclears: []\nreason: "hand-written"\nfrom: null\nto: null\nsaw: []\nbasis: "human review"\nsurface: "cli"\nactor: {}\nby: "mallory@example.com"\nat: "2026-01-01T00:00:00.000Z"\n---\n`;
    await commitToTracker(world.a, {
      [`knowledge/ledger/${createHash('sha256').update(skillDecision).digest('hex')}.md`]: skillDecision,
      [`knowledge/ledger/${'0'.repeat(64)}.md`]: forged,
    });

    const listed = await core.call('wiki_list', {}, terminal(ctx));
    const marked = await core.call('quarantine', { page: PAGE.slug, reason: 'cites a poisoned trace' }, terminal(ctx));

    expect(listed.ok && listed.result.pages.map((page) => page.quarantined)).toEqual([false]);
    expect(marked).toMatchObject({ ok: true, result: { quarantined: true, changed: true } });
  });

  test('quarantine is human-only, needs a reason and an existing page', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, terminal(ctx), { ...PAGE, base: null });

    const results = await expectRefUnmoved(world.a, () =>
      Promise.all([
        core.call('quarantine', { page: PAGE.slug, reason: 'x' }, ctx),
        core.call('unquarantine', { page: PAGE.slug }, ctx),
        core.call('quarantine', { page: PAGE.slug, reason: '  ' }, terminal(ctx)),
        core.call('quarantine', { page: 'no-such-page', reason: 'x' }, terminal(ctx)),
      ]),
    );

    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['HUMAN_ONLY', 'HUMAN_ONLY', 'INVALID', 'NOT_FOUND']);
  });
});
