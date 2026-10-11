// Seam 3 (spec Testing Decisions; §12 status and doctor, §10): `status` and
// `doctor` as agents and people run them, `node .grimoire/run.cjs <verb>`,
// through the launcher into the copy `init` installed from grimoire packed
// with npm. Each defect is injected the way a person, another tool or a
// crash leaves it.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, makeTempDir, removeDir, runCommand, type GitWorld } from '#harness';
import { MachineLocalStore } from '../../src/machine-local';
import { commitToTracker, issuePath } from '../core/support';
import { humanEnv, oneJsonObject } from '../surfaces/cli/support';
import { npxInstall, packGrimoire } from './support';

/** A version no build of the working tree reports, so only the packed package can answer with it. */
const PIN = '1.0.0-test.150';

let packed: Awaited<ReturnType<typeof packGrimoire>> | undefined;
let npxDir: string | undefined;
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

/** Each test spawns init and several CLI runs, each a fresh node: room for a loaded machine. */
const LONG = 300_000;

/** What Claude Code's Bash tool puts in an agent's shell (spike A). */
const CLAUDE_SHELL = { AI_AGENT: 'claude-code_2-1-296_agent', CLAUDECODE: '1' };

/** `node .grimoire/run.cjs <args>` in `root`: stdout must be exactly one JSON object. */
async function shim(root: string, args: readonly string[], env: NodeJS.ProcessEnv = humanEnv()) {
  const result = await runCommand(process.execPath, ['.grimoire/run.cjs', ...args], { cwd: root, env, timeoutMs: 120_000 });
  return { code: result.code, json: oneJsonObject(result.stdout, result.stderr) as Record<string, any>, stderr: result.stderr };
}

/** `init --yes` in clone a, from the package as npx installed it. */
async function installed(world: GitWorld): Promise<string> {
  const root = world.a.dir;
  const run = await runCommand(process.execPath, [bin, 'init', '--yes', '--json'], { cwd: root, env: humanEnv(), timeoutMs: 120_000 });
  expect(run.code, run.stdout + run.stderr).toBe(0);
  return root;
}

/** Every file under `dir`: its size, mtime and content hash. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        files.set(`${file}/`, 'dir');
        await walk(file);
      } else {
        const info = await stat(file);
        files.set(file, `${info.size} ${info.mtimeMs} ${createHash('sha1').update(await readFile(file)).digest('hex')}`);
      }
    }
  };
  await walk(dir);
  return files;
}

const kindsOf = (report: Record<string, any>): string[] => [...new Set((report.findings as { kind: string }[]).map((finding) => finding.kind))].sort();

describe('doctor', () => {
  gitTest('reports each injected defect; --fix repairs only the content pointer and the stale lock', async ({ world }) => {
    const root = await installed(world);
    const store = new MachineLocalStore(path.join(root, '.git'));
    const codexHome = await makeTempDir('grimoire-codex-home-');
    try {
      const env = humanEnv({ CODEX_HOME: codexHome });
      const created = await shim(root, ['create', 'A record to tamper with'], humanEnv(CLAUDE_SHELL));
      expect(created.code, created.stderr).toBe(0);
      const id = created.json.id as string;

      // A drifted content pointer.
      await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');
      // A drifted permission entry.
      const settings = JSON.parse(await readFile(path.join(root, '.claude/settings.json'), 'utf8')) as Record<string, any>;
      settings.permissions.allow = settings.permissions.allow.filter((rule: string) => rule !== 'mcp__grimoire');
      // An edited hook command.
      settings.hooks.SessionStart[0].hooks[0].command = 'nodejs';
      const editedSettings = `${JSON.stringify(settings, null, 2)}\n`;
      await writeFile(path.join(root, '.claude/settings.json'), editedSettings);
      // A non-canonical record: another writer's hand edit, CRLF line ends.
      const record = await world.a.git(['cat-file', 'blob', `refs/grimoire/tracker:${issuePath(id)}`]);
      await commitToTracker(world.a, { [issuePath(id)]: `${record.replace(/\n/g, '\r\n')}\r\n` });
      const tamperedTip = await world.a.git(['rev-parse', 'refs/grimoire/tracker']);
      // A stale ref lock, left by a git that died two minutes ago.
      const lock = path.join(root, '.git', 'refs', 'grimoire', 'tracker.lock');
      await mkdir(path.dirname(lock), { recursive: true });
      await writeFile(lock, '');
      const old = new Date(Date.now() - 120_000);
      await utimes(lock, old, old);
      // A corrupted copy (still loadable, so its own doctor can say so).
      await appendFile(path.join(store.dir, 'pkg', PIN, 'dist', 'launch.mjs'), '\n// corrupted\n');

      const report = await shim(root, ['doctor'], env);

      expect(report.code, report.stderr).toBe(0);
      expect(report.json).toMatchObject({ version: PIN, pin: PIN, ok: false });
      expect(kindsOf(report.json)).toEqual(
        expect.arrayContaining(['stale-ref-lock', 'content-drift', 'permission-drift', 'non-canonical', 'copy-corrupt', 'hook-drift']),
      );
      const findings = report.json.findings as { kind: string; subject?: string; fixable: boolean }[];
      expect(findings.find((finding) => finding.kind === 'non-canonical')).toMatchObject({ subject: issuePath(id), fixable: false });
      expect(findings.find((finding) => finding.kind === 'hook-drift')).toMatchObject({ subject: '.claude/settings.json (hooks.SessionStart)', fixable: false });
      expect(findings.find((finding) => finding.kind === 'copy-corrupt')).toMatchObject({ fixable: false });
      // The human-readable report is on stderr.
      expect(report.stderr).toContain(`grimoire ${PIN} doctor in`);
      expect(report.stderr).toMatch(/Store:\n {2}error/);

      const fixed = await shim(root, ['doctor', '--fix', '--json'], env);

      expect(fixed.code, fixed.stderr).toBe(0);
      expect(fixed.stderr).toBe('');
      expect((fixed.json.fix.fixed as { kind: string; subject: string }[]).map((entry) => `${entry.kind} ${entry.subject}`).sort()).toEqual([
        'content-drift .claude/rules/grimoire.md',
        'stale-ref-lock refs/grimoire/tracker.lock',
      ]);
      expect(await stat(lock).catch(() => null)).toBeNull();
      expect(await readFile(path.join(root, '.claude/settings.json'), 'utf8')).toBe(editedSettings);
      expect(await world.a.git(['rev-parse', 'refs/grimoire/tracker'])).toBe(tamperedTip);
      expect(kindsOf(fixed.json)).toEqual(expect.arrayContaining(['permission-drift', 'non-canonical', 'copy-corrupt', 'hook-drift']));
      expect(kindsOf(fixed.json)).not.toContain('content-drift');
      expect(kindsOf(fixed.json)).not.toContain('stale-ref-lock');
    } finally {
      await removeDir(codexHome);
    }
  }, LONG);

  gitTest('--help prints the verb’s flags as one JSON object; an unknown flag is a usage error', async ({ world }) => {
    const root = await installed(world);

    const help = await shim(root, ['doctor', '--help']);
    const usage = await shim(root, ['doctor', '--frobnicate']);
    const statusHelp = await shim(root, ['status', '--help']);

    expect(help).toMatchObject({ code: 0, json: { verb: 'doctor', flags: { '--fix': expect.any(String) } } });
    expect(usage).toMatchObject({ code: 2, json: { usage_error: { help: 'grimoire doctor --help' } } });
    expect(statusHelp).toMatchObject({ code: 0, json: { verb: 'status', flags: { '--json': expect.any(String) } } });
  }, LONG);

  gitTest('--from names the repo through the shim too, in either spelling; no repo there is an error object and exit 1', async ({ world }) => {
    const root = await installed(world);
    const nowhere = await makeTempDir('grimoire-no-repo-');
    try {
      const other = await shim(root, ['status', '--json', `--from=${world.b.dir}`]);
      const otherDoctor = await shim(root, ['doctor', '--json', '--from', world.b.dir]);
      const lost = await shim(root, ['status', `--from=${nowhere}`]);
      const lostDoctor = await shim(root, ['doctor', '--from', nowhere]);

      expect(other).toMatchObject({ code: 0, stderr: '', json: { version: PIN, root: world.b.dir, pin: null } });
      expect(otherDoctor).toMatchObject({ code: 0, stderr: '', json: { root: world.b.dir, pin: null } });
      for (const run of [lost, lostDoctor]) {
        expect(run.code).toBe(1);
        expect(run.json).toEqual({ error: expect.objectContaining({ code: 'NO_REPO' }) });
      }
    } finally {
      await removeDir(nowhere);
    }
  }, LONG);
});

describe('status', () => {
  gitTest('writes nothing, and reports a rejected sync with its class and the client whose process hit it', async ({ world }) => {
    const root = await installed(world);
    await writeFile(
      path.join(world.remote, 'hooks', 'pre-receive'),
      ['#!/bin/sh', 'echo "GH013: Repository rule violations found for refs/heads/grimoire/tracker." >&2', 'exit 1', ''].join('\n'),
      { mode: 0o755 },
    );
    const agent = humanEnv(CLAUDE_SHELL);
    expect((await shim(root, ['create', 'Waiting to go out'], agent)).code).toBe(0);
    const synced = await shim(root, ['sync'], agent);
    expect(synced.json).toMatchObject({ state: 'pending', reason: 'failed', failure: { class: 'rejected' } });
    // A drifted content pointer, refreshed: status asks to commit it.
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), '# grimoire\n\nmy own words\n');
    expect((await shim(root, ['doctor', '--fix', '--json'])).code).toBe(0);
    const before = await snapshot(root);

    const status = await shim(root, ['status'], agent);

    expect(await snapshot(root)).toEqual(before);
    expect(status.code, status.stderr).toBe(0);
    expect(status.json).toMatchObject({
      version: PIN,
      pin: PIN,
      sync: {
        failure: { class: 'rejected', client: 'claude-code', surface: 'cli', message: expect.stringContaining('GH013') },
        summary: expect.stringMatching(/^sync pending since .+: the remote rejected the push in a claude-code CLI call$/),
      },
      refreshed_pointer_files: { paths: ['.claude/rules/grimoire.md'] },
      stale_claims: { stale_after: '24h', claims: [] },
      excerpt_mode: { store: 'facts', joined: 'facts', changed: false },
      codex_hook: { trust: expect.any(String), expected_hash: expect.stringMatching(/^sha256:/) },
    });
    expect(status.stderr).toContain('the remote rejected the push in a claude-code CLI call');
    expect(status.stderr).toContain('grimoire refreshed 1 pointer file: commit it');
  }, LONG);
});
