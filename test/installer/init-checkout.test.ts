// Seam 1 for `init` (spec Testing Decisions; §11, §12), continued from
// init-rules.test.ts: upkeep in init, what init leaves alone and warns about,
// the next steps, the plan shown before consent, and the remote.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, runCommand } from '#harness';
import { installCopy, listCopies, readJoinRecord } from '../../src/installer';
import { instructionRulesText } from '../../src/installer/texts';
import { worktreeLeaseName } from '../../src/upkeep';
import { installed } from '../upkeep/support';
import { readManifest } from '../../src/installer/manifest';
import { codexHookHash } from '../../src/installer/pointers';
import { MachineLocalStore } from '../../src/machine-local';
import { reportingPackage } from './support';
import { VERSION, initIn, installAndPush, cloneOfEmptyRemote } from './init-rules-support';

describe('upkeep in init', () => {
  gitTest('init runs upkeep last: copies nothing needs are pruned, the one it installed stays, and drifted pointer files elsewhere on the pin are refreshed', async ({ world }) => {
    const root = world.a.dir;
    const store = new MachineLocalStore(path.join(root, '.git'));
    await installCopy(store, '0.9.0', { dir: await reportingPackage(world.root, '0.9.0'), integrity: null });
    await installCopy(store, '2.0.0', { dir: await reportingPackage(world.root, '2.0.0'), integrity: null });
    const linked = await world.a.addWorktree('feature');
    await installed(linked.dir, VERSION);
    await writeFile(path.join(linked.dir, '.claude/rules/grimoire.md'), 'drifted\n');

    const { report, said } = await initIn(root);

    expect(report.machine?.pruned).toEqual(['2.0.0']);
    expect((await listCopies(store)).map((copy) => copy.version)).toEqual(['0.9.0', VERSION]);
    expect(report.upkeep?.runs).toContainEqual(expect.objectContaining({ part: 'pointer-refresh', status: 'ran', worktree: expect.stringContaining('feature') }));
    expect(await readFile(path.join(linked.dir, '.claude/rules/grimoire.md'), 'utf8')).toBe(instructionRulesText());
    expect(said).toMatch(/grimoire refreshed 1 pointer file in .*feature: commit it/);
  });

  gitTest('init waits for upkeep (or doctor --fix) holding this worktree before it writes the checkout, recorded as running its version', async ({ world }) => {
    const root = world.a.dir;
    const store = new MachineLocalStore(path.join(root, '.git'));
    const held = await store.leases.acquire(await worktreeLeaseName(root), { ttlMs: 60_000 });
    if (held.status !== 'acquired') throw new Error('lease not taken');

    let settled = false;
    const running = initIn(root).finally(() => (settled = true));
    // From before it installs its copy until config.yml pins it, init's process record keeps that copy from any pruner.
    await expect.poll(async () => (await store.processes.live({ role: 'init' })).map((record) => [record.pin, record.worktree]), { timeout: 20_000 }).toEqual([
      [VERSION, root],
    ]);
    // Well past what init takes on its own, it still waits, and has written nothing.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(settled).toBe(false);
    expect(existsSync(path.join(root, '.grimoire', 'config.yml'))).toBe(false);
    expect(existsSync(path.join(root, '.claude', 'rules', 'grimoire.md'))).toBe(false);
    await held.lease.release();
    const { report } = await running;

    expect(report.written).toContain('.grimoire/config.yml');
    expect(await store.processes.live({ role: 'init' })).toEqual([]);
  });
});

describe('what init leaves alone and warns about', () => {
  gitTest('an existing triage-labels doc is left alone, a rules file grimoire never wrote is a conflict left byte for byte, and a large AGENTS.md is warned about', async ({ world }) => {
    const root = world.a.dir;
    await world.a.commitFile('docs/agents/triage-labels.md', 'our labels\n');
    await world.a.commitFile('.claude/rules/grimoire.md', 'my rules\r\n');
    await world.a.commitFile('AGENTS.md', `# Agents\n\n${'Be kind to the build.\n'.repeat(1300)}`);

    const { report } = await initIn(root);

    const actions = Object.fromEntries(report.plan.files.filter((entry) => entry.kind !== 'json-array-item').map((entry) => [entry.path, entry.action]));
    expect(actions).toMatchObject({ 'docs/agents/triage-labels.md': 'skip', '.claude/rules/grimoire.md': 'conflict', 'AGENTS.md': 'create' });
    const codes = report.warnings.map((warning) => warning.code);
    expect(codes).toEqual(expect.arrayContaining(['CONFLICT', 'AGENTS_SIZE']));
    expect(await readFile(path.join(root, 'docs/agents/triage-labels.md'), 'utf8')).toBe('our labels\n');
    expect(await readFile(path.join(root, '.claude/rules/grimoire.md'), 'utf8')).toBe('my rules\r\n');
    expect(report.written).not.toContain('.claude/rules/grimoire.md');
    expect((await readManifest(root)).entries.map((entry) => entry.path)).not.toContain('.claude/rules/grimoire.md');
  });

  gitTest('a re-run keeps the adapter block that was made the tracker above another tracker’s doc as the superseding one', async ({ world }) => {
    const root = world.a.dir;
    await world.a.commitFile('docs/agents/issue-tracker.md', '# Issue tracker: GitHub\n\nIssues live on GitHub.\n');
    await initIn(root, { answers: [
      { when: /agent clients/, type: 'both' },
      { when: /Make grimoire the tracker/, type: 'make' },
      { when: /Excerpt mode/, type: 'facts' },
      { when: /Go ahead/, type: 'y' },
    ] });
    const doc = await readFile(path.join(root, 'docs/agents/issue-tracker.md'), 'utf8');
    expect(doc).toContain('This section supersedes the rest of this file');

    const { report } = await initIn(root);

    expect(report.plan.files.find((entry) => entry.path === 'docs/agents/issue-tracker.md')?.action).toBe('unchanged');
    expect(await readFile(path.join(root, 'docs/agents/issue-tracker.md'), 'utf8')).toBe(doc);
  });

  gitTest('without a git user.email a mint is refused before anything is written, while a join only warns', async ({ world }) => {
    const refused = initIn(world.a.dir, { person: { name: 'Alice Example', email: null } });

    await expect(refused).rejects.toMatchObject({ code: 'NO_GIT_IDENTITY' });
    expect(existsSync(path.join(world.a.dir, '.grimoire'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);

    await installAndPush(world.a);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    const { report } = await initIn(world.b.dir, { person: { name: 'Bob Example', email: null } });

    expect(report.tracker.action).toBe('present');
    expect(report.warnings.map((warning) => warning.code)).toContain('NO_GIT_IDENTITY');
  });

  gitTest('in a linked worktree init warns that Codex runs the main checkout’s .codex/ until init has run there too', async ({ world }) => {
    const worktree = await world.a.addWorktree('feature');

    const before = await initIn(worktree.dir);
    await initIn(world.a.dir);
    const after = await initIn(worktree.dir);

    expect(before.report.warnings.map((warning) => warning.code)).toContain('CODEX_MAIN_CHECKOUT');
    expect(after.report.warnings.map((warning) => warning.code)).not.toContain('CODEX_MAIN_CHECKOUT');
  });

  gitTest('a clone with no remote mints a tracker that stays sync-pending until it has one', async ({ world }) => {
    const solo = path.join(world.root, 'solo');
    for (const args of [['init', '--quiet', solo], ['-C', solo, 'config', 'user.name', 'Sol'], ['-C', solo, 'config', 'user.email', 'sol@example.com']]) {
      expect((await runCommand('git', args, { cwd: world.root })).code).toBe(0);
    }

    const { report, said } = await initIn(solo);

    expect(said).toContain('then keep it sync-pending (no remote)');
    expect(report.remote).toMatchObject({ name: null, saved: false });
    expect(report.tracker).toMatchObject({ action: 'minted', sync: 'pending', sync_reason: 'no-remote' });
    expect(report.storage_notices[0]).toContain('once this clone has a remote');
    expect(report.warnings.map((warning) => warning.code)).toContain('SYNC_PENDING');
  });
});

describe('the next steps', () => {
  gitTest('name each client’s trust step: headless Claude Code needs --allowedTools, and Codex’s /hooks approval comes only while the hook group is new to this machine', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));

    const first = await initIn(world.a.dir);
    const again = await initIn(world.a.dir);

    expect(first.report.next_steps.join('\n')).toContain('--allowedTools mcp__grimoire');
    expect(first.report.next_steps.join('\n')).toContain('approve grimoire’s hook in `/hooks`');
    expect(await readJoinRecord(store, VERSION)).toMatchObject({ codex_hook_hash: codexHookHash() });
    expect(again.report.next_steps.join('\n')).toContain('Codex: trust this project');
    expect(again.report.next_steps.join('\n')).not.toContain('/hooks');
  });

  gitTest('say that `git stash --all` is unsupported while generated skill copies exist, and `git stash -u` is fine (spec §15)', async ({ world }) => {
    const { report } = await initIn(world.a.dir);

    expect(report.next_steps).toContainEqual(expect.stringMatching(/git stash -u.*never `git stash --all`/));
  });
});

describe('the plan shown before consent', () => {
  gitTest('a remote without a default branch: the plan says the new tracker stays sync-pending, as it then does', async ({ world }) => {
    const clone = await cloneOfEmptyRemote(world.root);

    const { report, said } = await initIn(clone);

    expect(said).toContain('Tracker: mint a new tracker with excerpt mode facts, then keep it sync-pending: origin has no default branch yet');
    expect(said).not.toContain('push it to origin');
    expect(report.tracker).toMatchObject({ action: 'minted', sync: 'pending', sync_reason: 'no-default-branch' });
  });
});

describe('the remote', () => {
  gitTest('a clone whose only remote is not origin pushes the minted tracker there and saves the choice, so later syncs find it', async ({ world }) => {
    await world.a.git(['remote', 'rename', 'origin', 'upstream']);

    const { report } = await initIn(world.a.dir);

    expect(report.remote).toMatchObject({ name: 'upstream', saved: true });
    expect(report.tracker).toMatchObject({ action: 'minted', sync: 'pushed' });
    expect(await world.a.git(['config', 'grimoire.remote'])).toBe('upstream');
    const tip = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);
    expect(await world.a.git(['ls-remote', 'upstream', 'refs/heads/grimoire/tracker'])).toBe(`${tip}\trefs/heads/grimoire/tracker`);
    expect(existsSync(path.join(world.a.dir, '.grimoire', 'config.yml'))).toBe(true);
  });
});
