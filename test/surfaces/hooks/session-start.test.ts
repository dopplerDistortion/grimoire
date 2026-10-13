// Seam 2 (spec Testing Decisions; spike C B1, spike E finding 1): the
// SessionStart payloads both clients really send, and the output each client
// accepts. Claude Code reloads skills from `hookSpecificOutput.reloadSkills`;
// Codex fails the hook on any key it doesn't know, so it only ever gets the
// plain line.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { gitTest, readFixture, readFixtureJson, type GitWorld } from '#harness';
import { createCore, type CallContext } from '../../../src/core';
import { cachedServedSet, listStrayEdits, reconcileWorktree, SERVED_SET_CACHE, sessionStartFastPath, tipPairKey } from '../../../src/generated';
import { skillVersionOf } from '../../../src/knowledge';
import { MachineLocalStore } from '../../../src/machine-local';
import { openTracker } from '../../../src/tracker';
import { worktreeLeaseName } from '../../../src/upkeep/checkout';
import { writeInto } from '../../generated/support';
import { runUpkeep } from '../../../src/upkeep';
import { agentContext, initializeTracker } from '../../core/support';
import { installed } from '../../upkeep/support';
import { runHook } from '../../../src/surfaces/hooks/run-hook';
import { sessionStart, sessionStartClient, sessionStartOutput } from '../../../src/surfaces/hooks/session-start';

const CLAUDE = ['startup', 'startup-plain', 'clear', 'compact', 'resume', 'fork'].map((name) => `claude-code/hook-payloads/session-start-${name}.json`);
const CODEX = ['startup', 'resume'].map((name) => `codex/hook-payloads/session-start-${name}.json`);
const LINE = 'grimoire: 1 chore is due; run the grimoire-chores skill';
/** What Claude Code is told when the hook wrote skill stubs (spike C, B1). */
const RELOAD = '{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}';
const NOTES = '---\nname: release-notes\ndescription: Use when recording a change in the release notes.\n---\n# Release notes\n\nCreate `changes/<slug>.md`.\n';
const NOTES_V2 = `${NOTES}Never edit \`CHANGELOG.md\`.\n`;
const COPY = '.grimoire/skills/release-notes/SKILL.md';

/** A person at their terminal in clone a. */
function terminalOf(world: GitWorld): CallContext {
  return { ...agentContext(world.a), surface: 'cli', client: null, evidence: {}, tty: true };
}

/** Commits a new version of release-notes, refreshing no worktree (as on another machine, or before the next upkeep). */
async function editServed(world: GitWorld, text: string, base: string | null): Promise<void> {
  const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
  try {
    const edit = await core.call('skill_edit', { name: 'release-notes', text, base }, terminalOf(world));
    if (!edit.ok) throw new Error(JSON.stringify(edit.error));
  } finally {
    await core.close();
  }
}

/** Clone a installed and committed on this pin, its tracker serving one evolved skill, and no generated output yet. */
async function withServedSkill(world: GitWorld): Promise<string> {
  const root = world.a.dir;
  await installed(root);
  await world.a.git(['add', '-A']);
  await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
  await initializeTracker(world.a, world.a);
  const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
  try {
    const edit = await core.call('skill_edit', { name: 'release-notes', text: NOTES, base: null }, terminalOf(world));
    if (!edit.ok) throw new Error(JSON.stringify(edit.error));
  } finally {
    await core.close();
  }
  return root;
}

/**
 * Runs the verb as the client would, with a captured payload; its exit code and stdout.
 * The fast path's 7 s budget is measured from the hook's start, so on a loaded machine it
 * would cut these tests' writes short: they run unbudgeted unless they name a budget.
 * The real budget, through the real chain, is session-start.slow.test.ts's.
 */
async function hook(root: string, fixture: string, fastPathBudgetMs = Number.POSITIVE_INFINITY): Promise<{ code: number; output: string }> {
  let output = '';
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString('utf8');
      done();
    },
  });
  const code = await runHook('session-start', root, { stdin: Readable.from([readFixture(fixture)]), stdout }, { fastPathBudgetMs });
  return { code, output };
}

describe('telling the clients apart by the payload alone', () => {
  it('every captured Claude Code payload is claude-code; every Codex payload (permission_mode) is codex', () => {
    for (const fixture of CLAUDE) expect(sessionStartClient(readFixtureJson(fixture)), fixture).toBe('claude-code');
    for (const fixture of CODEX) expect(sessionStartClient(readFixtureJson(fixture)), fixture).toBe('codex');
  });

  gitTest('the verb, under Claude Code’s env markers (a Codex started from Claude Code’s shell inherits them), gives a Codex payload no JSON Codex would reject, even when it wrote skill stubs', async ({
    world,
  }) => {
    const root = await withServedSkill(world);
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_PROJECT_DIR', root);

    for (const fixture of CODEX) {
      await rm(path.join(root, '.claude', 'skills', 'grimoire-release-notes'), { recursive: true, force: true });
      const { code, output } = await hook(root, fixture);

      expect(code, fixture).toBe(0);
      // It wrote the stub, which a Claude Code payload answers with reloadSkills…
      expect(await readFile(path.join(root, '.claude/skills/grimoire-release-notes/SKILL.md'), 'utf8'), fixture).toContain('name: grimoire-release-notes');
      // …but Codex's schema denies unknown keys: reloadSkills would fail the hook and drop the line.
      expect(output, fixture).not.toContain('reloadSkills');
    }
    // The same run for Claude Code, under the same markers, does say it.
    await rm(path.join(root, '.claude', 'skills', 'grimoire-release-notes'), { recursive: true, force: true });
    expect((await hook(root, CLAUDE[0]!)).output).toBe(`${RELOAD}\n`);
  });

  it('anything else is no client', () => {
    for (const payload of [null, 'SessionStart', [], {}, { hook_event_name: 'PreToolUse' }, readFixtureJson('claude-code/hook-payloads/pre-tool-use.json')]) {
      expect(sessionStartClient(payload)).toBeNull();
    }
  });
});

describe('what each client is given', () => {
  it('Claude Code: reloadSkills as hookSpecificOutput, with the line as additionalContext when there is one', () => {
    expect(sessionStartOutput('claude-code', { reloadSkills: true })).toBe('{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}\n');
    expect(JSON.parse(sessionStartOutput('claude-code', { reloadSkills: true, line: LINE }))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', reloadSkills: true, additionalContext: LINE },
    });
    expect(sessionStartOutput('claude-code', { line: LINE })).toBe(`${LINE}\n`);
  });

  it('Codex: the plain line only, never JSON, even when skills were written', () => {
    expect(sessionStartOutput('codex', { reloadSkills: true, line: LINE })).toBe(`${LINE}\n`);
    expect(sessionStartOutput('codex', { reloadSkills: true })).toBe('');
  });

  it('an unknown client gets the plain line, which both accept', () => {
    expect(sessionStartOutput(null, { reloadSkills: true, line: LINE })).toBe(`${LINE}\n`);
  });

  it('nothing to say prints nothing, for every captured payload and for an unreadable one', async () => {
    for (const fixture of [...CLAUDE, ...CODEX]) expect(await sessionStart(readFixture(fixture), { startDir: process.cwd() }), fixture).toBe('');
    expect(await sessionStart('not json', { startDir: process.cwd() })).toBe('');
  });
});

describe('the session line', () => {
  gitTest('names the pointer files upkeep refreshed until they are committed', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    await writeFile(path.join(root, 'AGENTS.md'), (await readFile(path.join(root, 'AGENTS.md'), 'utf8')).replace('## grimoire', '## grimoire (mine)'));
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');
    await world.a.git(['commit', '--quiet', '-am', 'my edits']);
    await runUpkeep({ root });

    for (const fixture of [CLAUDE[0]!, CODEX[0]!]) {
      expect(await sessionStart(readFixture(fixture), { startDir: root }), fixture).toBe('grimoire refreshed 2 pointer files: commit them\n');
    }

    await world.a.git(['commit', '--quiet', '-am', 'take the shipped text']);
    expect(await sessionStart(readFixture(CLAUDE[0]!), { startDir: root })).toBe('');
  });
});

describe('the Codex session mark', () => {
  gitTest('a Codex session start records the transcript its payload reveals, by session id, so its server knows the hook ran; a Claude Code one leaves no Codex mark', async ({ world }) => {
    const root = world.a.dir;
    await installed(root);
    const { MachineLocalStore } = await import('../../../src/machine-local');
    const { revealedRoot } = await import('../../../src/capture/transcript-roots');
    const store = new MachineLocalStore(path.join(root, '.git'));
    const codex = readFixtureJson<{ session_id: string; transcript_path: string }>(CODEX[0]!);
    const claude = readFixtureJson<{ session_id: string }>(CLAUDE[0]!);

    expect(await sessionStart(readFixture(CODEX[0]!), { startDir: root })).toBe('');
    expect(await sessionStart(readFixture(CLAUDE[0]!), { startDir: root })).toBe('');

    expect(await revealedRoot(store, codex.session_id)).toMatchObject({ client: 'codex', session: codex.session_id, transcript_path: codex.transcript_path });
    expect(await revealedRoot(store, claude.session_id)).toBeUndefined();
  });
});

describe('the skill fast path', () => {
  const folders = ['.grimoire/skills/release-notes', '.claude/skills/grimoire-release-notes', '.agents/skills/grimoire-release-notes'];
  const exists = async (file: string) => (await stat(file).catch(() => null)) !== null;

  gitTest('in a worktree missing its copies and stubs, it writes them and Claude Code reloads its skills; a second run writes nothing and says nothing', async ({
    world,
  }) => {
    const root = await withServedSkill(world);

    const first = await hook(root, CLAUDE[0]!);
    const second = await hook(root, CLAUDE[0]!);

    expect(first).toEqual({ code: 0, output: `${RELOAD}\n` });
    expect(await readFile(path.join(root, '.grimoire/skills/release-notes/SKILL.md'), 'utf8')).toBe(NOTES);
    for (const folder of folders) expect(await readFile(path.join(root, folder, '.gitignore'), 'utf8'), folder).toBe('*\n');
    expect(await world.a.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(second).toEqual({ code: 0, output: '' });
  });

  gitTest('it writes only what differs: a copy holding an older version is rewritten and the stubs left as they are; a hand edit is saved as a stray edit before the served text goes back; nothing is removed', async ({
    world,
  }) => {
    const root = await withServedSkill(world);
    await hook(root, CLAUDE[0]!);
    const stub = path.join(root, '.claude/skills/grimoire-release-notes/SKILL.md');
    const stubWritten = (await stat(stub)).mtimeMs;
    await writeInto(root, '.agents/skills/grimoire-retired/SKILL.md', 'a stub nothing serves\n');
    await writeInto(root, '.agents/skills/grimoire-retired/.gitignore', '*\n');
    await editServed(world, NOTES_V2, skillVersionOf(NOTES));

    const newer = await hook(root, CLAUDE[0]!);

    expect(newer).toEqual({ code: 0, output: `${RELOAD}\n` });
    expect(await readFile(path.join(root, COPY), 'utf8')).toBe(NOTES_V2);
    expect((await stat(stub)).mtimeMs).toBe(stubWritten);
    expect(await readFile(path.join(root, '.agents/skills/grimoire-retired/SKILL.md'), 'utf8')).toBe('a stub nothing serves\n');

    await writeFile(path.join(root, COPY), 'edited by hand\n');
    const edited = await hook(root, CLAUDE[0]!);

    expect(JSON.parse(edited.output)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', reloadSkills: true, additionalContext: 'grimoire: stray edit to release-notes: Record or Discard' },
    });
    expect(await readFile(path.join(root, COPY), 'utf8')).toBe(NOTES_V2);
    const strays = await listStrayEdits(new MachineLocalStore(path.join(root, '.git')));
    expect(strays).toEqual([expect.objectContaining({ skill: 'release-notes', text: 'edited by hand\n', base: skillVersionOf(NOTES_V2), path: COPY })]);
    // Nothing more to write: no reload, and the stray edit still waits for a human.
    expect(await hook(root, CLAUDE[0]!)).toEqual({ code: 0, output: 'grimoire: stray edit to release-notes: Record or Discard\n' });
    expect(await hook(root, CODEX[0]!)).toEqual({ code: 0, output: 'grimoire: stray edit to release-notes: Record or Discard\n' });
  });

  gitTest('past its budget the fast path starts no writes and says nothing; the next session start within budget writes them', async ({ world }) => {
    const root = await withServedSkill(world);

    expect(await hook(root, CLAUDE[0]!, 0)).toEqual({ code: 0, output: '' });
    for (const folder of folders) expect(await exists(path.join(root, folder)), folder).toBe(false);

    expect(await hook(root, CLAUDE[0]!)).toEqual({ code: 0, output: `${RELOAD}
` });
  });

  gitTest('it writes nothing mid-merge', async ({ world }) => {
    const root = await withServedSkill(world);
    await world.a.commitFile('shared.txt', 'base\n');
    await world.a.git(['switch', '--quiet', '-c', 'other']);
    await world.a.commitFile('shared.txt', 'theirs\n');
    await world.a.git(['switch', '--quiet', 'main']);
    await world.a.commitFile('shared.txt', 'ours\n');
    expect((await world.a.gitResult(['merge', '--quiet', 'other'])).code).not.toBe(0);

    const merging = await hook(root, CLAUDE[0]!);

    expect(merging).toEqual({ code: 0, output: '' });
    for (const folder of folders) expect(await exists(path.join(root, folder)), folder).toBe(false);
  });

  gitTest('a session start whose tracker didn’t move serves from the served-set cache, keyed by the tip pair; once the tip pair moves it reads the tracker again', async ({
    world,
  }) => {
    const root = await withServedSkill(world);
    await hook(root, CLAUDE[0]!);
    const store = new MachineLocalStore(path.join(root, '.git'));
    const tracker = await openTracker(root);
    const tips = await tracker.tips();
    await tracker.close();
    const cached = await store.caches.read<{ tips: string; skills: { name: string; text: string }[] }>(SERVED_SET_CACHE, 1);
    expect(cached).toMatchObject({ tips: tipPairKey(tips), skills: [{ name: 'release-notes', text: NOTES }] });

    // A cache naming the tips the tracker is at is trusted as it is: the ledger isn't read.
    const CACHED = NOTES.replace('Create', 'Cached: create');
    await store.caches.put(SERVED_SET_CACHE, 1, { ...cached, skills: [{ ...cached!.skills[0], text: CACHED }] });
    await rm(path.join(root, '.grimoire', 'skills'), { recursive: true });
    await hook(root, CLAUDE[0]!);
    expect(await readFile(path.join(root, COPY), 'utf8')).toBe(CACHED);

    await editServed(world, NOTES_V2, skillVersionOf(NOTES));
    await hook(root, CLAUDE[0]!);
    expect(await readFile(path.join(root, COPY), 'utf8')).toBe(NOTES_V2);
  });

  gitTest('while another process holds the worktree’s lease the hook writes nothing; a fast path waiting for it reads the served set again, so a delivery-off committed meanwhile is never undone', async ({
    world,
  }) => {
    const root = await withServedSkill(world);
    const store = new MachineLocalStore(path.join(root, '.git'));
    const held = await store.leases.acquire(await worktreeLeaseName(root), { ttlMs: 60_000 });
    if (held.status !== 'acquired') throw new Error('the lease was held');

    expect(await hook(root, CLAUDE[0]!)).toEqual({ code: 0, output: '' });
    for (const folder of folders) expect(await exists(path.join(root, folder)), folder).toBe(false);

    const waiting = sessionStartFastPath(store, root, { leaseWaitMs: 60_000 });
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      const off = await core.call('settings_set', { key: 'skills.delivery', value: false }, terminalOf(world));
      expect(off).toMatchObject({ ok: true });
    } finally {
      await core.close();
    }
    await held.lease.release();

    expect(await waiting).toMatchObject({ wrote: [] });
    for (const folder of folders) expect(await exists(path.join(root, folder)), folder).toBe(false);
  });
  gitTest('when the lease holder writes the copies and stubs while the hook waits for the lease, the skills still changed during this session start: Claude Code is told to reload them, whether the hook gets the lease after or never', async ({
    world,
  }) => {
    const root = await withServedSkill(world);
    for (const releases of [true, false]) {
      for (const folder of folders) await rm(path.join(root, folder), { recursive: true, force: true });
      const store = new MachineLocalStore(path.join(root, '.git'));
      const held = await store.leases.acquire(await worktreeLeaseName(root), { ttlMs: 60_000 });
      if (held.status !== 'acquired') throw new Error('the lease was held');
      // The holder (upkeep, `start`'s watcher, a refresh) writes once the hook first finds the lease taken.
      const acquire = store.leases.acquire.bind(store.leases);
      let wrote = false;
      vi.spyOn(store.leases, 'acquire').mockImplementation(async (name, options) => {
        const result = await acquire(name, options);
        if (result.status === 'held' && !wrote) {
          wrote = true;
          await reconcileWorktree(store, root, await cachedServedSet(store, root), 'fast-path');
          if (releases) await held.lease.release();
        }
        return result;
      });

      const fast = await sessionStartFastPath(store, root, { leaseWaitMs: releases ? 60_000 : 300 });

      expect(wrote, `releases: ${releases}`).toBe(true);
      expect(fast, `releases: ${releases}`).toMatchObject({ wrote: [], changed: true, ...(releases ? {} : { skipped: 'held' }) });
      expect(await readFile(path.join(root, COPY), 'utf8')).toBe(NOTES);
      if (!releases) await held.lease.release();
      vi.restoreAllMocks();
    }
    // Nothing changed this time: no reload.
    expect(await sessionStartFastPath(new MachineLocalStore(path.join(root, '.git')), root)).toMatchObject({ wrote: [], changed: false });
  });
});
