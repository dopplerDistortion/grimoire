// Commit facts in traces (GOK-156; spec §14 Facts: Commits; seam 1): the
// commits an attempt actually produced, never a person's commits from other
// worktrees. Observed commits land in the bound context's session record
// (from a creation line in its own or a launched subagent's tool result, or a
// creating HEAD-reflog entry in its worktree timed inside one of its calls);
// referenced commits (a `Refs:` trailer naming the issue, committed inside the
// attempt) land in `end.md`. Each carries a snapshot; a hash this clone lacks
// is recorded bare. Agent edits of `.grimoire/skills/**` are flagged.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { removeDir, type Checkout } from '#harness';
import type { CallContext } from '../../src/core';
import { attemptDir, captureOf, claudeCallIn, claudeConfigDir, created, DEBRIEF, person, sessionRecords, test } from './capture-support';
import { trackerFile, trackerTip } from './support';

/** The subagent-commit session: the main line's `Agent` launch, its subagent, and their times. */
const SESSION = 'ff9eace1-0645-4dd9-bf34-f61ffa87b3c2';
const LAUNCH = 'toolu_01UTXByWB7vpCJEQ9XQtSwdv';
const SUBAGENT = 'ae1c0b7534f14a681';
/** The subagent's own first call: its `Write`. */
const SUBAGENT_WRITE = 'toolu_01EJf9mTZ9UgvtydMrY6JVGu';

/** The cut's budget: what is tested here is which commits count, never how fast git answers on a loaded machine. */
const UNHURRIED = 120_000;

/** Commits in `checkout` at a fixed time, as a person or an agent's shell would make them. */
async function commitAt(checkout: Checkout, at: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(checkout.dir, file)), { recursive: true });
    await writeFile(path.join(checkout.dir, file), text);
    await checkout.git(['add', '-f', '--', file]);
  }
  await checkout.git(['commit', '--quiet', '-m', message], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  return checkout.git(['rev-parse', 'HEAD']);
}

/** Runs git in `checkout` at a fixed time. */
const gitAt = (checkout: Checkout, at: string, args: string[]) => checkout.gitResult(args, { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });

/** The `commits` line of the attempt's end.md. */
async function endCommits(checkout: Checkout, id: string, attempt: string): Promise<unknown[]> {
  const end = await trackerFile(checkout, (await trackerTip(checkout))!, `${attemptDir(id, attempt)}/end.md`);
  return JSON.parse(/^commits: (.*)$/m.exec(end)![1]!);
}

/** A test whose Claude Code config dir holds the subagent-commit session. */
const commitTest = test.extend('session', async ({ capture }, { onCleanup }) => {
  const configDir = await claudeConfigDir({ folder: 'claude-code/transcripts/subagent-commit', session: SESSION });
  onCleanup(() => removeDir(configDir));
  return { core: capture.makeCore({ capture: { claudeConfigDir: configDir, home: path.dirname(configDir), budgetMs: UNHURRIED } }) };
});

describe('observed commits', { timeout: 180_000 }, () => {
  commitTest(
    'a subagent’s creation line gives via observed (bare: this clone lacks it); git log’s hashes count none; a reflog entry in the worktree timed inside a call counts, with its snapshot',
    async ({ world, grimoire, capture, session }) => {
      const { core } = session;
      capture.at('2026-10-12T12:39:05.000Z');
      const id = await created(core, grimoire.ctx, 'Commit it');
      const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, SESSION, LAUNCH));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const attempt = claim.result.attempt;
      // Inside the main line's Agent call (12:39:08.8 to 12:39:25.8): it counts, with what it changed.
      const inside = await commitAt(world.a, '2026-10-12T12:39:20Z', { 'src/feature.txt': 'one\ntwo\n' }, 'Add the feature');
      // Between calls: a person's commit in the same worktree while the agent waited.
      await commitAt(world.a, '2026-10-12T12:39:29Z', { 'notes.txt': 'mine\n' }, 'A person’s note');
      // Inside the call, but in another worktree of the clone: never the agent's.
      const elsewhere = await world.a.addWorktree('elsewhere');
      await commitAt(elsewhere, '2026-10-12T12:39:21Z', { 'other.txt': 'x\n' }, 'Work elsewhere');
      capture.at('2026-10-12T12:39:30.000Z');

      const closed = await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, SESSION, 'toolu_close'));

      expect(closed).toMatchObject({ ok: true });
      const [record] = await sessionRecords(world.a, id, attempt);
      expect(record!.fields.facts).toBe('scanned');
      expect(record!.fields.commits).toEqual([
        { hash: 'dba2f59', via: 'observed', session: SESSION, context: SUBAGENT },
        {
          hash: inside,
          via: 'observed',
          session: SESSION,
          context: 'main',
          at: '2026-10-12T12:39:20.000Z',
          subject: 'Add the feature',
          files: ['src/feature.txt'],
          added: 2,
          removed: 0,
        },
      ]);
      // `git log` printed 6448984 (the probe repo's init): never counted.
      expect(JSON.stringify(record!.fields.commits)).not.toContain('6448984');
    },
  );

  commitTest(
    'an agent commit touching .grimoire/skills/** is flagged; a merge only when the merged file matches neither parent',
    async ({ world, grimoire, capture, session }) => {
      const { core } = session;
      const skill = '.grimoire/skills/notes/SKILL.md';
      // The history before the attempt, made outside any of the session's calls.
      const before = '2026-10-12T12:38:00Z';
      await commitAt(world.a, before, { [skill]: 'v0\n', 'README.md': 'r0\n' }, 'Base');
      const main = await world.a.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      await gitAt(world.a, before, ['checkout', '--quiet', '-b', 'theirs']);
      await commitAt(world.a, before, { [skill]: 'theirs\n' }, 'Their skill text');
      await gitAt(world.a, before, ['checkout', '--quiet', '-b', 'clash', main]);
      await commitAt(world.a, before, { [skill]: 'clash\n' }, 'A clashing skill text');
      await gitAt(world.a, before, ['checkout', '--quiet', main]);

      capture.at('2026-10-12T12:39:05.000Z');
      const id = await created(core, grimoire.ctx, 'Skill edits');
      const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, SESSION, LAUNCH));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const attempt = claim.result.attempt;
      // All inside the main line's Agent call.
      const direct = await commitAt(world.a, '2026-10-12T12:39:10Z', { [skill]: 'agent\n' }, 'Edit the skill copy');
      const readme = await commitAt(world.a, '2026-10-12T12:39:11Z', { 'README.md': 'r1\n' }, 'Readme');
      // A merge taking their skill text unchanged: it matches a parent.
      await gitAt(world.a, '2026-10-12T12:39:12Z', ['reset', '--quiet', '--hard', readme]);
      await gitAt(world.a, '2026-10-12T12:39:12Z', ['merge', '--quiet', '--no-ff', '--no-commit', '-X', 'theirs', 'theirs']);
      await gitAt(world.a, '2026-10-12T12:39:13Z', ['commit', '--quiet', '-m', 'Merge theirs']);
      const clean = await world.a.git(['rev-parse', 'HEAD']);
      // A merge whose skill text is neither side's.
      await gitAt(world.a, '2026-10-12T12:39:14Z', ['merge', '--quiet', '--no-ff', 'clash']);
      await writeFile(path.join(world.a.dir, skill), 'resolved\n');
      await world.a.git(['add', '--', skill]);
      await gitAt(world.a, '2026-10-12T12:39:15Z', ['commit', '--quiet', '-m', 'Merge clash']);
      const resolved = await world.a.git(['rev-parse', 'HEAD']);
      capture.at('2026-10-12T12:39:30.000Z');

      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, SESSION, 'toolu_close'));

      const [record] = await sessionRecords(world.a, id, attempt);
      const commits = record!.fields.commits as { hash: string; agent_skill_edit?: true; files?: string[] }[];
      const flagged = (hash: string) => commits.find((commit) => commit.hash === hash)?.agent_skill_edit ?? false;
      expect(commits.map((commit) => commit.hash)).toEqual(['dba2f59', direct, readme, clean, resolved]);
      expect(flagged(direct)).toBe(true);
      expect(flagged(readme)).toBe(false);
      // The clean merge changed the skill against its first parent, but kept their text.
      expect(commits.find((commit) => commit.hash === clean)!.files).toContain(skill);
      expect(flagged(clean)).toBe(false);
      expect(flagged(resolved)).toBe(true);
    },
  );

  commitTest('a bound subagent’s commits are credited to its own record only, never again to its launcher’s', async ({ world, grimoire, capture, session }) => {
    const { core } = session;
    capture.at('2026-10-12T12:39:05.000Z');
    const id = await created(core, grimoire.ctx, 'Commit it twice');
    const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, SESSION, LAUNCH));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const attempt = claim.result.attempt;
    // The subagent binds too, through a call of its own (its Write, 12:39:10).
    capture.at('2026-10-12T12:39:10.100Z');
    const update = await core.call('update', { id, labels_add: ['sub'], attempt }, claudeCallIn(grimoire.ctx, SESSION, SUBAGENT_WRITE, { id: SUBAGENT, type: 'general-purpose' }));
    expect(update.ok).toBe(true);
    // Inside the subagent's Bash call (12:39:13.8 to 12:39:25.0), and so inside the launcher's Agent call too.
    const inside = await commitAt(world.a, '2026-10-12T12:39:20Z', { 'sub.txt': 'sub\n' }, 'Add sub');
    capture.at('2026-10-12T12:39:30.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, SESSION, 'toolu_close'));

    const records = await sessionRecords(world.a, id, attempt);
    const of = (context: string) => records.find((record) => record.fields.context === context)!.fields;
    expect(of(SUBAGENT).commits).toEqual([
      { hash: 'dba2f59', via: 'observed', session: SESSION, context: SUBAGENT },
      expect.objectContaining({ hash: inside, via: 'observed', session: SESSION, context: SUBAGENT }),
    ]);
    expect(of('main').facts).toBe('scanned');
    expect(of('main').commits).toEqual([]);
  });

  commitTest(
    'a clean git merge that makes a commit is observed, flagged when its skill file blends both sides; a fast-forward makes none',
    async ({ world, grimoire, capture, session }) => {
      const { core } = session;
      const skill = '.grimoire/skills/notes/SKILL.md';
      const before = '2026-10-12T12:38:00Z';
      await commitAt(world.a, before, { [skill]: 'a\nb\nc\nd\ne\n' }, 'Base');
      const main = await world.a.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      await gitAt(world.a, before, ['checkout', '--quiet', '-b', 'theirs']);
      await commitAt(world.a, before, { [skill]: 'A\nb\nc\nd\ne\n' }, 'Their first line');
      // A merge someone made before, on a branch HEAD can fast-forward to.
      await gitAt(world.a, before, ['checkout', '--quiet', '-b', 'side', main]);
      await commitAt(world.a, before, { 'side.txt': 'x\n' }, 'Side');
      await gitAt(world.a, before, ['checkout', '--quiet', '-b', 'ahead', main]);
      await gitAt(world.a, before, ['merge', '--quiet', '--no-ff', '-m', 'Ahead', 'side']);
      const ahead = await world.a.git(['rev-parse', 'HEAD']);
      await gitAt(world.a, before, ['checkout', '--quiet', main]);

      capture.at('2026-10-12T12:39:05.000Z');
      const id = await created(core, grimoire.ctx, 'Merges');
      const claim = await core.call('claim', { id }, claudeCallIn(grimoire.ctx, SESSION, LAUNCH));
      if (!claim.ok) throw new Error(JSON.stringify(claim.error));
      const attempt = claim.result.attempt;
      // All inside the main line's Agent call. A fast-forward moves HEAD to a commit made before.
      expect((await gitAt(world.a, '2026-10-12T12:39:10Z', ['merge', '--quiet', '--ff-only', 'ahead'])).code).toBe(0);
      const direct = await commitAt(world.a, '2026-10-12T12:39:11Z', { [skill]: 'a\nb\nc\nd\nE\n' }, 'Our last line');
      // git merges both edits on its own: the merged file matches neither parent.
      expect((await gitAt(world.a, '2026-10-12T12:39:12Z', ['merge', '--quiet', '--no-ff', '-m', 'Blend', 'theirs'])).code).toBe(0);
      const blend = await world.a.git(['rev-parse', 'HEAD']);
      expect(await world.a.git(['show', `HEAD:${skill}`])).toBe('A\nb\nc\nd\nE');
      capture.at('2026-10-12T12:39:30.000Z');

      await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, claudeCallIn(grimoire.ctx, SESSION, 'toolu_close'));

      const [record] = await sessionRecords(world.a, id, attempt);
      const commits = record!.fields.commits as { hash: string; agent_skill_edit?: true; subject?: string }[];
      expect(commits.map((commit) => [commit.hash, commit.agent_skill_edit ?? null])).toEqual([
        ['dba2f59', null],
        [direct, true],
        [blend, true],
      ]);
      expect(JSON.stringify(commits)).not.toContain(ahead);
    },
  );
});

describe('referenced commits', { timeout: 180_000 }, () => {
  /** Alice at her own terminal, with the core's clock. */
  const human = (ctx: CallContext): CallContext => person(ctx);

  test('a Refs trailer committed inside the attempt gives via referenced in end.md, with its snapshot; an agent co-author in a human attempt is agent_assisted', async ({
    world,
    grimoire,
    capture,
  }) => {
    const core = capture.makeCore({ capture: { budgetMs: UNHURRIED } });
    capture.at('2026-10-12T10:00:00.000Z');
    const id = await created(core, human(grimoire.ctx), 'Referenced');
    const claim = await core.call('claim', { id }, human(grimoire.ctx));
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const attempt = claim.result.attempt;
    const plain = await commitAt(world.a, '2026-10-12T10:03:00Z', { 'a.txt': 'a\nb\nc\n' }, `Fix the port\n\nRefs: ${id}`);
    const assisted = await commitAt(
      world.a,
      '2026-10-12T10:05:00Z',
      { 'a.txt': 'a\n' },
      `Trim it\n\nRefs: ${id}\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
    );
    await commitAt(world.a, '2026-10-12T10:06:00Z', { 'b.txt': 'b\n' }, 'Another issue\n\nRefs: gr-zzzz');
    // On another branch, not checked out: still the clone's.
    await gitAt(world.a, '2026-10-12T10:07:00Z', ['checkout', '--quiet', '-b', 'side']);
    const side = await commitAt(world.a, '2026-10-12T10:07:00Z', { 'c.txt': 'c\n' }, `Side work\n\nRefs: ${id}`);
    await gitAt(world.a, '2026-10-12T10:07:00Z', ['checkout', '--quiet', '-']);
    await commitAt(world.a, '2026-10-12T10:20:00Z', { 'd.txt': 'd\n' }, `After the close\n\nRefs: ${id}`);
    capture.at('2026-10-12T10:10:00.000Z');

    const closed = await core.call('close', { id, reason: 'done', attempt }, human(grimoire.ctx));

    expect(closed).toMatchObject({ ok: true });
    expect(await endCommits(world.a, id, attempt)).toEqual([
      { hash: plain, via: 'referenced', at: '2026-10-12T10:03:00.000Z', subject: 'Fix the port', files: ['a.txt'], added: 3, removed: 0 },
      { hash: assisted, via: 'referenced', at: '2026-10-12T10:05:00.000Z', subject: 'Trim it', files: ['a.txt'], added: 0, removed: 2, agent_assisted: true },
      { hash: side, via: 'referenced', at: '2026-10-12T10:07:00.000Z', subject: 'Side work', files: ['c.txt'], added: 1, removed: 0 },
    ]);
    // The trace shows them beside its contexts.
    expect((await captureOf(world.a, attempt)).referenced).toEqual(await endCommits(world.a, id, attempt));
  });

  test('in an agent attempt, an agent-co-authored referenced commit touching .grimoire/skills/** is flagged, never agent_assisted', async ({ world, grimoire, capture }) => {
    const core = capture.makeCore({ capture: { budgetMs: UNHURRIED } });
    capture.at('2026-10-12T10:00:00.000Z');
    const id = await created(core, grimoire.ctx, 'Agent referenced');
    const claim = await core.call('claim', { id }, grimoire.ctx);
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    const attempt = claim.result.attempt;
    const edit = await commitAt(
      world.a,
      '2026-10-12T10:05:00Z',
      { '.grimoire/skills/notes/SKILL.md': 'agent text\n' },
      `Edit notes\n\nRefs: ${id}\nCo-authored-by: Codex <codex@openai.com>`,
    );
    const lone = await commitAt(world.a, '2026-10-12T10:06:00Z', { '.grimoire/skills/notes/SKILL.md': 'my text\n' }, `My notes\n\nRefs: ${id}`);
    capture.at('2026-10-12T10:10:00.000Z');

    await core.call('close', { id, reason: 'done', attempt, debrief: DEBRIEF }, grimoire.ctx);

    const commits = (await endCommits(world.a, id, attempt)) as { hash: string; agent_skill_edit?: true; agent_assisted?: true }[];
    expect(commits.map((commit) => [commit.hash, commit.agent_skill_edit ?? null, commit.agent_assisted ?? null])).toEqual([
      [edit, true, null],
      [lone, null, null],
    ]);
  });
});
