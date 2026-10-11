// Seam 1 for `init` (spec Testing Decisions; §11, §12): the installer's runInit
// driven directly, in process, against temporary clones with a bare remote.
// The version copy comes from a small package folder, so no build is needed;
// the packed package as npx installs it is seam 3 (init.test.ts).
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, runCommand, type Checkout, type Clone } from '#harness';
import type { Identity } from '../../src/core/context';
import { readPerson } from '../../src/core/host';
import { BOOTSTRAP, installCopy, listCopies, readJoinRecord } from '../../src/installer';
import { instructionRulesText } from '../../src/installer/texts';
import { worktreeLeaseName } from '../../src/upkeep';
import { installed } from '../upkeep/support';
import { readManifest } from '../../src/installer/manifest';
import { codexHookHash } from '../../src/installer/pointers';
import { MachineLocalStore } from '../../src/machine-local';
import { runInit, type InitFlags, type InitReport, type Prompter } from '../../src/installer/init';
import { openTracker } from '../../src/tracker';
import { initializeTracker } from '../core/support';
import { reportingPackage } from './support';

const VERSION = '1.0.0-test.2';

const NO_FLAGS: InitFlags = { yes: true, clients: null, excerpts: null, newTracker: false, adapter: false };

interface InitRun {
  readonly report: InitReport;
  /** What init showed the person, joined. */
  readonly said: string;
}

/**
 * `init` in `root` as `runInit` runs it for the CLI. With no `answers` it runs
 * as under --yes; with `answers` each question is matched in turn and
 * answered, and a question nothing matches fails the test.
 */
async function initIn(
  root: string,
  options: { flags?: Partial<InitFlags>; answers?: { when: RegExp; type: string }[]; person?: Identity; dryRun?: boolean } = {},
): Promise<InitRun> {
  const said: string[] = [];
  const answers = options.answers ? [...options.answers] : null;
  const prompter: Prompter | null = answers
    ? {
        async ask(question) {
          said.push(question);
          const at = answers.findIndex((answer) => answer.when.test(question));
          if (at < 0) throw new Error(`unexpected question: ${question}`);
          return answers.splice(at, 1)[0]!.type;
        },
      }
    : null;
  const report = await runInit({
    root,
    flags: { ...NO_FLAGS, yes: answers === null, ...options.flags },
    source: { dir: await reportingPackage(path.dirname(root), VERSION), integrity: null },
    version: VERSION,
    person: options.person ?? (await readPerson(root)),
    nonce: 'test',
    prompter,
    say: (text) => said.push(text),
    ...(options.dryRun ? { dryRun: true } : {}),
  });
  return { report, said: said.join('\n') };
}

/** Mints a tracker in `clone` and commits and pushes what init wrote, as the person who installed grimoire does. */
async function installAndPush(clone: Clone, flags: Partial<InitFlags> = {}): Promise<{ report: InitReport; trackerRoot: string }> {
  const { report } = await initIn(clone.dir, { flags });
  await clone.git(['add', '-A']);
  await clone.git(['commit', '--quiet', '-m', 'install grimoire']);
  await clone.git(['push', '--quiet', 'origin', 'main']);
  return { report, trackerRoot: await clone.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']) };
}

/** A new tracker root minted in `clone` (as `init --new-tracker` does) and forced onto the remote's branch. */
async function replaceTrackerOnRemote(clone: Clone): Promise<string> {
  const store = await openTracker(clone.dir);
  try {
    const { root } = await store.initialize(
      { author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'human', client: 'cli', nonce: 'test' } },
      { replace: true },
    );
    await clone.git(['push', '--quiet', '--force', 'origin', 'refs/grimoire/tracker:refs/heads/grimoire/tracker']);
    return root;
  } finally {
    await store.close();
  }
}

/** The roots of the history at `rev`. */
async function rootsAt(checkout: Checkout, rev: string): Promise<string[]> {
  return (await checkout.git(['rev-list', '--max-parents=0', rev])).split('\n');
}

describe('the tracker root R', () => {
  gitTest('with R named, a remote tracker with another root stops init even though the local one holds R, and nothing is written', async ({ world }) => {
    const { trackerRoot } = await installAndPush(world.a);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    await world.b.git(['fetch', '--quiet', 'origin', '+refs/heads/grimoire/tracker:refs/grimoire/tracker']);
    // Someone ran init --new-tracker elsewhere; this checkout hasn't merged their config.yml yet.
    const otherRoot = await replaceTrackerOnRemote(world.a);

    const refused = initIn(world.b.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: trackerRoot, found: [otherRoot] } });
    expect(await rootsAt(world.b, 'refs/grimoire/tracker')).toEqual([trackerRoot]);
    expect(existsSync(path.join(world.b.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('with R named, a local tracker with another root stops init even though the remote one holds R', async ({ world }) => {
    const { trackerRoot } = await installAndPush(world.a);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    const localRoot = await initializeTracker(world.b, world.b);

    const refused = initIn(world.b.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: trackerRoot, found: [localRoot] } });
    expect(existsSync(path.join(world.b.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('a first install with a kept local tracker never adopts it while the remote can’t be read: its tracker might have another root', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    await world.a.git(['remote', 'set-url', 'origin', path.join(world.root, 'gone.git')]);

    const refused = initIn(world.a.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { remote: 'origin', remedy: expect.any(String) } });
    expect(existsSync(path.join(world.a.dir, '.grimoire'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('--new-tracker never folds the old history back in, even when the remote’s branch is gone and this clone still tracks it', async ({ world }) => {
    const { trackerRoot: oldRoot } = await installAndPush(world.a);
    // Someone deleted the remote's branch to start over; clone a still has its remote-tracking ref.
    await world.b.git(['push', '--quiet', 'origin', ':refs/heads/grimoire/tracker']);

    const { report } = await initIn(world.a.dir, {
      flags: { newTracker: true },
      answers: [
        { when: /Type new-tracker to confirm/, type: 'new-tracker' },
        { when: /Configure which agent clients\?/, type: '' },
        { when: /Excerpt mode for the new tracker\?/, type: 'none' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(report.tracker).toMatchObject({ action: 'replaced', sync: 'pushed' });
    const newRoot = report.tracker.root!;
    expect(newRoot).not.toBe(oldRoot);
    expect(await rootsAt(world.a, 'refs/grimoire/tracker')).toEqual([newRoot]);
    const remoteTip = (await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    expect(await rootsAt(world.a, remoteTip)).toEqual([newRoot]);
  });
});

describe('a join', () => {
  gitTest('a first install adopts the tracker another clone minted without committing, keeping its excerpt mode under --yes', async ({ world }) => {
    const minted = await initIn(world.a.dir, { flags: { excerpts: 'excerpts' } });
    const trackerRoot = minted.report.tracker.root!;

    const { report } = await initIn(world.b.dir);

    expect(report.tracker).toMatchObject({ action: 'adopted', root: trackerRoot, excerpt_mode: 'excerpts' });
    expect(report.disclosure[0]).toBe('Excerpt mode: excerpts.');
    expect(await readJoinRecord(new MachineLocalStore(path.join(world.b.dir, '.git')), VERSION)).toMatchObject({ excerpt_mode: 'excerpts' });
    expect(await readFile(path.join(world.b.dir, '.grimoire/config.yml'), 'utf8')).toMatch(new RegExp(`^tracker_root: ${trackerRoot}$`, 'm'));
    const remoteTip = (await world.b.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    expect(await rootsAt(world.b, remoteTip)).toEqual([trackerRoot]);
    expect(await world.b.git(['show', `${remoteTip}:settings.yml`])).toMatch(/^excerpts: \{"value":"excerpts",/m);
  });

  gitTest('a join at a terminal into a store that captures excerpts offers this machine’s cap, and changes no checkout file', async ({ world }) => {
    await installAndPush(world.a, { excerpts: 'excerpts' });
    await world.b.git(['pull', '--quiet', 'origin', 'main']);

    const { report } = await initIn(world.b.dir, {
      answers: [
        { when: /Configure which agent clients\?/, type: '' },
        { when: /The most this machine’s sessions may capture\?/, type: 'none' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(report.tracker).toMatchObject({ action: 'present', excerpt_mode: 'excerpts' });
    expect(report.machine).toMatchObject({ excerpts_max: 'none' });
    expect(await new MachineLocalStore(path.join(world.b.dir, '.git')).records.read('machine-settings', 'capture.excerpts_max')).toBe('none');
    expect(report.written).toEqual([]);
  });
});

describe('the clients', () => {
  gitTest('--clients narrows what is written; a join and a re-run under --yes keep to the clients the manifest records and write nothing in the checkout', async ({ world }) => {
    const { report } = await installAndPush(world.a, { clients: ['codex'] });
    expect(report.clients).toEqual(['codex']);
    for (const file of ['.mcp.json', '.claude', 'CLAUDE.md']) expect(existsSync(path.join(world.a.dir, file)), file).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.codex/config.toml'))).toBe(true);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);

    const joined = await initIn(world.b.dir);
    const rerun = await initIn(world.a.dir);

    expect(joined.report.clients).toEqual(['codex']);
    expect(joined.report.written).toEqual([]);
    expect(rerun.report.written).toEqual([]);
    expect(existsSync(path.join(world.b.dir, '.claude'))).toBe(false);
    expect(await world.b.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    // Any other MCP client gets the server command itself, not a file this checkout lacks.
    expect(joined.said).toContain(`node -e "${BOOTSTRAP}" mcp`);
    expect(joined.said).not.toContain('.mcp.json');
  });
});

describe('changed permission entries', () => {
  gitTest('a removed Codex block comes back without its grant, which init reports as GRANT_CHANGED and an interactive init offers to restore', async ({ world }) => {
    const root = world.a.dir;
    await initIn(root);
    await writeFile(path.join(root, '.codex/config.toml'), '# no grimoire here\n');

    const { report } = await initIn(root);

    expect(report.warnings).toContainEqual({ code: 'GRANT_CHANGED', message: expect.stringContaining('.codex/config.toml') });
    expect(report.written).toContain('.codex/config.toml');
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).not.toContain('default_tools_approval_mode');

    await writeFile(path.join(root, '.codex/config.toml'), '# no grimoire here\n');
    const { said } = await initIn(root, {
      answers: [
        { when: /Configure which agent clients\?/, type: '' },
        { when: /permission entries changed.*\.codex\/config\.toml.*Restore them\?/s, type: 'yes' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(said).toMatch(/Restore them\?/);
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toContain('default_tools_approval_mode = "approve"');
  });
});

/** A clone of a bare remote that has no branch yet, so no default branch. */
async function cloneOfEmptyRemote(root: string): Promise<string> {
  const empty = path.join(root, 'empty.git');
  await runCommand('git', ['init', '--quiet', '--bare', empty], { cwd: root });
  const clone = path.join(root, 'c');
  const cloned = await runCommand('git', ['clone', '--quiet', '-c', 'user.name=Carol', '-c', 'user.email=carol@example.com', empty, clone], { cwd: root });
  expect(cloned.code, cloned.stderr).toBe(0);
  return clone;
}

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
