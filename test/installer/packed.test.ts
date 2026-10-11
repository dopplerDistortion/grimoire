// Seam 3 (spec Testing Decisions; §11): the real chain an agent client runs.
// grimoire is built and packed with npm as its own version, installed from the
// tarball into a clone's version copies with the launcher and a join record,
// then reached only through the frozen bootstrap (and the shell shim), started
// in a subdirectory: never through the working tree or node_modules.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, readFixture, runCommand } from '#harness';
import {
  claudeHookArgs,
  copyDir,
  installCopy,
  installLauncher,
  MCP_ENTRY_ARGS,
  notSetUpLine,
  pruneCopies,
  SHIM_PATH,
  shimText,
  writeJoinRecord,
} from '../../src/installer';
import { revealedRoot } from '../../src/capture/transcript-roots';
import { MachineLocalStore } from '../../src/machine-local';
import { initializeTracker } from '../core/support';
import { packGrimoire, reportingPackage, runEntry, writeConfig } from './support';

/** A version no build of the working tree reports, so only the installed copy can answer with it. */
const PIN = '1.0.0-test.1';

// Unset when the build or pack in beforeAll failed: afterAll must not hide that failure.
let packed: Awaited<ReturnType<typeof packGrimoire>> | undefined;
beforeAll(async () => {
  packed = await packGrimoire(PIN);
});
afterAll(() => packed?.cleanup());

/** Joins clone `root` to PIN from the packed tarball, as init's step 5 does, and pins it. */
async function joined(root: string): Promise<MachineLocalStore> {
  const store = new MachineLocalStore(path.join(root, '.git'));
  const { tarball, integrity } = packed!;
  const copy = await installCopy(store, PIN, { tarball, integrity });
  expect(copy.status).toBe('installed');
  await installLauncher(store);
  await writeJoinRecord(store, PIN, { excerpt_mode: 'facts', codex_hook_hash: null, joined_at: Date.now() });
  await writeConfig(root, PIN);
  return store;
}

describe('a clone joined from the packed tarball', () => {
  gitTest('the bootstrap, spawned in a subdirectory, runs `grimoire mcp` from the pinned copy in both MCP eras', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    await joined(world.a.dir);
    const sub = path.join(world.a.dir, 'packages', 'app');
    await mkdir(sub, { recursive: true });

    for (const era of ['legacy', 'modern'] as const) {
      const client =
        era === 'legacy'
          ? new Client({ name: 'codex-mcp-client', version: '0.162.1' }, { capabilities: {}, supportedProtocolVersions: ['2025-06-18'] })
          : new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [...MCP_ENTRY_ARGS], cwd: sub, env: process.env as Record<string, string>, stderr: 'pipe' }),
      );
      try {
        expect(client.getServerVersion(), era).toMatchObject({ name: 'grimoire', version: PIN });
        // tools/list loads the core: lazily imported chunks, so dist/chunks/ came along with the copy.
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name), era).toContain('show');
        const listed = await client.callTool({ name: 'list', arguments: {} });
        expect(listed.isError, era).toBeFalsy();
      } finally {
        await client.close();
      }
    }
  });

  gitTest('a launched server records itself, so pruning keeps its copy while it serves and only then lets it go', async ({ world }) => {
    const store = await joined(world.a.dir);
    // The checkout moves on to 1.0.0 while the server runs PIN; 1.0.0-test.2 is the newest previous copy.
    for (const version of ['1.0.0-test.2', '1.0.0']) {
      await installCopy(store, version, { dir: await reportingPackage(world.root, version), integrity: null });
    }
    const client = new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [...MCP_ENTRY_ARGS], cwd: world.a.dir, stderr: 'pipe' }));
    let duringServe: Awaited<ReturnType<typeof pruneCopies>>;
    try {
      await expect.poll(async () => (await store.processes.live({ role: 'mcp' })).map((r) => [r.pin, r.worktree]), { timeout: 10_000 }).toEqual([[PIN, world.a.dir]]);
      // The first request names the client (`clientInfo`), and the record then carries it.
      await client.listTools();
      await expect.poll(async () => (await store.processes.live({ role: 'mcp' })).map((r) => r.client), { timeout: 10_000 }).toEqual(['claude-code']);
      await writeConfig(world.a.dir, '1.0.0');
      duringServe = await pruneCopies(store);
    } finally {
      await client.close();
    }
    await expect.poll(async () => (await store.processes.list()).length, { timeout: 10_000 }).toBe(0);
    const afterServe = await pruneCopies(store);

    expect(duringServe.removed).toEqual([]);
    expect(duringServe.kept).toContainEqual({ version: PIN, why: ['running'] });
    expect(afterServe.removed).toEqual([PIN]);
  });

  gitTest('both hook verbs run from the pinned copy and exit 0; an unknown event too', async ({ world }) => {
    const store = await joined(world.a.dir);
    const sub = path.join(world.a.dir, 'src');
    await mkdir(sub);
    const claudeStart = readFixture('claude-code/hook-payloads/session-start-startup.json');
    const pre = readFixture('claude-code/hook-payloads/pre-tool-use.json');
    const unknown = [...claudeHookArgs('pre-tool-use').slice(0, -1), 'subagent-stop'];
    // GRIMOIRE_DEBUG puts a hook's swallowed failure on stderr, so a copy whose hook path breaks can't pass as a quiet hook.
    const env = { ...process.env, GRIMOIRE_DEBUG: '1' };
    const hooks = async () => [
      await runEntry(claudeHookArgs('session-start'), { cwd: sub, projectDir: world.a.dir, input: claudeStart, env }),
      await runEntry(claudeHookArgs('pre-tool-use'), { cwd: sub, projectDir: world.a.dir, input: pre, env }),
      await runEntry(unknown, { cwd: sub, projectDir: world.a.dir, input: '{}', env }),
    ];

    const runs = await hooks();
    // The same entries against a copy missing each event's own chunk: still exit 0 and silent on stdout, but debug says why.
    const chunks = path.join(copyDir(store, PIN), 'dist', 'chunks');
    const eventChunks = (await readdir(chunks)).filter((name) => /^(session-start|pre-tool-use)-/.test(name));
    expect(eventChunks).toHaveLength(2);
    for (const name of eventChunks) await rm(path.join(chunks, name));
    const [brokenStart, brokenPre] = await hooks();
    // Without the copy the same session-start entry would print the not-set-up line instead.
    await rm(path.join(copyDir(store, PIN), '.complete'));
    const withoutCopy = await runEntry(claudeHookArgs('session-start'), { cwd: sub, projectDir: world.a.dir, input: claudeStart });

    const [start, preRun, unknownRun] = runs;
    for (const r of [start!, unknownRun!]) expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    // The pre-tool-use hook adds the reserved hint key, ids only (spike A, T1).
    const payload = JSON.parse(pre) as { session_id: string; tool_use_id: string; tool_input: object };
    expect([preRun!.code, preRun!.stderr]).toEqual([0, '']);
    expect(JSON.parse(preRun!.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, _grimoire: { session_id: payload.session_id, tool_use_id: payload.tool_use_id } },
      },
    });
    // The transcript path stays out of the hint: the hook recorded it in the clone instead (§6).
    expect(await revealedRoot(store, payload.session_id)).toMatchObject({ transcript_path: JSON.parse(pre).transcript_path });
    for (const r of [brokenStart!, brokenPre!]) {
      expect([r.code, r.stdout]).toEqual([0, '']);
      expect(r.stderr).toMatch(/^grimoire hook failed: .*(Cannot find module|ERR_MODULE_NOT_FOUND)/s);
    }
    expect(withoutCopy.stdout).toBe(`${notSetUpLine(PIN)}\n`);
  });

  gitTest('the shell shim runs CLI verbs from the pinned copy in its own process', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    await joined(world.a.dir);
    const shim = path.join(world.a.dir, SHIM_PATH);
    await writeFile(shim, shimText());
    const sub = path.join(world.a.dir, 'docs');
    await mkdir(sub);

    const version = await runCommand(process.execPath, [shim, '--version'], { cwd: sub });
    const created = await runCommand(process.execPath, [shim, 'create', '--title', 'Ship the launcher'], { cwd: sub });
    const pin = await runCommand(process.execPath, [shim, 'pin'], { cwd: sub });

    expect(JSON.parse(version.stdout)).toEqual({ version: PIN });
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ id: expect.stringMatching(/^gr-/) });
    expect(pin.stdout).toBe(`${PIN}\n`);
  });
});
