// Seam 1 for `doctor` (spec Testing Decisions; §12 doctor, §4, §11): the
// installer's runDoctor driven directly, in process, against temporary clones
// with a bare remote. Each test injects one defect the way another writer or a
// person would leave it, and asserts what the report says about it. The CLI
// over a checkout `init` installed is seam 3 (health.test.ts).
import { createHash } from 'node:crypto';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { GitWorld } from '#harness';
import type { CallContext } from '../../src/core';
import { parseSessionRecord, serializeSessionRecord } from '../../src/capture/session-record';
import { DOCTOR_CHECKS, runDoctor, type DoctorReport } from '../../src/installer/doctor';
import type { Finding } from '../../src/installer/health';
import { openTracker } from '../../src/tracker';
import { agentContext, commitToTracker, coreTest as test, fetchTracker, fetchTrackerFrom, issuePath, pushTracker, T0 } from '../core/support';

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

const T2 = new Date(T0.getTime() + 120_000);

/** The checks about refs and sync: the runs that only look at those skip the rest. */
const REF_CHECKS = DOCTOR_CHECKS.filter((check) => ['store.ref-locks', 'store.sync', 'store.ref-names'].includes(check.name));
/** The check of each record's bytes. */
const RECORD_CHECKS = DOCTOR_CHECKS.filter((check) => check.name === 'store.records');

/** A session record as capture writes it: every key, in its order, and the excerpt as it was cut. */
const capturedSession = (text: string | null): string =>
  serializeSessionRecord({ ...parseSessionRecord(Buffer.from('---\n---\n')), client: 'claude-code', session: 's1', steps: 3, cut_at: '2026-10-12T05:00:00.000Z', text }).toString('utf8');

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

const PAGE = {
  slug: 'flaky-port-binding',
  title: 'Flaky port binding',
  kind: 'failure',
  summary: 'Tests fail when two servers race for one port.',
  body: 'Bind to port 0.\nRead the port back.\nPass it to the client.\n',
};

const NOTES = [
  '---',
  'name: release-notes',
  'description: Write a release note for a change. Use when the user asks to record a change in the notes.',
  '---',
  '# Release notes',
  '',
  'Create `changes/<slug>.md` with `kind:` and `summary:` lines.',
  '',
].join('\n');

/** Every file of the local tracker tip. */
async function trackerFiles(world: GitWorld): Promise<string[]> {
  return (await world.a.git(['ls-tree', '-r', '--name-only', 'refs/grimoire/tracker'])).split('\n');
}

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

/** Each test drives clones, a bare remote and every store check: room for a loaded machine. */
const SLOW = { timeout: 240_000 };

describe('store checks', SLOW, () => {
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

  test('the knowledge records grimoire writes are canonical: pages, wiki edits, a fold’s set-aside side, quarantine marks, skill changes and versions', async ({ world, grimoire }) => {
    const human = terminal(grimoire.ctx);
    const created = await ok(grimoire.core.call('wiki_edit', { ...PAGE, base: null }, human));
    await ok(grimoire.core.call('quarantine', { page: PAGE.slug, reason: 'cites a poisoned trace' }, human));
    await ok(grimoire.core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, human));
    // Both clones change one line of the page: the fold sets one side aside.
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', 'refs/grimoire/tracker', 'refs/remotes/origin/grimoire/tracker']);
    await ok(grimoire.makeCore({ clock: () => T1 }).call('wiki_edit', { slug: PAGE.slug, base: created.base, body: PAGE.body.replace('Read', 'Log') }, human));
    await ok(grimoire.makeCore({ clock: () => T2 }).call('wiki_edit', { slug: PAGE.slug, base: created.base, body: PAGE.body.replace('Read', 'Ask for') }, terminal(agentContext(world.b))));
    await fetchTrackerFrom(world.a, world.b);
    const store = await openTracker(world.a.dir);
    try {
      await store.fold({ author: { ...world.a.identity }, actor: { kind: 'human', client: 'cli', nonce: 'fold' } });
    } finally {
      await store.close();
    }
    const files = await trackerFiles(world);

    const report = await runDoctor({ root: world.a.dir, checks: RECORD_CHECKS });

    const kinds = ['knowledge/wiki/pages/', 'knowledge/wiki/edits/', 'knowledge/wiki/conflicts/', 'knowledge/ledger/', 'knowledge/skill-versions/'];
    expect(kinds.filter((prefix) => !files.some((file) => file.startsWith(prefix)))).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  test('hand-edited knowledge and session records are reported: a page, a ledger record and a skill version whose bytes no longer hash to their names, a skill change out of key order, a session record', async ({ world, grimoire }) => {
    const human = terminal(grimoire.ctx);
    await ok(grimoire.core.call('wiki_edit', { ...PAGE, base: null }, human));
    await ok(grimoire.core.call('quarantine', { page: PAGE.slug, reason: 'cites a poisoned trace' }, human));
    await ok(grimoire.core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, human));
    const { id } = await ok(grimoire.core.call('create', { title: 'Traced' }, grimoire.ctx));
    const { attempt } = await ok(grimoire.core.call('claim', { id }, grimoire.ctx));
    const files = await trackerFiles(world);
    const page = files.find((file) => file.startsWith('knowledge/wiki/pages/'))!;
    const ledgerFiles = files.filter((file) => file.startsWith('knowledge/ledger/'));
    const ledgerTexts = await Promise.all(ledgerFiles.map((file) => trackerText(world, file)));
    const ledger = ledgerFiles[ledgerTexts.findIndex((text) => text.includes('cites a poisoned trace'))]!;
    const version = files.find((file) => file.startsWith('knowledge/skill-versions/'))!;
    const start = files.find((file) => file.endsWith(`/${attempt}/start.md`))!;
    const session = start.replace(/start\.md$/, 'sessions/s1.md');
    const reordered = start.replace(/start\.md$/, 'sessions/s2.md');
    // A person's edits: a key moved in the page; another reason in the mark; a changed line in the skill.
    const swap = (lines: string[], key: string) => {
      const at = lines.findIndex((line) => line.startsWith(`${key}: `));
      [lines[at], lines[at + 1]] = [lines[at + 1]!, lines[at]!];
      return `${lines.join('\n')}\n`;
    };
    // A skill change written by hand with its keys out of order, under the sha256 of its own bytes.
    const skillChange = swap(ledgerTexts.find((text) => text.includes('kind: "edit"'))!.split('\n'), 'skill');
    const forged = `knowledge/ledger/${createHash('sha256').update(skillChange).digest('hex')}.md`;
    await commitToTracker(world.a, {
      [page]: swap((await trackerText(world, page)).split('\n'), 'title'),
      [forged]: skillChange,
      [ledger]: `${(await trackerText(world, ledger)).replace('cites a poisoned trace', 'poisoned')}\n`,
      [version]: `${(await trackerText(world, version)).replace('Release notes', 'Notes')}\n`,
      // Capture writes session records in the shared line format: a bare word is no JSON value.
      [session]: '---\nclient: claude-code\nsteps: 3\n---\n',
      // Every line canonical, but two of capture's keys out of its order.
      [reordered]: swap(capturedSession(null).split('\n'), 'steps').slice(0, -1),
    });

    const report = await runDoctor({ root: world.a.dir, checks: RECORD_CHECKS });

    const bad = report.findings.filter((finding) => finding.kind === 'non-canonical' || finding.kind === 'unparsable');
    expect(bad.map((finding) => finding.subject).sort()).toEqual([forged, ledger, page, reordered, session, version].sort());
    expect(bad.find((finding) => finding.subject === reordered)?.message).toContain('canonical serializer');
    expect(bad.find((finding) => finding.subject === ledger)?.message).toContain('sha256');
    expect(bad.find((finding) => finding.subject === forged)?.message).toContain('canonical serializer');
  });

  test('a body is its verbatim bytes: CR line ends in an issue body, a page body or a session excerpt are canonical, in a frontmatter line they are not', async ({ world, grimoire }) => {
    const human = terminal(grimoire.ctx);
    const { id } = await ok(grimoire.core.call('create', { title: 'Written on Windows', body: 'Step one.\r\nStep two.\r\n' }, grimoire.ctx));
    await ok(grimoire.core.call('wiki_edit', { ...PAGE, body: PAGE.body.replace(/\n/g, '\r\n'), base: null }, human));
    const { attempt } = await ok(grimoire.core.call('claim', { id }, grimoire.ctx));
    const start = (await trackerFiles(world)).find((file) => file.endsWith(`/${attempt}/start.md`))!;
    const session = start.replace(/start\.md$/, 'sessions/s1.md');
    const crlfFrontmatter = start.replace(/start\.md$/, 'sessions/s2.md');
    await commitToTracker(world.a, {
      // An excerpt keeps a Windows tool's output as it was.
      [session]: capturedSession('PS> npm test\r\nok\r\n'),
      [crlfFrontmatter]: '---\r\nclient: "codex"\r\n---\r\n',
    });

    const report = await runDoctor({ root: world.a.dir, checks: RECORD_CHECKS });

    expect(report.findings).toEqual([expect.objectContaining({ kind: 'non-canonical', subject: crlfFrontmatter, message: expect.stringContaining('CR') })]);
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

    expect(found(report, 'conflict')).toEqual([
      expect.objectContaining({ subject: titled, remedy: expect.stringContaining(`grimoire resolve ${titled}`), details: expect.objectContaining({ fields: ['title'] }) }),
    ]);
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

  test('a push the remote refused over a ref named like a folder of the tracker branch is a D/F conflict', async ({ world, grimoire }) => {
    await pushTracker(world.a);
    // Someone pushed a branch named `grimoire`: the remote can't hold `grimoire/tracker` beside it.
    await world.a.git(['push', '--quiet', 'origin', '--delete', 'grimoire/tracker']);
    await world.a.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/grimoire']);
    // Only the remote holds it: this clone's own D/F refs are another finding.
    await world.a.git(['update-ref', '-d', 'refs/remotes/origin/grimoire']);
    await ok(grimoire.core.call('create', { title: 'Waiting to go out' }, grimoire.ctx));
    await grimoire.core.call('sync', {}, grimoire.ctx);

    const report = await runDoctor({ root: world.a.dir, checks: REF_CHECKS });

    expect(found(report, 'df-ref-conflict')).toEqual([expect.objectContaining({ subject: 'remote', message: expect.stringContaining('refs/heads/grimoire') })]);
  });

  test('a sync that failed on a stale ref lock is reported as the lock, not as a D/F conflict', async ({ world, grimoire }) => {
    const { bob } = await shared(world);
    // The remote moved, so a's fetch has a remote-tracking ref to update.
    await ok(grimoire.core.call('create', { title: 'Only there' }, bob));
    await pushTracker(world.b);
    const lock = path.join(world.a.dir, '.git', 'refs', 'remotes', 'origin', 'grimoire', 'tracker.lock');
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, '');
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await grimoire.core.call('sync', {}, grimoire.ctx);

    const report = await runDoctor({ root: world.a.dir, checks: REF_CHECKS });

    expect(found(report, 'sync-failed')).toEqual([expect.objectContaining({ message: expect.stringContaining('cannot lock ref') })]);
    expect(found(report, 'stale-ref-lock')).toEqual([expect.objectContaining({ subject: 'refs/remotes/origin/grimoire/tracker.lock' })]);
    expect(found(report, 'df-ref-conflict')).toEqual([]);
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
