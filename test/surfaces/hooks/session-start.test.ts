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
import { lateWork } from '../../../src/surfaces/hooks/late';
import { putMachineSetting } from '../../../src/core/settings';
import { sessionLine } from '../../../src/knowledge/chores/offering';
import { randomProposalId } from '../../../src/tracker';
import { VERSION } from '../../../src/version';
import { workPair } from '../../core/chore-support';

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

describe('the session line, by priority (spec §12)', () => {
  const ASK = "grimoire: a maintenance chore is due. At a natural pause, offer to run the grimoire-chores skill; don't run it unasked.";
  const AUTO = 'grimoire: a maintenance chore is due. Run the grimoire-chores skill now; it works in the background.';
  const MANUAL = 'grimoire: a maintenance chore is due.';
  const PROPOSAL_ALONE = "1 skill proposal awaits human review in grimoire's dashboard";
  const PROPOSAL_TEXT = 'SECRET-PROPOSAL-TEXT';

  /** Clone a installed and committed at `pin`, with a tracker. */
  async function setUp(world: GitWorld, pin?: string): Promise<string> {
    const root = world.a.dir;
    await installed(root, pin);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    await initializeTracker(world.a, world.a);
    return root;
  }

  /** Makes the Wiki Maintainer due: one settled failing trace, at compile_pairs 1. */
  async function choreDue(world: GitWorld): Promise<void> {
    const core = createCore({ autoSync: 'off', refreshSkills: 'off' });
    try {
      for (const [key, value] of [['chores.compile_pairs', 1], ['chores.settle_hours', 0]] as const) {
        expect(await core.call('settings_set', { key, value }, terminalOf(world))).toMatchObject({ ok: true });
      }
      await workPair(core, agentContext(world.a), 'fail');
    } finally {
      await core.close();
    }
  }

  /** A skill proposal pending human review, as a Skill Proposer run writes it. */
  async function proposalPending(world: GitWorld): Promise<void> {
    const tracker = await openTracker(world.a.dir);
    try {
      await tracker.transact({ op: 'propose', author: { name: world.a.identity.name, email: world.a.identity.email }, actor: { kind: 'agent', client: 'test', nonce: 'n' } }, async (draft) => {
        const text = `---\nname: port-picking\ndescription: Pick free ports in tests.\n---\n${PROPOSAL_TEXT}\n`;
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
          claims: { rationale: PROPOSAL_TEXT, failures: [], expected_signal: PROPOSAL_TEXT, provenance: PROPOSAL_TEXT },
          flags: [],
          tokens: [],
          run: 'cr-test',
          origin: 'session',
          isolation: 'claude-chore-agent',
          unverified: { client: null, model: null },
          actor: { kind: 'agent' },
          at: draft.now.toISOString(),
          text,
        });
        return { result: null };
      });
    } finally {
      await tracker.close();
    }
  }

  const pickup = (root: string, value: string) => putMachineSetting(path.join(root, '.git'), 'knowledge.pickup', value);

  /**
   * The line each client is given (no skills were written, so Claude Code gets it plain too). Unbudgeted,
   * like `hook()`: on a loaded machine the 7 s budget would drop the chore facts; the budget has its own tests.
   */
  async function lines(root: string, fixtures: readonly string[] = [CLAUDE[0]!, CODEX[0]!]): Promise<string[]> {
    return Promise.all(fixtures.map((fixture) => sessionStart(readFixture(fixture), { startDir: root, fastPathBudgetMs: Number.POSITIVE_INFINITY })));
  }

  function expectLine(output: string[], line: string): void {
    expect(output).toEqual([`${line}\n`, `${line}\n`]);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).not.toContain(PROPOSAL_TEXT);
    expect(line.toLowerCase()).not.toContain('wiki');
  }

  gitTest('a due chore: the pickup text of this machine’s knowledge.pickup, ask by default', async ({ world }) => {
    const root = await setUp(world);
    await choreDue(world);

    expectLine(await lines(root), ASK);
    await pickup(root, 'auto');
    expectLine(await lines(root), AUTO);
    await pickup(root, 'manual');
    expectLine(await lines(root), MANUAL);
  });

  gitTest('a due chore with a proposal pending notes the proposal; a proposal alone says it awaits review; nothing due or pending says nothing', async ({ world }) => {
    const root = await setUp(world);
    expect(await lines(root)).toEqual(['', '']);

    await proposalPending(world);
    expectLine(await lines(root), PROPOSAL_ALONE);

    await choreDue(world);
    expectLine(await lines(root), `${ASK.slice(0, -1)}; 1 skill proposal awaits review`);
    await pickup(root, 'manual');
    expectLine(await lines(root), 'grimoire: a maintenance chore is due; 1 skill proposal awaits review');
  });

  gitTest('past the hook’s budget it stops waiting for the chore facts: no chore line, and the hook still answers', async ({ world }) => {
    const root = await setUp(world);
    await choreDue(world);

    expect(await hook(root, CLAUDE[0]!, 0)).toEqual({ code: 0, output: '' });
    expect(await hook(root, CLAUDE[0]!)).toEqual({ code: 0, output: `${ASK}\n` });
  });

  gitTest('a chore-facts read that started and overran the budget: the hook answers at the budget without the chore line, and leaves the read as late work its process won’t wait for', async ({ world }) => {
    const root = await setUp(world);
    await choreDue(world);
    let finish!: (facts: null) => void;
    const read = new Promise<null>((resolve) => (finish = resolve));
    let started = false;

    const output = await sessionStart(readFixture(CLAUDE[0]!), {
      startDir: root,
      fastPathBudgetMs: 1_500,
      readKnowledge: () => {
        started = true;
        return read;
      },
    });

    expect(started).toBe(true);
    expect(output).toBe('');
    const left = lateWork();
    expect(left).toBeGreaterThanOrEqual(1);
    finish(null);
    await read;
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateWork()).toBeLessThan(left);
  });

  /** This test process, recorded as a `grimoire mcp` of `client` serving `worktree` on `pin` (as a server started before a pull records itself). */
  async function serverRecorded(root: string, worktree: string, pin: string, client: string | null = null) {
    return new MachineLocalStore(path.join(root, '.git')).processes.register({ role: 'mcp', client, worktree, pin, pathSource: null });
  }

  const OLD_PIN = '0.9.0';
  const MISMATCH = `grimoire: this checkout now pins ${VERSION}; this session runs ${OLD_PIN}; restart it`;
  const CARRIED_OVER = ['clear', 'compact', 'resume'].map((name) => `claude-code/hook-payloads/session-start-${name}.json`);
  const CODEX_RESUME = 'codex/hook-payloads/session-start-resume.json';

  gitTest('a server still running an older pin in this worktree, carried over a clear, compact or resume, is the pin mismatch (§8’s notice); it outranks a due chore', async ({ world }) => {
    const root = await setUp(world);
    await choreDue(world);
    const server = await serverRecorded(root, root, OLD_PIN);
    try {
      const fixtures = [...CARRIED_OVER, CODEX_RESUME];
      expect(await lines(root, fixtures)).toEqual(fixtures.map(() => `${MISMATCH}
`));
      expect(MISMATCH.length).toBeLessThanOrEqual(200);
      // A fresh start launches its own server on the checkout's pin: an old one belongs to another session.
      expectLine(await lines(root), ASK);
    } finally {
      await server.unregister();
    }
    expectLine(await lines(root, [CARRIED_OVER[0]!, CODEX_RESUME]), ASK);
  });

  gitTest('a server on the checkout’s pin, one serving another worktree, or one another client runs, is no mismatch here', async ({ world }) => {
    const root = await setUp(world);
    const other = await world.a.addWorktree('elsewhere');
    const servers = [
      await serverRecorded(root, root, VERSION),
      await serverRecorded(root, other.dir, OLD_PIN),
      await serverRecorded(root, root, OLD_PIN, 'codex-mcp-client'),
    ];
    try {
      expect(await lines(root, CARRIED_OVER)).toEqual(['', '', '']);
      // The Codex server's own session does see it.
      expect(await lines(root, [CODEX_RESUME])).toEqual([`${MISMATCH}
`]);
    } finally {
      await Promise.all(servers.map((server) => server.unregister()));
    }
  });

  gitTest('a due chore outranks stray edits and refreshed pointer files', async ({ world }) => {
    const root = await setUp(world);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');
    await world.a.git(['commit', '--quiet', '-am', 'my edits']);
    await runUpkeep({ root });
    expectLine(await lines(root), 'grimoire refreshed 1 pointer file: commit it');

    await choreDue(world);
    expectLine(await lines(root), ASK);
  });

  it('the not-joined notice comes first, then the pin mismatch; a chore line drops the proposal note rather than pass 200 characters', () => {
    expect(sessionLine({ notJoined: 'not joined', pinMismatch: 'mismatch', choreDue: 'ask', proposalsPending: 1, last: 'strays' })).toBe('not joined');
    expect(sessionLine({ pinMismatch: 'mismatch', choreDue: 'ask', proposalsPending: 1, last: 'strays' })).toBe('mismatch');
    expect(sessionLine({ choreDue: 'auto', proposalsPending: 2 })).toBe(`${AUTO.slice(0, -1)}; 2 skill proposals await review`);
    expect(sessionLine({ proposalsPending: 0, last: 'strays' })).toBe('strays');
    expect(sessionLine({})).toBeNull();
    for (const choreDue of ['ask', 'auto', 'manual'] as const) {
      for (const proposalsPending of [0, 1, 16]) expect(sessionLine({ choreDue, proposalsPending })!.length).toBeLessThanOrEqual(200);
    }
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
