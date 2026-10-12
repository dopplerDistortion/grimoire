// Purge (spec §3 Delete and purge, §4 fold dominance, §14 Purging one session
// record, §7): a person removes a trace, or one open attempt's session record,
// as far as git allows. Seam 1: the core against real git in temp repos.
import path from 'node:path';
import { utimes } from 'node:fs/promises';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { runUpkeep, type PartRun } from '../../src/upkeep';
import { excerptSweep, type SweepOptions } from '../../src/upkeep/sweep';
import type { GitWorld, Checkout } from '#harness';
import {
  agentContext,
  commitToTracker,
  coreTest,
  expectRefUnmoved,
  fetchTracker,
  pushTracker,
  T0,
  trackerFile,
  trackerTip,
  TRACKER_REF,
} from './support';
import { putPage } from './chore-support';
import { CLAUDE_SESSION, captureOf, claimed, claudeCall, created, sessionRecords, test as captureTest } from './capture-support';

const DEBRIEF = { asked: 'a', tried: 't', failed: 'none', worked: 'w', next: 'none' };
const REMOTE_TRACKER = 'refs/remotes/origin/grimoire/tracker';

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const done = await outcome;
  if (!done.ok) throw new Error(JSON.stringify(done.error));
  return done.result;
}

/** An issue with one ended attempt (closed by the agent in `ctx`): its id and the attempt's handle. */
async function endedAttempt(core: Core, ctx: CallContext, title = 'Leaky'): Promise<{ id: string; attempt: string }> {
  const { id } = await ok(core.call('create', { title }, ctx));
  const { attempt } = await ok(core.call('claim', { id }, ctx));
  await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, ctx));
  return { id, attempt };
}

const attemptPath = (id: string, attempt: string) => `attempts/${id[3]}/${id[4]}/${id}/${attempt}`;
const outcomePath = (id: string, attempt: string) => `outcomes/${id[3]}/${id[4]}/${id}/${attempt}.md`;

async function treeAt(checkout: Checkout, commit: string): Promise<string[]> {
  return (await checkout.git(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(Boolean);
}

/** Every commit the tracker ref's reflog still names. */
async function reflogCommits(checkout: Checkout): Promise<string[]> {
  return (await checkout.git(['reflog', 'show', '--format=%H', TRACKER_REF])).split('\n').filter(Boolean);
}

/** Clone b takes clone a's tracker as its own: from here the two write apart until they fold. */
async function bothClones(world: GitWorld): Promise<void> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  await world.b.git(['update-ref', TRACKER_REF, REMOTE_TRACKER]);
}

describe('purging a trace', () => {
  coreTest('removes the attempt’s directory and outcome in one commit: show and list no longer return them, and the tombstone holds by, at and reason', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    const before = (await trackerTip(world.a))!;

    const purged = await core.call('purge_trace', { attempt, reason: ' pasted a token ' }, terminal(ctx));

    expect(purged).toMatchObject({
      ok: true,
      result: {
        attempt,
        issue: id,
        purged: true,
        changed: true,
        by: 'alice@example.com',
        at: T0.toISOString(),
        reason: 'pasted a token',
        cited_by: { pages: [], proposals: [] },
        history: { pushed: false },
      },
    });
    const note = purged.ok ? purged.result.history.note : '';
    expect(note).toMatch(/never rewrites pushed history/);
    expect(await core.call('show', { ref: id }, ctx)).toMatchObject({ ok: true, result: { past_attempts: [], last_assignee: null } });
    expect(JSON.stringify(await core.call('list', { status: 'done' }, ctx))).not.toContain(attempt);
    const tip = (await trackerTip(world.a))!;
    const tree = await treeAt(world.a, tip);
    expect(tree.filter((file) => file.includes(attempt))).toEqual([`purges/${attempt}.md`]);
    expect(await trackerFile(world.a, tip, `purges/${attempt}.md`)).toBe(
      `---\nby: "alice@example.com"\nat: "${T0.toISOString()}"\nreason: "pasted a token"\n---\n`,
    );
    // One commit on top of what was there (the unpushed segment rewritten under it).
    expect(await world.a.git(['rev-list', '--count', TRACKER_REF])).toBe(await world.a.git(['rev-list', '--count', before]).then((n) => String(Number(n) + 1)));
    expect(await world.a.git(['log', '-1', '--format=%B', TRACKER_REF])).toMatch(/^Grimoire-Op: purge$/m);
    expect(await core.call('outcome_set', { attempt, verdict: 'pass', reason: 'r' }, terminal(ctx))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  coreTest('purging it again changes nothing; an open attempt, an unknown handle or a blank reason is refused, the ref unmoved', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { attempt } = await endedAttempt(core, ctx);
    await ok(core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx)));
    const { id: openId } = await ok(core.call('create', { title: 'Open' }, ctx));
    const { attempt: open } = await ok(core.call('claim', { id: openId }, ctx));

    const again = await expectRefUnmoved(world.a, () => core.call('purge_trace', { attempt, reason: 'again' }, terminal(ctx)));
    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('purge_trace', { attempt: open, reason: 'secret' }, terminal(ctx)),
      await core.call('purge_trace', { attempt: 'at-zzzzzz', reason: 'secret' }, terminal(ctx)),
      await core.call('purge_trace', { attempt, reason: '  ' }, terminal(ctx)),
    ]);

    expect(again).toMatchObject({ ok: true, result: { attempt, changed: false, reason: 'secret', history: { unpushed_rewritten: 0 } } });
    expect(refused).toMatchObject([
      { ok: false, error: { code: 'ATTEMPT_OPEN' } },
      { ok: false, error: { code: 'NOT_FOUND' } },
      { ok: false, error: { code: 'INVALID' } },
    ]);
  });

  coreTest('content never pushed is absent from the rewritten unpushed segment, and the reflog no longer names a commit that held it', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    await ok(core.call('comment', { id, body: 'after the end' }, ctx));
    const held = await world.a.git(['rev-list', TRACKER_REF, '--', attemptPath(id, attempt)]);
    expect(held).not.toBe('');

    const purged = await ok(core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx)));

    expect(purged.history).toMatchObject({ pushed: false, unpushed_rewritten: expect.any(Number) });
    expect(purged.history.unpushed_rewritten).toBeGreaterThan(0);
    expect(await world.a.git(['rev-list', TRACKER_REF, '--', attemptPath(id, attempt), outcomePath(id, attempt)])).toBe('');
    for (const commit of await reflogCommits(world.a)) {
      expect((await treeAt(world.a, commit)).some((file) => file.startsWith(`${attemptPath(id, attempt)}/`))).toBe(false);
    }
    // The rest of history is intact: same messages, same authors, the issue and its comment still there.
    expect(await core.call('show', { ref: id, comments: 'all' }, ctx)).toMatchObject({ ok: true, result: { status: 'done' } });
    expect(await world.a.git(['log', '--format=%an %s', TRACKER_REF])).toMatch(/grimoire: comment/);
  });

  coreTest('pushed history is untouched and keeps the content, and the response says so; unpushed commits since are rewritten', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    await pushTracker(world.a);
    await fetchTracker(world.a);
    const pushedTip = await world.a.git(['rev-parse', REMOTE_TRACKER]);
    await ok(core.call('comment', { id, body: 'unpushed' }, ctx));

    const purged = await ok(core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx)));

    // The unpushed comment, and the purge commit over it.
    expect(purged.history).toMatchObject({ pushed: true, unpushed_rewritten: 2 });
    expect(purged.history.note).toMatch(/Pushed history still holds it/);
    expect(await world.a.git(['rev-parse', REMOTE_TRACKER])).toBe(pushedTip);
    expect(await world.a.git(['rev-list', REMOTE_TRACKER, '--', attemptPath(id, attempt)])).not.toBe('');
    for (const commit of (await world.a.git(['rev-list', `${pushedTip}..${TRACKER_REF}`])).split('\n')) {
      expect((await treeAt(world.a, commit)).some((file) => file.startsWith(`${attemptPath(id, attempt)}/`))).toBe(false);
    }
    expect(await world.a.git(['merge-base', '--is-ancestor', pushedTip, TRACKER_REF]).then(() => true)).toBe(true);
  });

  coreTest('lists the wiki pages that cite the trace and offers a human wiki edit; the pages stay as written, their sources showing it purged', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const { attempt } = await endedAttempt(core, ctx);
    const { attempt: other } = await endedAttempt(core, ctx, 'Other');
    await putPage(world.a, world.a, 'leaky-ports', [attempt, other]);
    await putPage(world.a, world.a, 'unrelated', [other]);
    const human = terminal(ctx);
    const before = await ok(core.call('wiki_show', { slug: 'leaky-ports' }, human));

    const purged = await ok(core.call('purge_trace', { attempt, reason: 'secret' }, human));

    expect(purged.cited_by).toEqual({ pages: [{ slug: 'leaky-ports', edit: 'grimoire wiki edit leaky-ports' }], proposals: [] });
    const page = await ok(core.call('wiki_show', { slug: 'leaky-ports' }, human));
    expect(page).toMatchObject({ body: before.body, sources: [attempt, other].sort(), purged_sources: [attempt] });
    const listed = await ok(core.call('wiki_list', {}, human));
    expect(listed.pages.find((row) => row.slug === 'unrelated')).toMatchObject({ purged_sources: [] });
  });
});

describe('a purge across two clones', () => {
  coreTest('clone b still holds the attempt and folds with a later: it stays purged, and b’s reopen flip, outcome override and late session record can’t recreate it', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const { id, attempt } = await endedAttempt(core, ctx);
    await bothClones(world);
    const bob = terminal(agentContext(world.b));
    // b, which never saw the purge: a human override, a reopen (its flip) and a late session record.
    await ok(core.call('outcome_set', { attempt, verdict: 'pass', reason: 'it held' }, bob));
    await ok(core.call('reopen', { id, comment: 'not done after all' }, bob));
    await commitToTracker(world.b, { [`${attemptPath(id, attempt)}/sessions/0123456789abcdef0123456789abcdef.md`]: '---\nreach: {"at":"2026-10-11T03:20:00.000Z","ref":"7"}\n---\n' });
    // a purges and publishes.
    await ok(core.call('purge_trace', { attempt, reason: 'secret' }, terminal(ctx)));
    await pushTracker(world.a);
    await fetchTracker(world.b);

    const shown = await core.call('show', { ref: id }, bob);
    await ok(core.call('comment', { id, body: 'fold' }, bob));

    expect(shown).toMatchObject({ ok: true, result: { status: 'open', past_attempts: [] } });
    const folded = await treeAt(world.b, (await trackerTip(world.b))!);
    expect(folded.filter((file) => file.includes(attempt))).toEqual([`purges/${attempt}.md`]);
    expect(await core.call('outcome_set', { attempt, verdict: 'fail', reason: 'r' }, bob)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // And a, folding b's history in turn, stays purged too.
    await pushTracker(world.b);
    await fetchTracker(world.a);
    await ok(core.call('comment', { id, body: 'fold back' }, ctx));
    expect((await treeAt(world.a, (await trackerTip(world.a))!)).filter((file) => file.includes(attempt))).toEqual([`purges/${attempt}.md`]);
  });
});

describe('the human-only gate', () => {
  coreTest('purge from MCP, under an agent marker or without a TTY gives HUMAN_ONLY; neither op is an MCP tool', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { attempt } = await endedAttempt(core, ctx);
    const surfaces: CallContext[] = [
      ctx,
      { ...terminal(ctx), evidence: { agentMarkers: ['CLAUDE_CODE_CHILD_SESSION'] } },
      { ...terminal(ctx), tty: false },
      { ...ctx, surface: 'runner', client: { name: 'runner:claude' } },
    ];

    const refused = await expectRefUnmoved(world.a, async () => {
      const outcomes = [];
      for (const surface of surfaces) {
        outcomes.push(await core.call('purge_trace', { attempt, reason: 'secret' }, surface));
        outcomes.push(await core.call('purge_session', { attempt, key: '0123456789abcdef0123456789abcdef', reason: 'secret' }, surface));
      }
      return outcomes;
    });

    for (const outcome of refused) expect(outcome).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    const byName = Object.fromEntries(core.ops.map((op) => [op.name, op]));
    for (const name of ['purge_trace', 'purge_session']) expect(byName[name], name).toMatchObject({ kind: 'write', policy: 'human-only', mcp: false });
  });
});

/** Runs one upkeep pass of the sweep alone; returns the sweep's run. */
async function sweepNow(root: string, options: SweepOptions): Promise<PartRun> {
  const report = await runUpkeep({ root, parts: [excerptSweep(options)], force: true });
  const run = report.runs.find((r) => r.part === 'excerpt-sweep')!;
  expect(run.status, JSON.stringify(run)).toBe('ran');
  return run;
}

/** Half an hour and a bit after the fixture sessions' last steps. */
const IDLE = new Date('2026-10-11T04:00:00.000Z');

describe('purging one session record', () => {
  captureTest('the excerpt alone: the record goes, its facts stay on the tombstone, the status reads purged, and the next sweep skips that context', async ({
    world,
    grimoire,
    capture,
  }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Swept, then purged');
    const attempt = await claimed(core, grimoire.ctx, id);
    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE, sync: false });
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.body).not.toBe('');
    const key = record!.name.replace(/\.md$/, '');

    const purged = await core.call('purge_session', { attempt, key, reason: 'a secret in the excerpt' }, terminal(grimoire.ctx));

    expect(purged).toMatchObject({ ok: true, result: { attempt, issue: id, key, facts: 'kept', changed: true, reason: 'a secret in the excerpt', history: { pushed: false } } });
    expect(await sessionRecords(world.a, id, attempt)).toEqual([]);
    const tip = (await trackerTip(world.a))!;
    const tombstone = await trackerFile(world.a, tip, `purges/${attempt}/${key}.md`);
    expect(tombstone).toMatch(/^---\nby: "alice@example.com"\nat: "[^"]+"\nreason: "a secret in the excerpt"\nfacts: "kept"\n---\n---\n/);
    expect(tombstone).not.toContain(record!.body.trim().slice(0, 40));
    const trace = await captureOf(world.a, attempt);
    expect(trace.contexts).toEqual([expect.objectContaining({ key, session: CLAUDE_SESSION, excerpt: { status: 'purged', notes: [] }, facts: record!.fields.facts })]);
    expect(await world.a.git(['rev-list', TRACKER_REF, '--', `attempts/${id[3]}/${id[4]}/${id}/${attempt}/sessions/${key}.md`])).toBe('');

    // The transcript changes and the context goes idle again: the sweep skips it.
    const later = new Date(IDLE.getTime() + 120_000);
    const transcript = path.join(capture.configDir, 'projects', 'C--Users-user-proj', `${CLAUDE_SESSION}.jsonl`);
    await utimes(transcript, later, later);
    const again = await sweepNow(world.a.dir, { capture: capture.options, clock: () => later, sync: false });
    expect(again.result).toMatchObject({ attached: 0 });
    expect(await sessionRecords(world.a, id, attempt)).toEqual([]);

    // The seal skips it too: the trace keeps the context purged, with its facts.
    capture.at(later.toISOString());
    await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCall(grimoire.ctx, 'toolu_close')));
    expect(await sessionRecords(world.a, id, attempt)).toEqual([]);
    expect((await captureOf(world.a, attempt)).contexts).toEqual([expect.objectContaining({ key, excerpt: { status: 'purged', notes: [] }, facts: record!.fields.facts })]);
  });

  captureTest('with its facts: the tombstone keeps nothing, and the trace lists the context purged with no facts', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Purged whole');
    const attempt = await claimed(core, grimoire.ctx, id);
    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    const key = (await sessionRecords(world.a, id, attempt))[0]!.name.replace(/\.md$/, '');

    const purged = await core.call('purge_session', { attempt, key, reason: 'all of it', with_facts: true }, terminal(grimoire.ctx));

    // The sweep's attachment synced: pushed history keeps the record, and the response says so.
    expect(purged).toMatchObject({ ok: true, result: { key, facts: 'purged', history: { pushed: true, note: expect.stringMatching(/Pushed history still holds it/) } } });
    const tombstone = await trackerFile(world.a, (await trackerTip(world.a))!, `purges/${attempt}/${key}.md`);
    expect(tombstone).toMatch(/^---\nby: "alice@example.com"\nat: "[^"]+"\nreason: "all of it"\nfacts: "purged"\n---\n$/);
    expect((await captureOf(world.a, attempt)).contexts).toEqual([expect.objectContaining({ key, excerpt: { status: 'purged', notes: [] }, facts: 'purged', skills_read: [] })]);
  });

  captureTest('an ended attempt’s record is part of its trace: purge the trace instead; an unknown key is NOT_FOUND', async ({ world, grimoire, capture }) => {
    const { core } = capture;
    const id = await created(core, grimoire.ctx, 'Ended');
    const attempt = await claimed(core, grimoire.ctx, id);
    await sweepNow(world.a.dir, { capture: capture.options, clock: () => IDLE });
    const key = (await sessionRecords(world.a, id, attempt))[0]!.name.replace(/\.md$/, '');
    const { id: openId } = await ok(core.call('create', { title: 'Open' }, grimoire.ctx));
    const open = await claimed(core, grimoire.ctx, openId);
    await ok(core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, grimoire.ctx));

    const refused = await expectRefUnmoved(world.a, async () => [
      await core.call('purge_session', { attempt, key, reason: 'r' }, terminal(grimoire.ctx)),
      await core.call('purge_session', { attempt: open, key: 'ffffffffffffffffffffffffffffffff', reason: 'r' }, terminal(grimoire.ctx)),
      await core.call('purge_session', { attempt: open, key: 'not-hex', reason: 'r' }, terminal(grimoire.ctx)),
    ]);

    expect(refused).toMatchObject([
      { ok: false, error: { code: 'INVALID', details: { fields: { attempt: expect.stringMatching(/purge the trace/) } } } },
      { ok: false, error: { code: 'NOT_FOUND' } },
      { ok: false, error: { code: 'INVALID' } },
    ]);
  });
});
