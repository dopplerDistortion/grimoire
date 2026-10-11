// Seam 1 for `doctor`'s install checks and `--fix` (spec Testing Decisions;
// §12 doctor, §11, §13): runDoctor driven directly against checkouts installed
// the way `init` writes them, with this clone joined to the version under
// test. Each test injects defects the way a person, another tool or a crash
// leaves them, and asserts what the report says and what --fix repairs.
import { appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, type Checkout } from '#harness';
import { codexHookHash, UPGRADE_RECORDS } from '../../src/installer';
import { DOCTOR_CHECKS, runDoctor, type DoctorReport } from '../../src/installer/doctor';
import type { Finding } from '../../src/installer/health';
import { instructionRulesText } from '../../src/installer/texts';
import { MachineLocalStore, START_LOCK } from '../../src/machine-local';
import { refreshedPointerFiles, worktreeLeaseName } from '../../src/upkeep';
import { VERSION } from '../../src/version';
import { installed, read } from '../upkeep/support';
import { joinClone, reportingPackage } from './support';

function found(report: DoctorReport, kind: string): Finding[] {
  return report.findings.filter((finding) => finding.kind === kind);
}

const kinds = (report: DoctorReport, section: string) => [...new Set(report.findings.filter((finding) => finding.section === section).map((finding) => finding.kind))].sort();

/** A checkout installed and joined as `init` leaves it, with a Codex home of its own (no hook approved yet). */
async function setUp(checkout: Checkout): Promise<{ root: string; store: MachineLocalStore; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const root = checkout.dir;
  await installed(root);
  const store = new MachineLocalStore(path.join(root, '.git'));
  const parent = await makeTempDir('grimoire-doctor-');
  await joinClone(store, VERSION, { dir: await reportingPackage(parent, VERSION), integrity: null });
  const codexHome = path.join(parent, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  return { root, store, env: { ...withNodeOnPath(process.env), CODEX_HOME: codexHome }, cleanup: () => removeDir(parent) };
}

/** `env` with this test's `node` first on its PATH, as an agent client's would have it. */
function withNodeOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: `${path.dirname(process.execPath)}${path.delimiter}${env[key] ?? ''}` };
}

/** Each test installs a checkout and runs doctor more than once: room for a loaded machine. */
const SLOW = { timeout: 240_000 };

describe('install checks', SLOW, () => {
  gitTest('a checkout as init leaves it reports nothing but the Codex hook awaiting approval', async ({ world }) => {
    const { root, env, cleanup } = await setUp(world.a);
    try {
      const report = await runDoctor({ root, env });

      expect(kinds(report, 'install')).toEqual(['codex-hook-unapproved']);
      expect(found(report, 'codex-hook-unapproved')[0]).toMatchObject({
        severity: 'warning',
        details: { position: 0, expected_hash: codexHookHash(), declared_hash: codexHookHash() },
      });
    } finally {
      await cleanup();
    }
  });

  gitTest('pointer drift, content and permission-bearing; hooks compared by field; the shim; .gitattributes; client config conflicts', async ({ world }) => {
    const { root, env, cleanup } = await setUp(world.a);
    try {
      await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');
      const settings = JSON.parse(await read(root, '.claude/settings.json')) as Record<string, any>;
      settings.permissions.allow = settings.permissions.allow.filter((rule: string) => rule !== 'mcp__grimoire');
      settings.hooks.PreToolUse[0].hooks[0].timeout = 30;
      settings.hooks.SessionStart[0].hooks[0].command = 'nodejs';
      await writeFile(path.join(root, '.claude/settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
      const codex = await read(root, '.codex/config.toml');
      await writeFile(path.join(root, '.codex/config.toml'), codex.replace('default_tools_approval_mode = "approve"', 'default_tools_approval_mode = "prompt"').replace('timeout = 10', 'timeout = 11'));
      await appendFile(path.join(root, '.grimoire/run.cjs'), '// mine\n');
      await writeFile(path.join(root, '.grimoire/.gitattributes'), '* text=auto\n');
      await writeFile(path.join(root, '.mcp.json'), '{ "mcpServers": { // a comment\n } }\n');

      const report = await runDoctor({ root, env });

      expect(found(report, 'content-drift')).toEqual([expect.objectContaining({ subject: '.claude/rules/grimoire.md', fixable: true })]);
      expect(found(report, 'permission-drift').map((finding) => finding.subject).sort()).toEqual(['.claude/settings.json (mcp__grimoire)', '.codex/config.toml (grimoire)']);
      expect(found(report, 'permission-drift').every((finding) => !finding.fixable)).toBe(true);
      expect(found(report, 'hook-drift')).toEqual([
        expect.objectContaining({ subject: '.claude/settings.json (hooks.PreToolUse)', details: expect.objectContaining({ fields: ['hooks[0].timeout'] }) }),
        expect.objectContaining({ subject: '.claude/settings.json (hooks.SessionStart)', details: expect.objectContaining({ fields: ['hooks[0].command'] }) }),
        expect.objectContaining({ subject: '.codex/config.toml (hooks.SessionStart)', details: expect.objectContaining({ fields: ['hooks.SessionStart.hooks.timeout'] }) }),
      ]);
      expect(found(report, 'shim-drift')).toEqual([expect.objectContaining({ subject: '.grimoire/run.cjs', severity: 'error' })]);
      expect(found(report, 'gitattributes')).toEqual([expect.objectContaining({ subject: '.grimoire/.gitattributes' })]);
      expect(found(report, 'client-config-conflict')).toEqual([expect.objectContaining({ subject: '.mcp.json (mcpServers.grimoire)', message: expect.stringContaining('not valid JSON') })]);
    } finally {
      await cleanup();
    }
  });

  gitTest('the copy, the join record and the launcher; the Node a client used; running servers against the pin', async ({ world }) => {
    const { root, store, env, cleanup } = await setUp(world.a);
    try {
      await appendFile(path.join(store.dir, 'pkg', VERSION, 'dist', 'launch.mjs'), '// tampered\n');
      await writeFile(path.join(store.dir, 'pkg', VERSION, 'dist', 'extra.js'), 'added\n');
      const launcher = path.join(store.dir, 'launcher.cjs');
      await writeFile(launcher, (await readFile(launcher, 'utf8')).replace('LAUNCHER_VERSION = 1', 'LAUNCHER_VERSION = 9'));
      await store.records.write('client-runtime', 'codex-mcp-client', { client: 'codex-mcp-client', node: 'v20.11.0', path_source: 'C:\\old\\node', pin: VERSION, worktree: root, at: Date.now() });
      const server = await store.processes.register({ role: 'mcp', client: 'claude-code', worktree: root, pin: '9.9.9', pathSource: null });

      const report = await runDoctor({ root, env });
      await server.unregister();

      expect(found(report, 'copy-corrupt')).toEqual([
        expect.objectContaining({ severity: 'error', details: expect.objectContaining({ changed: ['dist/launch.mjs'], extra: ['dist/extra.js'], missing: [] }) }),
      ]);
      expect(found(report, 'launcher-corrupt')).toEqual([expect.objectContaining({ severity: 'error' })]);
      expect(found(report, 'node-too-old')).toEqual([expect.objectContaining({ subject: 'codex-mcp-client', details: expect.objectContaining({ node: 'v20.11.0' }) })]);
      expect(found(report, 'server-pin-mismatch')).toEqual([expect.objectContaining({ details: expect.objectContaining({ pin: '9.9.9', worktree_pin: VERSION, client: 'claude-code' }) })]);
    } finally {
      await cleanup();
    }
  });

  gitTest('stale leases and a stale start lock; AGENTS.md size and override; duplicate tracker docs', async ({ world }) => {
    const { root, store, env, cleanup } = await setUp(world.a);
    try {
      await store.leases.acquire('upkeep-prune-copies', { ttlMs: 1 });
      await store.locks.acquire(START_LOCK, { ttlMs: 1, data: { port: 47_001, nonce: 'n' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await appendFile(path.join(root, 'AGENTS.md'), `\n${'x'.repeat(25 * 1024)}\n`);
      await writeFile(path.join(root, 'AGENTS.override.md'), '# mine\n');
      await appendFile(path.join(root, '.grimoire/config.yml'), 'adapter: grimoire\n');
      await mkdir(path.join(root, 'docs/agents'), { recursive: true });
      await writeFile(path.join(root, 'docs/agents/issue-tracker-github.md'), '# Issues live on GitHub\n');

      const report = await runDoctor({ root, env });

      expect(found(report, 'stale-lease')).toEqual([expect.objectContaining({ subject: 'upkeep-prune-copies', fixable: true })]);
      expect(found(report, 'stale-start-lock')).toEqual([expect.objectContaining({ subject: START_LOCK, fixable: true })]);
      expect(found(report, 'agents-md-size')).toHaveLength(1);
      expect(found(report, 'agents-md-override')).toHaveLength(1);
      expect(found(report, 'duplicate-tracker-doc')).toEqual([expect.objectContaining({ subject: 'docs/agents/issue-tracker-github.md' })]);
    } finally {
      await cleanup();
    }
  });

  gitTest('the Codex hook: approved, modified since approval, and needs approval at a new position', async ({ world }) => {
    const { root, env, cleanup } = await setUp(world.a);
    try {
      const file = path.join(await import('node:fs/promises').then((fs) => fs.realpath(root)), '.codex', 'config.toml');
      const key = `${file}:session_start:0:0`;
      await writeFile(path.join(env.CODEX_HOME!, 'config.toml'), `model = "x"\n\n[hooks.state]\n\n[hooks.state.'${key}']\ntrusted_hash = "${codexHookHash()}"\n`);
      const approved = await runDoctor({ root, env });
      await writeFile(path.join(env.CODEX_HOME!, 'config.toml'), `[hooks.state.'${key}']\ntrusted_hash = "sha256:0000"\n`);
      const modified = await runDoctor({ root, env });
      const codex = await read(root, '.codex/config.toml');
      await writeFile(path.join(root, '.codex/config.toml'), `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo hi"\n\n${codex}`);
      await writeFile(path.join(env.CODEX_HOME!, 'config.toml'), `[hooks.state.'${key}']\ntrusted_hash = "${codexHookHash()}"\n`);
      const moved = await runDoctor({ root, env });

      expect(kinds(approved, 'install')).toEqual([]);
      expect(found(modified, 'codex-hook-modified')).toHaveLength(1);
      expect(found(moved, 'codex-hook-unapproved')).toEqual([expect.objectContaining({ details: expect.objectContaining({ position: 1, key: `${file}:session_start:1:0` }) })]);
    } finally {
      await cleanup();
    }
  });

  gitTest('a doctor of another version than the pin leaves the file comparisons to the pinned one', async ({ world }) => {
    const { root, env, cleanup } = await setUp(world.a);
    try {
      const report = await runDoctor({ root, env, version: '9.0.0' });

      expect(report.checks.find((run) => run.check === 'install.pointers')).toMatchObject({ status: 'skipped', why: expect.stringContaining('pins') });
    } finally {
      await cleanup();
    }
  });
});

describe('doctor --fix', SLOW, () => {
  gitTest('repairs only content pointer files and stale locks; changed grants and records stay as they are', async ({ world }) => {
    const { root, store, env, cleanup } = await setUp(world.a);
    try {
      await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');
      const settings = JSON.parse(await read(root, '.claude/settings.json')) as Record<string, any>;
      settings.permissions.allow = [];
      const changedSettings = `${JSON.stringify(settings, null, 2)}\n`;
      await writeFile(path.join(root, '.claude/settings.json'), changedSettings);
      const refs = path.join(root, '.git', 'refs', 'grimoire');
      await mkdir(refs, { recursive: true });
      await writeFile(path.join(refs, 'tracker.lock'), '');
      const old = new Date(Date.now() - 120_000);
      await utimes(path.join(refs, 'tracker.lock'), old, old);
      await store.leases.acquire('upkeep-pending-sync', { ttlMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const report = await runDoctor({ root, env, fix: true });

      expect(report.fix?.fixed.map((entry) => `${entry.kind} ${entry.subject}`).sort()).toEqual([
        'content-drift .claude/rules/grimoire.md',
        'stale-lease upkeep-pending-sync',
        'stale-ref-lock refs/grimoire/tracker.lock',
      ]);
      expect(report.fix?.notices).toContain('grimoire refreshed 1 pointer file: commit it');
      expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
      expect(await read(root, '.claude/settings.json')).toBe(changedSettings);
      expect(kinds(report, 'install')).toEqual(['codex-hook-unapproved', 'permission-drift']);
      expect(found(report, 'stale-ref-lock')).toEqual([]);
      expect((await refreshedPointerFiles(store, root))?.paths).toEqual(['.claude/rules/grimoire.md']);
    } finally {
      await cleanup();
    }
  });

  /** Only the pointer comparison: these runs are about what --fix does with a drifted content pointer. */
  const POINTERS = DOCTOR_CHECKS.filter((check) => check.name === 'install.pointers');
  const DRIFTED = '# grimoire\n\nmy own words\n';
  const skippedWhy = (report: DoctorReport) => report.fix?.skipped.filter((entry) => entry.kind === 'content-drift').map((entry) => entry.why) ?? [];

  gitTest('leaves content pointers alone during a git operation, an upgrade to another pin, or another process’s work on the worktree, and says why', async ({ world }) => {
    const { root, store, env, cleanup } = await setUp(world.a);
    try {
      await writeFile(path.join(root, '.claude/rules/grimoire.md'), DRIFTED);
      const rebase = path.join(root, '.git', 'rebase-merge');
      await mkdir(rebase);
      const rebasing = await runDoctor({ root, env, fix: true, checks: POINTERS });
      await rm(rebase, { recursive: true });
      await store.coordination.write(UPGRADE_RECORDS, 'upgrade-a', { worktree: root, from: VERSION, to: '9.9.9', started_at: Date.now() });
      const upgrading = await runDoctor({ root, env, fix: true, checks: POINTERS });
      await store.coordination.remove(UPGRADE_RECORDS, 'upgrade-a');
      const held = await store.leases.acquire(await worktreeLeaseName(root), { ttlMs: 60_000 });
      const busy = await runDoctor({ root, env, fix: true, checks: POINTERS, leaseWaitMs: 200 });
      if (held.status === 'acquired') await held.lease.release();
      const otherVersion = await runDoctor({ root, env, fix: true, checks: POINTERS, version: '9.0.0' });

      expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
      expect(skippedWhy(rebasing)).toEqual([expect.stringContaining('rebase is in progress')]);
      expect(skippedWhy(upgrading)).toEqual([expect.stringContaining('upgrade to 9.9.9 is in progress')]);
      expect(upgrading.fix?.notices).toEqual([expect.stringContaining('an upgrade to 9.9.9 is in progress there')]);
      expect(skippedWhy(busy)).toEqual([expect.stringContaining('another grimoire process')]);
      for (const report of [rebasing, upgrading, busy, otherVersion]) expect(report.fix?.fixed).toEqual([]);
      expect(found(rebasing, 'content-drift')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  gitTest('a machine-local store it can’t write leaves the pointers as they are and still gives the report', async ({ world }) => {
    const { root, store, env, cleanup } = await setUp(world.a);
    try {
      await writeFile(path.join(root, '.claude/rules/grimoire.md'), DRIFTED);
      // Where the leases live, a file: every lease write fails, as in a sandbox that can't write .git/.
      await rm(path.join(store.dir, 'leases'), { recursive: true, force: true });
      await writeFile(path.join(store.dir, 'leases'), 'not a folder\n');

      const report = await runDoctor({ root, env, fix: true, checks: POINTERS });

      expect(await read(root, '.claude/rules/grimoire.md')).toBe(DRIFTED);
      expect(skippedWhy(report)).toEqual([expect.stringContaining('can’t write this clone’s machine-local store')]);
      expect(found(report, 'content-drift')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
