// Seam 3 (spec Testing Decisions; §11, §12): `init` as a person runs it, from
// grimoire packed with npm and installed the way npx installs it, in temporary
// clones with a bare remote. Each test asserts what init left behind: the
// tracker and its remote, the checkout's files, and the machine-local side.
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, runCommand } from '#harness';
import { readJoinRecord } from '../../src/installer';
import { readManifest } from '../../src/installer/manifest';
import { MachineLocalStore } from '../../src/machine-local';
import { cli, cliAtTerminal, humanEnv } from '../surfaces/cli/support';
import { initializeTracker } from '../core/support';
import { npxInstall, packGrimoire } from './support';

/** A version no build of the working tree reports, so only the packed package can answer with it. */
const PIN = '1.0.0-test.1';

let packed: Awaited<ReturnType<typeof packGrimoire>> | undefined;
let npxDir: string | undefined;
/** The bin of the package as npx installed it. */
let bin = '';
beforeAll(async () => {
  packed = await packGrimoire(PIN);
  npxDir = await makeTempDir('grimoire-npx-');
  bin = npxInstall(packed.tarball, npxDir);
}, 240_000);
afterAll(async () => {
  await packed?.cleanup();
  if (npxDir) await removeDir(npxDir);
});

/** `npx @goksening/grimoire@PIN init …` in `cwd`, without a terminal. */
function init(cwd: string, args: readonly string[] = ['--yes'], env?: NodeJS.ProcessEnv) {
  return cli(bin, ['init', ...args], { cwd, ...(env ? { env } : {}) });
}

/** `git status --porcelain` paths, untracked files listed one by one. */
async function changedPaths(checkout: { git(args: readonly string[]): Promise<string> }): Promise<string[]> {
  const out = await checkout.git(['status', '--porcelain', '--untracked-files=all']);
  return out === '' ? [] : out.split('\n').map((line) => line.slice(3));
}

describe('a first install', () => {
  gitTest('with --yes mints a facts tracker, pushes it, writes exactly the planned files with config.yml last, and the manifest lists every entry', async ({ world }) => {
    const root = world.a.dir;
    // A doc that describes another tracker: --yes declines making grimoire the tracker.
    await world.a.commitFile('docs/agents/issue-tracker.md', '# Issue tracker: GitHub\n\nIssues live on GitHub.\n');

    const run = await init(root);

    expect(run.code, run.stdout + run.stderr).toBe(0);
    const report = run.json as Record<string, any>;

    // The tracker: minted with the facts mode and every store setting, then pushed.
    const tip = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);
    const trackerRoot = await world.a.git(['rev-list', '--max-parents=0', tip]);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe(`${tip}\trefs/heads/grimoire/tracker`);
    const settings = await world.a.git(['show', `${tip}:settings.yml`]);
    expect(settings).toMatch(/^excerpts: \{"value":"facts",/m);
    for (const key of ['auto-sync', 'link_base', 'skills.delivery', 'skills.max_active', 'skills.description_max']) {
      expect(settings).toContain(`${key}: {"value":`);
    }
    expect(report.tracker).toMatchObject({ action: 'minted', root: trackerRoot, excerpt_mode: 'facts', sync: 'pushed' });

    // The checkout: exactly the planned files, config.yml last.
    const expected = [
      '.grimoire/.gitattributes',
      '.grimoire/run.cjs',
      '.mcp.json',
      '.claude/settings.json',
      '.claude/rules/grimoire.md',
      '.codex/config.toml',
      'AGENTS.md',
      'docs/agents/triage-labels.md',
      '.grimoire/manifest.yml',
      '.grimoire/config.yml',
    ];
    expect(report.written).toEqual(expected);
    expect(new Set(await changedPaths(world.a))).toEqual(new Set(expected));
    const planned = (report.plan.files as { path: string; action: string }[]).filter((entry) => entry.action !== 'skip').map((entry) => entry.path);
    expect(new Set(planned)).toEqual(new Set(expected.slice(0, -2)));
    const configTime = (await stat(path.join(root, '.grimoire/config.yml'))).mtimeMs;
    for (const file of expected) expect((await stat(path.join(root, file))).mtimeMs).toBeLessThanOrEqual(configTime);

    const configText = await readFile(path.join(root, '.grimoire/config.yml'), 'utf8');
    expect(configText).toMatch(new RegExp(`^version: ${PIN.replace(/\./g, '\\.')}$`, 'm'));
    expect(configText).toMatch(/^install_format: 1$/m);
    expect(configText).toMatch(new RegExp(`^tracker_root: ${trackerRoot}$`, 'm'));
    expect(configText).toMatch(/^adapter: declined$/m);
    expect(await readFile(path.join(root, 'docs/agents/issue-tracker.md'), 'utf8')).toBe('# Issue tracker: GitHub\n\nIssues live on GitHub.\n');

    const manifest = await readManifest(root);
    expect(new Set(manifest.entries.map((entry) => entry.path))).toEqual(new Set(expected.slice(0, -2)));
    expect(existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(path.join(root, 'package.json'))).toBe(false);

    // The machine side: the copy with npm's integrity, the launcher and the join record.
    const store = new MachineLocalStore(path.join(root, '.git'));
    const complete = JSON.parse(await readFile(path.join(store.dir, 'pkg', PIN, '.complete'), 'utf8')) as { integrity: string };
    expect(complete.integrity).toBe(packed!.integrity);
    expect(existsSync(path.join(store.dir, 'launcher.cjs'))).toBe(true);
    expect(await readJoinRecord(store, PIN)).toMatchObject({ excerpt_mode: 'facts' });

    // And it runs: the shell shim reaches the pinned copy, which reads the new tracker.
    const listed = await runCommand(process.execPath, ['.grimoire/run.cjs', 'list'], { cwd: root, env: humanEnv() });
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ rows: [], total: 0 });
  });
});

/** Snapshot of every file under `root` but .git: path → mtime. */
async function fileTimes(root: string): Promise<Map<string, number>> {
  const { readdir } = await import('node:fs/promises');
  const times = new Map<string, number>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else times.set(path.relative(root, file), (await stat(file)).mtimeMs);
    }
  };
  await walk(root);
  return times;
}

describe('a join', () => {
  gitTest('a second clone adopts the same tracker root, writes its join record, shows the disclosure and changes no checkout file; a re-run writes nothing', async ({ world }) => {
    expect((await init(world.a.dir)).code).toBe(0);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    await world.a.git(['push', '--quiet', 'origin', 'main']);
    const trackerRoot = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    const before = await fileTimes(world.b.dir);

    const joined = await init(world.b.dir);

    expect(joined.code, joined.stdout + joined.stderr).toBe(0);
    const report = joined.json as Record<string, any>;
    expect(report.tracker).toMatchObject({ action: 'present', root: trackerRoot, excerpt_mode: 'facts' });
    expect(report.written).toEqual([]);
    expect(report.disclosure[0]).toBe('Excerpt mode: facts.');
    expect(joined.stderr).toContain('Excerpt mode: facts.');
    expect(joined.stderr).toContain('Pushed history can’t be purged.');
    expect(await changedPaths(world.b)).toEqual([]);
    expect(await fileTimes(world.b.dir)).toEqual(before);
    const store = new MachineLocalStore(path.join(world.b.dir, '.git'));
    const record = await readJoinRecord(store, PIN);
    expect(record).toMatchObject({ excerpt_mode: 'facts' });
    expect(report.machine).toMatchObject({ copy: 'installed', launcher: 'written', join_record: 'written' });
    // Bob's clone reads the same tracker through its own pinned copy.
    const listed = await runCommand(process.execPath, ['.grimoire/run.cjs', 'list'], { cwd: world.b.dir, env: humanEnv() });
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);

    const again = await init(world.b.dir);

    expect(again.code).toBe(0);
    const rerun = again.json as Record<string, any>;
    expect(rerun.written).toEqual([]);
    expect(rerun.machine).toMatchObject({ copy: 'present', launcher: 'kept', join_record: 'unchanged' });
    expect(new Set((rerun.plan.files as { action: string }[]).map((entry) => entry.action))).toEqual(new Set(['unchanged']));
    expect(await readJoinRecord(store, PIN)).toEqual(record);
    expect(await fileTimes(world.b.dir)).toEqual(before);
  });
});

describe('at an interactive terminal', () => {
  gitTest('a first install shows the plan and the disclosure, asks once, and mints the tracker with the chosen mode', { timeout: 120_000 }, async ({ world }) => {
    const run = await cliAtTerminal(bin, ['init'], {
      cwd: world.a.dir,
      answers: [
        { when: /Configure which agent clients\?.*\(default: both\)/, type: '' },
        { when: /Excerpt mode for the new tracker\?.*\(default: excerpts\)/, type: 'excerpts' },
        { when: /The most this machine’s sessions may capture\?.*\(default: excerpts\)/, type: 'facts' },
        { when: /Go ahead\? \[y\/N\]/, type: 'y' },
      ],
    });

    expect(run.code, run.screen).toBe(0);
    // Everything was shown before the one question that lets init write.
    const asked = run.screen.indexOf('Go ahead?');
    for (const shown of ['Tracker: mint a new tracker with excerpt mode excerpts', 'Files:', 'Grants:', 'Pushed history can’t be purged.', 'Storage:', 'must exempt grimoire/tracker']) {
      expect(run.screen.indexOf(shown), shown).toBeGreaterThanOrEqual(0);
      expect(run.screen.indexOf(shown), shown).toBeLessThan(asked);
    }
    const settings = await world.a.git(['show', 'refs/grimoire/tracker:settings.yml']);
    expect(settings).toMatch(/^excerpts: \{"value":"excerpts",/m);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).not.toBe('');
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    expect(await readJoinRecord(store, PIN)).toMatchObject({ excerpt_mode: 'excerpts' });
    // The join offered the machine cap, which lowers only this machine's capture.
    expect(await store.records.read('machine-settings', 'capture.excerpts_max')).toBe('facts');
    // No adapter doc: init made one, with grimoire's block.
    expect(await readFile(path.join(world.a.dir, 'docs/agents/issue-tracker.md'), 'utf8')).toContain('# Issue tracker: grimoire');
    expect(await readFile(path.join(world.a.dir, '.grimoire/config.yml'), 'utf8')).toMatch(/^adapter: grimoire$/m);
  });

  gitTest('declining the consent writes nothing: no tracker, no files, no version copy', { timeout: 120_000 }, async ({ world }) => {
    const run = await cliAtTerminal(bin, ['init', '--clients', 'codex', '--excerpts', 'none'], {
      cwd: world.a.dir,
      answers: [{ when: /Go ahead\? \[y\/N\]/, type: 'n' }],
    });

    expect(run.code, run.screen).toBe(1);
    expect(run.screen).toContain('nothing changed');
    expect(await changedPaths(world.a)).toEqual([]);
    expect((await world.a.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker'])).code).not.toBe(0);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire', 'pkg'))).toBe(false);
  });
});

describe('the gate', () => {
  gitTest('agent markers are refused, and so is a run without a terminal and without --yes; neither writes anything', async ({ world }) => {
    const marked = await init(world.a.dir, ['--yes'], humanEnv({ AI_AGENT: 'claude-code_2-1-296_agent' }));
    expect(marked.code).toBe(1);
    expect(marked.json.error).toMatchObject({ code: 'HUMAN_ONLY' });
    expect(JSON.stringify(marked.json.error)).not.toContain('AI_AGENT');

    const unattended = await init(world.a.dir, []);
    expect(unattended.code).toBe(1);
    expect(unattended.json.error).toMatchObject({ code: 'HUMAN_ONLY', message: expect.stringContaining('--yes') });

    expect(await changedPaths(world.a)).toEqual([]);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).toBe('');
  });

  gitTest('--new-tracker never runs with --yes or without a terminal, and at a terminal it needs the typed confirmation', { timeout: 180_000 }, async ({ world }) => {
    expect((await init(world.a.dir)).code).toBe(0);
    const oldRoot = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);

    const withYes = await init(world.a.dir, ['--new-tracker', '--yes']);
    expect(withYes.code).toBe(2);
    const piped = await init(world.a.dir, ['--new-tracker']);
    expect(piped.code).toBe(1);
    expect(piped.json.error).toMatchObject({ code: 'HUMAN_ONLY' });

    const wrong = await cliAtTerminal(bin, ['init', '--new-tracker'], {
      cwd: world.a.dir,
      answers: [{ when: /Type new-tracker to confirm/, type: 'yes' }],
    });
    expect(wrong.code, wrong.screen).toBe(1);
    expect(wrong.screen).toContain('nothing changed');
    expect(await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker'])).toBe(oldRoot);

    const confirmed = await cliAtTerminal(bin, ['init', '--new-tracker'], {
      cwd: world.a.dir,
      answers: [
        { when: /Type new-tracker to confirm/, type: 'new-tracker' },
        { when: /Configure which agent clients\?/, type: '' },
        { when: /Excerpt mode for the new tracker\?/, type: 'none' },
        { when: /Go ahead\? \[y\/N\]/, type: 'y' },
      ],
    });
    expect(confirmed.code, confirmed.screen).toBe(0);
    const newRoot = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    expect(newRoot, confirmed.screen).not.toBe(oldRoot);
    expect(await readFile(path.join(world.a.dir, '.grimoire/config.yml'), 'utf8')).toMatch(new RegExp(`^tracker_root: ${newRoot}$`, 'm'));
    expect(await world.a.git(['show', 'refs/grimoire/tracker:settings.yml'])).toMatch(/^excerpts: \{"value":"none",/m);
    // The remote's tracker branch is the new root's history now.
    const remoteTip = (await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    expect(await world.a.git(['rev-list', '--max-parents=0', remoteTip])).toBe(newRoot);
  });
});

describe('a remote without a default branch', () => {
  gitTest('gets a sync-pending tracker, not a push', async ({ world }) => {
    const empty = path.join(world.root, 'empty.git');
    await runCommand('git', ['init', '--quiet', '--bare', empty], { cwd: world.root });
    const clone = path.join(world.root, 'c');
    const cloned = await runCommand('git', ['clone', '--quiet', '-c', 'user.name=Carol', '-c', 'user.email=carol@example.com', empty, clone], { cwd: world.root });
    expect(cloned.code, cloned.stderr).toBe(0);

    const run = await init(clone);

    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect((run.json as Record<string, any>).tracker).toMatchObject({ action: 'minted', sync: 'pending', sync_reason: 'no-default-branch' });
    const remoteRefs = await runCommand('git', ['ls-remote', empty], { cwd: world.root });
    expect(remoteRefs.stdout.trim()).toBe('');
    const tip = (await runCommand('git', ['rev-parse', 'refs/grimoire/tracker'], { cwd: clone })).stdout.trim();
    const store = new MachineLocalStore(path.join(clone, '.git'));
    expect((await store.coordination.list<{ tip: string }>('sync-pending')).map((entry) => entry.value.tip)).toEqual([tip]);
  });
});

describe('the tracker root R', () => {
  gitTest('a kept local tracker and a remote one with different roots stop init, naming both, before anything is written', async ({ world }) => {
    expect((await init(world.a.dir)).code).toBe(0);
    const remoteRoot = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    const localRoot = await initializeTracker(world.b, world.b);

    const run = await init(world.b.dir);

    expect(run.code).toBe(1);
    expect(run.json.error).toMatchObject({ code: 'NOT_SYNCED', details: { local_root: localRoot, remote_root: remoteRoot } });
    expect(await changedPaths(world.b)).toEqual([]);
    expect(existsSync(path.join(world.b.dir, '.git', 'grimoire', 'pkg'))).toBe(false);
  });

  gitTest('a remote init can’t reach is never taken for one without a tracker: nothing is minted', async ({ world }) => {
    await world.a.git(['remote', 'set-url', 'origin', path.join(world.root, 'gone.git')]);

    const run = await init(world.a.dir);

    expect(run.code).toBe(1);
    expect(run.json.error).toMatchObject({ code: 'NOT_SYNCED', details: { remote: 'origin', remedy: expect.any(String) } });
    expect((await world.a.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker'])).code).not.toBe(0);
    expect(await changedPaths(world.a)).toEqual([]);
  });

  gitTest('a join whose named tracker isn’t anywhere finishes everything else and reports NOT_SYNCED with the remedy', async ({ world }) => {
    expect((await init(world.a.dir)).code).toBe(0);
    const trackerRoot = await world.a.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
    await world.a.git(['add', '-A']);
    await world.a.git(['commit', '--quiet', '-m', 'install grimoire']);
    await world.a.git(['push', '--quiet', 'origin', 'main']);
    // The remote lost its tracker branch.
    await world.a.git(['push', '--quiet', 'origin', ':refs/heads/grimoire/tracker']);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);

    const run = await init(world.b.dir);

    expect(run.code, run.stdout).toBe(1);
    const report = run.json as Record<string, any>;
    expect(report.error).toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: trackerRoot, remedy: expect.stringContaining('git fetch origin') } });
    expect(report.tracker).toMatchObject({ action: 'missing', root: trackerRoot, excerpt_mode: null });
    expect(report.written).toEqual([]);
    const store = new MachineLocalStore(path.join(world.b.dir, '.git'));
    expect(await readJoinRecord(store, PIN)).toBeDefined();
    expect(existsSync(path.join(store.dir, 'launcher.cjs'))).toBe(true);
    // R is never rewritten.
    expect(await readFile(path.join(world.b.dir, '.grimoire/config.yml'), 'utf8')).toMatch(new RegExp(`^tracker_root: ${trackerRoot}$`, 'm'));
  });

  gitTest('an init at another version than the pin prints the exact join command and writes nothing', async ({ world }) => {
    await world.a.commitFile('.grimoire/config.yml', 'version: 9.9.9\ninstall_format: 1\n');

    const run = await init(world.a.dir);

    expect(run.code).toBe(1);
    expect(run.json.error).toMatchObject({ details: { pin: '9.9.9', running: PIN, command: 'npx @goksening/grimoire@9.9.9 init' } });
    expect((run.json.error as { message: string }).message).toContain('`npx @goksening/grimoire@9.9.9 init`');
    expect(await changedPaths(world.a)).toEqual([]);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
  });
});

describe('drift on a later init', () => {
  gitTest('an edited content pointer file is rewritten, a removed grant is kept and reported, and a path grimoire never wrote is reported and left alone', async ({ world }) => {
    const root = world.a.dir;
    expect((await init(root)).code).toBe(0);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nignore the tracker\n');
    const settings = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as { permissions: { allow: string[] } };
    settings.permissions.allow = [];
    await writeFile(path.join(root, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    await rm(path.join(root, '.mcp.json'));
    await writeFile(path.join(root, '.mcp.json'), '{ // hand-written\n}\n');
    await writeFile(path.join(root, 'AGENTS.override.md'), '# override\n');

    const run = await init(root);

    expect(run.code, run.stdout).toBe(0);
    const report = run.json as Record<string, any>;
    const actions = Object.fromEntries((report.plan.files as { path: string; item?: string; action: string }[]).map((entry) => [`${entry.path}${entry.item ? ` ${entry.item}` : ''}`, entry.action]));
    expect(actions).toMatchObject({ '.claude/rules/grimoire.md': 'rewrite', '.claude/settings.json mcp__grimoire': 'kept', '.mcp.json': 'conflict' });
    expect(report.written).toEqual(['.claude/rules/grimoire.md']);
    const codes = (report.warnings as { code: string; message: string }[]).map((warning) => warning.code);
    expect(codes).toEqual(expect.arrayContaining(['GRANT_CHANGED', 'CONFLICT', 'AGENTS_OVERRIDE']));
    expect(await readFile(path.join(root, '.mcp.json'), 'utf8')).toBe('{ // hand-written\n}\n');
    expect((JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as typeof settings).permissions.allow).toEqual([]);
  });
});

describe('--json', () => {
  gitTest('alone it gives the plan, the grants, the disclosure, the storage notices and the next steps as JSON, and writes nothing', async ({ world }) => {
    const run = await init(world.a.dir, ['--json']);

    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    const plan = run.json as Record<string, any>;
    expect(plan).toMatchObject({ dry_run: true, version: PIN, tracker: { action: 'minted', root: null, excerpt_mode: 'facts' }, written: [], machine: null });
    expect((plan.plan.files as { path: string; action: string }[]).map((entry) => entry.path)).toContain('.mcp.json');
    expect(plan.plan.files.filter((entry: { permission?: boolean; action: string }) => entry.action === 'create').length).toBeGreaterThan(0);
    expect(plan.plan.config).toBe('create');
    expect(plan.disclosure).toContain('Pushed history can’t be purged.');
    expect(plan.storage_notices.join('\n')).toContain('must exempt grimoire/tracker');
    expect(plan.next_steps.join('\n')).toContain('/hooks');
    expect(await changedPaths(world.a)).toEqual([]);
    expect((await world.a.gitResult(['rev-parse', '--verify', '--quiet', 'refs/grimoire/tracker'])).code).not.toBe(0);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);

    const applied = await init(world.a.dir, ['--json', '--yes']);
    expect(applied.code).toBe(0);
    expect(applied.stderr).toBe('');
    expect((applied.json as Record<string, any>).written.at(-1)).toBe('.grimoire/config.yml');
  });
});

describe('the remote', () => {
  gitTest('with several remotes and no tracker on any, init takes origin under --yes and saves the choice', async ({ world }) => {
    const backup = path.join(world.root, 'backup.git');
    await runCommand('git', ['init', '--quiet', '--bare', backup], { cwd: world.root });
    await world.a.git(['remote', 'add', 'backup', backup]);

    const run = await init(world.a.dir);

    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect((run.json as Record<string, any>).remote).toMatchObject({ name: 'origin', saved: true });
    expect(await world.a.git(['config', 'grimoire.remote'])).toBe('origin');
    expect(await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).not.toBe('');
    expect((await runCommand('git', ['ls-remote', backup], { cwd: world.root })).stdout.trim()).toBe('');
  });
});
