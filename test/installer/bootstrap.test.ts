// Seam 3 (spec §11, §21, §22 R1–R3): the frozen bootstrap, run by real node
// exactly as each client spawns it, against real temp git repos. A stand-in
// launcher reports what the bootstrap handed it, so these tests pin the
// bootstrap↔launcher contract; test/installer/launcher.test.ts covers the
// real launcher.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, gitTest, makeTempDir, removeDir } from '#harness';
import {
  BOOTSTRAP,
  claudeHookArgs,
  codexHookCommand,
  MCP_ENTRY_ARGS,
  notSetUpLine,
} from '../../src/installer';
import { runEntry } from './support';

/** The stand-in launcher: prints what the bootstrap passed it, and what the process itself got. */
const REPORTING_LAUNCHER =
  "module.exports = (args, root) => process.stdout.write(JSON.stringify({ args, root, argv: process.argv.slice(1), stdin: require('fs').readFileSync(0, 'utf8') }));\n";

async function writeLauncher(commonDir: string, text = REPORTING_LAUNCHER): Promise<void> {
  await mkdir(path.join(commonDir, 'grimoire'), { recursive: true });
  await writeFile(path.join(commonDir, 'grimoire', 'launcher.cjs'), text);
}

async function writeConfig(root: string, text = 'version: 1.4.2\ninstall_format: 1\n'): Promise<void> {
  await mkdir(path.join(root, '.grimoire'), { recursive: true });
  await writeFile(path.join(root, '.grimoire', 'config.yml'), text);
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => removeDir(dir)));
});

/** A fresh repo in a folder whose path holds a space and a non-ASCII letter, as spike A's did. */
async function awkwardRepo(): Promise<string> {
  const base = await makeTempDir('grimoire-bootstrap-');
  temps.push(base);
  const repo = path.join(base, 'r dash ö', 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--quiet']);
  return repo;
}

describe('the bootstrap text', () => {
  it('avoids every character a shell or a client config would touch: $ " \\ % ^ and backticks', () => {
    for (const forbidden of ['$', '"', '\\', '%', '^', '`']) expect(BOOTSTRAP, forbidden).not.toContain(forbidden);
    // One line of printable ASCII: nothing a shell, TOML or JSON would reinterpret.
    expect(BOOTSTRAP).toMatch(/^[ -~]+$/);
  });

  it('is the frozen client entries: mcp as written, hooks with -- before --from (spike A R3, spike C)', () => {
    expect(MCP_ENTRY_ARGS).toEqual(['-e', BOOTSTRAP, 'mcp']);
    expect(claudeHookArgs('session-start')).toEqual(['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'session-start']);
    expect(claudeHookArgs('pre-tool-use')).toEqual(['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'pre-tool-use']);
    expect(codexHookCommand()).toBe(`node -e "${BOOTSTRAP}" -- hook session-start`);
  });

  it('names the pin in the not-set-up line', () => {
    expect(notSetUpLine('1.4.2')).toBe("grimoire isn't set up on this machine; ask the user to run `npx @goksening/grimoire@1.4.2 init`");
  });
});

describe('the bootstrap hands the launcher its arguments (spike A R3 fallback)', () => {
  it('a hook passes process.argv.slice(1) whole, --from first, and the root that holds .git; the payload stays on stdin', async () => {
    const repo = await awkwardRepo();
    await writeLauncher(path.join(repo, '.git'));

    const r = await runEntry(claudeHookArgs('pre-tool-use'), { cwd: repo, projectDir: repo, input: '{"tool_name":"mcp__grimoire__show"}' });

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      args: ['--from', repo, 'hook', 'pre-tool-use'],
      root: repo,
      argv: ['--from', repo, 'hook', 'pre-tool-use'],
      stdin: '{"tool_name":"mcp__grimoire__show"}',
    });
  });

  it('mcp, spawned in a subdirectory with no --from, walks up from the cwd to the repo root', async () => {
    const repo = await awkwardRepo();
    await writeLauncher(path.join(repo, '.git'));
    const sub = path.join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });

    const r = await runEntry(MCP_ENTRY_ARGS, { cwd: sub });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ args: ['mcp'], root: repo });
  });

  it('--from wins over the cwd', async () => {
    const repo = await awkwardRepo();
    const elsewhere = await awkwardRepo();
    await writeLauncher(path.join(repo, '.git'));

    const r = await runEntry(claudeHookArgs('session-start'), { cwd: elsewhere, projectDir: path.join(repo, 'not', 'made') });

    expect(JSON.parse(r.stdout)).toMatchObject({ root: repo });
  });

  gitTest('a nested repo’s .git stops the walk: the outer repo’s launcher is never reached', async ({ world }) => {
    await writeLauncher(path.join(world.a.dir, '.git'));
    const nested = path.join(world.a.dir, 'vendor', 'inner');
    await mkdir(nested, { recursive: true });
    await git(nested, ['init', '--quiet']);
    await writeConfig(nested);

    const quiet = await runEntry(MCP_ENTRY_ARGS, { cwd: nested });
    await writeLauncher(path.join(nested, '.git'));
    const inner = await runEntry(MCP_ENTRY_ARGS, { cwd: nested });

    // The nested repo has config.yml but no launcher of its own: its notice, not the outer launcher.
    expect(quiet.stdout).toBe('');
    expect(quiet.stderr.trim()).toBe(notSetUpLine('1.4.2'));
    expect(quiet.code).toBe(3);
    expect(JSON.parse(inner.stdout)).toMatchObject({ root: nested });
  });

  gitTest('a linked worktree follows its gitdir: file through commondir to the main checkout’s launcher', async ({ world }) => {
    await writeLauncher(path.join(world.a.dir, '.git'));
    const linked = await world.a.addWorktree('feature');

    const r = await runEntry(claudeHookArgs('session-start'), { cwd: linked.dir, projectDir: linked.dir });

    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ args: ['--from', linked.dir, 'hook', 'session-start'], root: linked.dir });
  });
});

describe('when grimoire is missing', () => {
  it('a checkout without config.yml, or outside any repo, exits 0 and prints nothing for every entry', async () => {
    const repo = await awkwardRepo();
    const outside = await makeTempDir('grimoire-no-repo-');
    temps.push(outside);

    for (const cwd of [repo, outside]) {
      for (const args of [MCP_ENTRY_ARGS, claudeHookArgs('session-start'), claudeHookArgs('pre-tool-use')]) {
        const r = await runEntry(args, { cwd, projectDir: cwd });
        expect([r.code, r.stdout, r.stderr], `${args.at(-1)} in ${cwd}`).toEqual([0, '', '']);
      }
    }
  });

  it('a fresh clone (config.yml, no launcher): session-start prints the line, mcp writes it to stderr and exits 3, other hooks stay silent', async () => {
    const repo = await awkwardRepo();
    await writeConfig(repo);
    const sub = path.join(repo, 'pkg');
    await mkdir(sub);

    const start = await runEntry(claudeHookArgs('session-start'), { cwd: sub, projectDir: repo });
    const mcp = await runEntry(MCP_ENTRY_ARGS, { cwd: sub });
    const pre = await runEntry(claudeHookArgs('pre-tool-use'), { cwd: repo, projectDir: repo });
    const unknown = await runEntry([...claudeHookArgs('pre-tool-use').slice(0, -1), 'stop'], { cwd: repo, projectDir: repo });

    expect([start.code, start.stdout, start.stderr]).toEqual([0, `${notSetUpLine('1.4.2')}\n`, '']);
    expect([mcp.code, mcp.stdout, mcp.stderr]).toEqual([3, '', `${notSetUpLine('1.4.2')}\n`]);
    expect([pre.code, pre.stdout, pre.stderr]).toEqual([0, '', '']);
    expect([unknown.code, unknown.stdout, unknown.stderr]).toEqual([0, '', '']);
  });

  it('reads the pin however config.yml quotes it', async () => {
    const repo = await awkwardRepo();
    for (const line of ['version: 2.0.0-rc.1', 'version: "2.0.0-rc.1"', "version: '2.0.0-rc.1' # pinned"]) {
      await writeConfig(repo, `${line}\ninstall_format: 1\n`);
      const r = await runEntry(claudeHookArgs('session-start'), { cwd: repo, projectDir: repo });
      expect(r.stdout, line).toBe(`${notSetUpLine('2.0.0-rc.1')}\n`);
    }
  });

  it('a launcher that throws never fails a hook; mcp shows the error', async () => {
    const repo = await awkwardRepo();
    await writeConfig(repo);
    await writeLauncher(path.join(repo, '.git'), 'module.exports = () => { throw new Error("broken launcher"); };\n');

    const hook = await runEntry(claudeHookArgs('session-start'), { cwd: repo, projectDir: repo });
    const mcp = await runEntry(MCP_ENTRY_ARGS, { cwd: repo });

    expect([hook.code, hook.stdout, hook.stderr]).toEqual([0, '', '']);
    expect(mcp.code).not.toBe(0);
    expect(mcp.stderr).toContain('broken launcher');
  });
});

describe('the Codex hook string under each shell Codex runs hooks with (spike E R2)', () => {
  // Codex 0.162.1 runs a hook as [pwsh|powershell, -NoProfile, -Command, cmd], as
  // cmd.exe /c "<cmd>" (raw, the last-resort fallback), or as [sh, -c, cmd] on Unix,
  // in the session cwd, with the payload on stdin.
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const shells: { name: string; file: string; args: (cmd: string) => string[]; verbatim?: boolean }[] =
    process.platform === 'win32'
      ? [
          { name: 'Windows PowerShell 5.1', file: path.win32.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: (cmd) => ['-NoProfile', '-Command', cmd] },
          { name: 'pwsh 7', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: (cmd) => ['-NoProfile', '-Command', cmd] },
          { name: 'cmd', file: path.win32.join(windir, 'System32', 'cmd.exe'), args: (cmd) => ['/c', `"${cmd}"`], verbatim: true },
          { name: 'sh (Git for Windows)', file: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', args: (cmd) => ['-c', cmd] },
        ]
      : [{ name: 'sh', file: '/bin/sh', args: (cmd) => ['-c', cmd] }];
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  const payload = JSON.stringify({ session_id: 'r2', hook_event_name: 'SessionStart', permission_mode: 'default', source: 'startup' });

  for (const shell of shells) {
    it.skipIf(!existsSync(shell.file))(`${shell.name}: the launcher gets [--, hook, session-start] minus node's --, from a subdirectory`, async () => {
      const repo = await awkwardRepo();
      await writeLauncher(path.join(repo, '.git'));
      const sub = path.join(repo, 'sub');
      await mkdir(sub);

      const r = spawnSync(shell.file, shell.args(codexHookCommand()), {
        cwd: sub,
        env,
        input: payload,
        encoding: 'utf8',
        windowsVerbatimArguments: Boolean(shell.verbatim),
        windowsHide: true,
        timeout: 30_000,
      });

      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ args: ['hook', 'session-start'], root: repo, argv: ['hook', 'session-start'], stdin: payload });
    });
  }
});
