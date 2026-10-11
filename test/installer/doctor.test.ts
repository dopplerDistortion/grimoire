// Seam 1 for `doctor` (spec Testing Decisions; §12 doctor, §4, §11): the
// installer's runDoctor driven directly, in process, against temporary clones
// with a bare remote. Each test injects one defect the way another writer or a
// person would leave it, and asserts what the report says about it. The CLI
// over a checkout `init` installed is seam 3 (health.test.ts).
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { GitWorld } from '#harness';
import type { CallContext } from '../../src/core';
import { runDoctor, type DoctorReport } from '../../src/installer/doctor';
import type { Finding } from '../../src/installer/health';
import { agentContext, commitToTracker, coreTest as test, fetchTracker, issuePath, pushTracker, T0 } from '../core/support';

async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(`call failed: ${JSON.stringify(settled.error)}`);
  return settled.result;
}

/** The findings of one kind. */
function found(report: DoctorReport, kind: string): Finding[] {
  return report.findings.filter((finding) => finding.kind === kind);
}

const T1 = new Date(T0.getTime() + 60_000);

/** A remote pre-receive hook that rejects every push the way GitHub's rulesets do. */
const REJECTING_HOOK = ['#!/bin/sh', 'echo "GH013: Repository rule violations found for refs/heads/grimoire/tracker." >&2', 'exit 1', ''].join('\n');

/** Both clones on one tracker: a pushes it, b fetches it. */
async function shared(world: GitWorld): Promise<{ alice: CallContext; bob: CallContext }> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  return { alice: agentContext(world.a), bob: agentContext(world.b) };
}

/** b publishes its tracker and a fetches it: a's local and remote-tracking tips diverge. */
async function bobPublishes(world: GitWorld): Promise<void> {
  await pushTracker(world.b);
  await fetchTracker(world.a);
}

/** A tracker file's text at the local tip (git output, so without its last line end). */
function trackerText(world: GitWorld, file: string): Promise<string> {
  return world.a.git(['cat-file', 'blob', `refs/grimoire/tracker:${file}`]);
}

describe('store checks', () => {
  test('a record the canonical serializer did not write is reported non-canonical, by its path', async ({ world, grimoire }) => {
    const { id } = await ok(grimoire.core.call('create', { title: 'Tidy the records' }, grimoire.ctx));
    const file = issuePath(id);
    const text = await trackerText(world, file);
    // A hand edit: the title moved below the status, and CRLF line ends.
    const lines = text.split('\n');
    const title = lines.findIndex((line) => line.startsWith('title: '));
    [lines[title], lines[title + 1]] = [lines[title + 1]!, lines[title]!];
    await commitToTracker(world.a, { [file]: lines.join('\r\n') });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'non-canonical')).toEqual([
      expect.objectContaining({ section: 'store', severity: 'error', subject: file, fixable: false }),
    ]);
    expect(report.ok).toBe(false);
  });

  test('a record that doesn’t parse is reported unparsable, and the checks that need the merged view say they couldn’t read it', async ({ world, grimoire }) => {
    const { id } = await ok(grimoire.core.call('create', { title: 'Broken' }, grimoire.ctx));
    await commitToTracker(world.a, { [issuePath(id)]: 'not a record\n' });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'unparsable')).toEqual([expect.objectContaining({ subject: issuePath(id), severity: 'error' })]);
    expect(report.checks.find((run) => run.check === 'store.relations')).toMatchObject({ status: 'skipped', why: expect.stringContaining('merged view') });
  });

  test('duplicate ids: a collision nobody resolved yet, and a record filed under another id', async ({ world, grimoire }) => {
    const alice = grimoire.makeCore({ randomIdSuffix: () => 'abcde' });
    const bob = grimoire.makeCore({ randomIdSuffix: () => 'abcde', clock: () => T1 });
    const { alice: a, bob: b } = await shared(world);
    await ok(alice.call('create', { title: 'Minted on a' }, a));
    await ok(bob.call('create', { title: 'Minted on b' }, b));
    await bobPublishes(world);
    const { id: other } = await ok(grimoire.core.call('create', { title: 'Other' }, grimoire.ctx));
    const text = await trackerText(world, issuePath(other));
    await commitToTracker(world.a, { [issuePath('gr-zzzzz')]: `${text}\n` });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'duplicate-id').map((finding) => finding.subject).sort()).toEqual(['gr-abcde', issuePath('gr-zzzzz')].sort());
  });

  test('dangling references and relation cycles are reported by issue', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id: first } = await ok(core.call('create', { title: 'First' }, ctx));
    const { id: second } = await ok(core.call('create', { title: 'Second', blocked_by: [first] }, ctx));
    // Another writer: the first now waits for the second, and for an issue no clone has.
    const text = await trackerText(world, issuePath(first));
    const blockers = [second, 'gr-yyyyy'].sort();
    await commitToTracker(world.a, { [issuePath(first)]: `${text.replace('blocked_by: []', `blocked_by: ${JSON.stringify(blockers)}`)}\n` });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'dangling-reference')).toEqual([
      expect.objectContaining({ subject: first, details: expect.objectContaining({ field: 'blocked_by', target: 'gr-yyyyy' }) }),
    ]);
    expect(found(report, 'cycle')).toEqual([expect.objectContaining({ details: expect.objectContaining({ path: expect.arrayContaining([first, second]) }) })]);
  });

  test('fold conflicts and double open attempts in the merged view are reported', async ({ world, grimoire }) => {
    const bobCore = grimoire.makeCore({ clock: () => T1 });
    const { alice, bob } = await shared(world);
    const { id: titled } = await ok(grimoire.core.call('create', { title: 'Shared' }, alice));
    const { id: contested } = await ok(grimoire.core.call('create', { title: 'Contested' }, alice));
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await ok(grimoire.core.call('update', { id: titled, title: 'Alice’s title' }, alice));
    await ok(bobCore.call('update', { id: titled, title: 'Bob’s title' }, bob));
    await ok(grimoire.core.call('claim', { id: contested }, alice));
    await ok(bobCore.call('claim', { id: contested }, bob));
    await bobPublishes(world);

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'conflict')).toEqual([expect.objectContaining({ subject: titled, details: expect.objectContaining({ fields: ['title'] }) })]);
    expect(found(report, 'double-open-attempts')).toEqual([expect.objectContaining({ subject: contested })]);
  });

  test('an edit to a write-once file (a comment) is reported with the commit that made it', async ({ world, grimoire }) => {
    const { id } = await ok(grimoire.core.call('create', { title: 'Commented' }, grimoire.ctx));
    await ok(grimoire.core.call('comment', { id, body: 'first words' }, grimoire.ctx));
    const files = (await world.a.git(['ls-tree', '-r', '--name-only', 'refs/grimoire/tracker'])).split('\n');
    const comment = files.find((file) => file.includes('/comments/'))!;
    const text = await trackerText(world, comment);
    const edit = await commitToTracker(world.a, { [comment]: text.replace('first words', 'other words') });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'write-once-edit')).toEqual([expect.objectContaining({ subject: comment, details: expect.objectContaining({ commit: edit }) })]);
  });

  test('a purged attempt whose files are still in the tracker is reported', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id } = await ok(core.call('create', { title: 'Purged' }, ctx));
    const { attempt } = await ok(core.call('claim', { id }, ctx));
    await commitToTracker(world.a, { [`purges/${attempt}.md`]: `---\nby: "alice@example.com"\nat: "${T0.toISOString()}"\nreason: "secret"\n---\n` });

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'purged-present')).toEqual([expect.objectContaining({ subject: attempt, severity: 'error' })]);
  });

  test('a ref lock older than ~30 s is reported as stale and fixable; a fresh one is not', async ({ world }) => {
    const refs = path.join(world.a.dir, '.git', 'refs', 'grimoire');
    await mkdir(refs, { recursive: true });
    const stale = path.join(refs, 'tracker.lock');
    await writeFile(stale, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(stale, old, old);
    const remoteRefs = path.join(world.a.dir, '.git', 'refs', 'remotes', 'origin', 'grimoire');
    await mkdir(remoteRefs, { recursive: true });
    await writeFile(path.join(remoteRefs, 'tracker.lock'), '');

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'stale-ref-lock')).toEqual([expect.objectContaining({ subject: 'refs/grimoire/tracker.lock', fixable: true })]);
  });

  test('sync: commits the remote lacks, commits this clone lacks, and a rejected push with its class and client', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await ok(core.call('create', { title: 'Only here' }, ctx));
    await ok(core.call('create', { title: 'Also only here' }, ctx));
    await ok(core.call('create', { title: 'Only there' }, agentContext(world.b)));
    await pushTracker(world.b);
    await fetchTracker(world.a);
    await writeFile(path.join(world.remote, 'hooks', 'pre-receive'), REJECTING_HOOK, { mode: 0o755 });
    await core.call('sync', {}, ctx);

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'sync-ahead')).toEqual([expect.objectContaining({ details: expect.objectContaining({ ahead: 3 }) })]);
    expect(found(report, 'sync-behind')).toEqual([]);
    expect(found(report, 'sync-rejected')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('GH013'),
        details: expect.objectContaining({ class: 'rejected', client: 'claude-code' }),
      }),
    ]);
  });

  test('a clone behind its remote is told so', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await ok(grimoire.core.call('create', { title: 'Only there' }, agentContext(world.b)));
    await pushTracker(world.b);
    await fetchTracker(world.a);

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'sync-behind')).toEqual([expect.objectContaining({ details: expect.objectContaining({ behind: 1, remote: 'origin' }) })]);
    expect(found(report, 'sync-ahead')).toEqual([]);
  });

  test('commits grimoire did not make are foreign; one that touched knowledge records is reported as such', async ({ world, grimoire }) => {
    await ok(grimoire.core.call('create', { title: 'A grimoire commit' }, grimoire.ctx));
    const foreign = await commitToTracker(world.a, { 'notes.txt': 'hello\n' }, 'a hand-made commit');
    const knowledge = await commitToTracker(world.a, { 'knowledge/ledger/x.md': 'text\n' }, 'slipped in a ledger record');

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'foreign-commit').map((finding) => finding.subject)).toEqual([foreign]);
    expect(found(report, 'knowledge-without-trailers')).toEqual([expect.objectContaining({ subject: knowledge, severity: 'error' })]);
  });

  test('a ref that blocks the tracker ref by name (a directory/file conflict) is reported', async ({ world }) => {
    const head = await world.a.git(['rev-parse', 'HEAD']);
    await world.a.git(['update-ref', 'refs/remotes/origin/grimoire', head]);

    const report = await runDoctor({ root: world.a.dir });

    expect(found(report, 'df-ref-conflict')).toEqual([expect.objectContaining({ subject: 'refs/remotes/origin/grimoire' })]);
  });

  test('a healthy tracker gives a clean store section', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const { id } = await ok(core.call('create', { title: 'Healthy' }, ctx));
    await ok(core.call('comment', { id, body: 'fine' }, ctx));
    const { attempt } = await ok(core.call('claim', { id }, ctx));
    await ok(core.call('close', { id, attempt, reason: 'done', debrief: { asked: 'a', tried: 'b', failed: 'none', worked: 'c', next: 'none' } }, ctx));

    const report = await runDoctor({ root: world.a.dir });

    expect(report.findings.filter((finding) => finding.section === 'store' && finding.kind !== 'sync-ahead')).toEqual([]);
  });
});
