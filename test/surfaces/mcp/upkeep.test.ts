// Seam 3: upkeep inside the real `grimoire mcp` (spec §13 Where it runs, How
// it runs). Two servers start together in one clone: every upkeep part runs
// exactly once between them (the lease), and tool calls issued while one of
// them is stuck in upkeep's push are answered while it hangs. Transport and wiring
// only; the rules are seam 1's (test/upkeep).
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, type Checkout } from '#harness';
import { createCore, spawnedAutoSync, type CallContext } from '../../../src/core';
import { installCopy, listCopies, MCP_ENTRY_ARGS, PACKAGE_NAME } from '../../../src/installer';
import { instructionRulesText } from '../../../src/installer/texts';
import { MachineLocalStore } from '../../../src/machine-local';
import { agentContext, initializeTracker, trackerTip } from '../../core/support';
import { joinClone, reportingPackage } from '../../installer/support';
import { VERSION } from '../../../src/version';
import { installed, read } from '../../upkeep/support';
import { buildGrimoire } from './support';

/** The built package, laid out as published: package.json beside dist/. */
let packageDir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  let bin: string;
  ({ bin, cleanup } = await buildGrimoire());
  packageDir = path.dirname(path.dirname(bin));
  await writeFile(path.join(packageDir, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION })}
`);
});
afterAll(() => cleanup());

interface Server {
  readonly client: Client;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
}

/** Spawns the MCP entry through the frozen bootstrap with GRIMOIRE_DEBUG, as Claude Code connects (2026-07-28). */
async function server(cwd: string): Promise<Server> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...MCP_ENTRY_ARGS],
    cwd,
    env: { ...(process.env as Record<string, string>), GRIMOIRE_DEBUG: '1' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const client = new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${stderr}`);
  }
  return { client, stderr: () => stderr };
}

const PARTS = ['pending-sync', 'prune-copies', 'pointer-refresh'];

/** Each upkeep part's outcomes in a server's GRIMOIRE_DEBUG output. */
function outcomes(stderr: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of stderr.matchAll(/^grimoire upkeep ([a-z-]+)(?: [^\n]*)?: (ran|held|throttled|skipped|failed)/gm)) {
    found.set(match[1]!, [...(found.get(match[1]!) ?? []), match[2]!]);
  }
  return found;
}

async function remoteTracker(checkout: Checkout): Promise<string | null> {
  const out = await checkout.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return out.split('\t')[0]?.trim() || null;
}

const DEBRIEF = { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' };

describe('upkeep in grimoire mcp', () => {
  gitTest('two servers starting together run each part once, and answer tool calls while upkeep’s push hangs', { timeout: 120_000 }, async ({ world }) => {
    const root = world.a.dir;
    await initializeTracker(world.a, world.a);
    await installed(root);
    await writeFile(path.join(root, '.claude/rules/grimoire.md'), 'drifted\n');
    const store = new MachineLocalStore(path.join(root, '.git'));
    await joinClone(store, VERSION, { dir: packageDir, integrity: null });
    await installCopy(store, '1.0.0', { dir: await reportingPackage(world.root, '1.0.0'), integrity: null });
    // An attempt-ending write whose detached sync died: its tip waits for upkeep.
    const ctx: CallContext = agentContext(world.a);
    const writer = createCore({ autoSync: spawnedAutoSync({ command: process.execPath, args: ['-e', 'process.exit(0)'] }) });
    const created = await writer.call('create', { title: 'Fix the flaky test' }, ctx);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const id = (created.result as { id: string }).id;
    const claimed = await writer.call('claim', { id }, ctx);
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    await writer.call('close', { id, attempt: (claimed.result as { attempt: string }).attempt, reason: 'done', debrief: DEBRIEF }, ctx);
    await writer.close();
    // The remote holds the push until the test lets it go (a minute at most), and says when it started.
    const posix = (file: string) => file.split(path.sep).join('/');
    const started = path.join(world.root, 'push-started');
    const release = path.join(world.root, 'push-release');
    await writeFile(
      path.join(world.remote, 'hooks', 'pre-receive'),
      `#!/bin/sh\ntouch '${posix(started)}'\ni=0\nwhile [ ! -e '${posix(release)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done\n`,
      { mode: 0o755 },
    );

    const servers = await Promise.all([server(root), server(root)]);
    try {
      await Promise.all(servers.map((s) => s.client.listTools()));
      await expect.poll(() => existsSync(started), { timeout: 30_000, interval: 50 }).toBe(true);

      // While upkeep's push hangs, both servers answer. No clock: the push can't end before the release.
      for (const s of servers) {
        const listed = await s.client.callTool({ name: 'list', arguments: {} });
        expect(listed.isError).toBeFalsy();
      }
      expect(await remoteTracker(world.a)).toBeNull();
      await writeFile(release, '');

      // Then each part ran in exactly one of them.
      await expect
        .poll(() => servers.every((s) => PARTS.every((part) => outcomes(s.stderr()).has(part))), { timeout: 60_000, interval: 100 })
        .toBe(true);
      for (const part of PARTS) {
        const statuses = servers.flatMap((s) => outcomes(s.stderr()).get(part) ?? []);
        expect(statuses.filter((status) => status === 'ran'), `${part}: ${servers.map((s) => s.stderr()).join('\n---\n')}`).toHaveLength(1);
      }
      expect(await remoteTracker(world.a)).toBe(await trackerTip(world.a));
      expect((await listCopies(store)).map((copy) => copy.version)).toEqual([VERSION]);
      expect(await read(root, '.claude/rules/grimoire.md')).toBe(instructionRulesText());
      expect(servers.map((s) => s.stderr()).join('')).toContain('grimoire refreshed 1 pointer file: commit it');
    } finally {
      await writeFile(release, '');
      await Promise.all(servers.map((s) => s.client.close()));
    }
  });
});
