// The release check (GOK-172; spec Testing Decisions, seam 3): the package
// exactly as `npm publish` would ship it (the real package.json with its files
// allowlist, the README, the license, and the full build: CLI, chunks,
// dashboard), packed by npm, installed the way npx installs it, and run by
// `init --yes` in a fresh clone. Then the three end-to-end seam checks run
// against that install alone: MCP over stdio in both eras through the frozen
// bootstrap, the CLI through the shell shim, and the dashboard over HTTP + SSE
// from `start`. Slow: a full build, an npm pack and install, and real servers.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { gitTest, makeTempDir, removeDir, runCommand } from '#harness';
import { MCP_ENTRY_ARGS, SHIM_PATH } from '../../src/installer';
import { cli, humanEnv } from '../surfaces/cli/support';
import { npmPack, npxInstall } from '../installer/support';
import { request, signedIn, spawnStart, SseClient, startEnv, stopStart, writeHeaders } from '../surfaces/start/support';
import { allowlisted, packDryRun, type DryRun } from './support';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
const VERSION = manifest.version;

/** The environment a developer's shell would give `npm run build`, minus Vitest's markers. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && !key.startsWith('VITEST')) env[key] = value;
  }
  return env;
}

let temp: string | undefined;
let dryRun: DryRun;
/** The bin of the package as npx installed it. */
let bin = '';

beforeAll(async () => {
  temp = await makeTempDir('grimoire-release-');
  const packageDir = path.join(temp, 'package');
  await mkdir(packageDir);
  for (const file of ['package.json', 'README.md', 'LICENSE']) await copyFile(path.join(repoRoot, file), path.join(packageDir, file));
  // What `prepack` runs before a publish: the full build into the package's dist/.
  const built = await runCommand(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), '--out-dir', path.join(packageDir, 'dist')], {
    cwd: repoRoot,
    env: buildEnv(),
    timeoutMs: 300_000,
  });
  expect(built.code, built.stdout + built.stderr).toBe(0);
  dryRun = packDryRun(packageDir);
  const { tarball } = npmPack(packageDir, temp);
  const npxDir = path.join(temp, 'npx');
  await mkdir(npxDir);
  bin = npxInstall(tarball, npxDir);
}, 600_000);
afterAll(async () => {
  if (temp) await removeDir(temp);
});

describe(`the packed @goksening/grimoire ${VERSION}`, () => {
  test('holds only allowlisted files: the bundle, its chunks, the dashboard, the notices, the README and the license', () => {
    expect(dryRun.files.filter((file) => !allowlisted(file))).toEqual([]);
    for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/grimoire.mjs', 'dist/launch.mjs', 'dist/THIRD_PARTY_LICENSES.md', 'dist/dashboard/index.html']) {
      expect(dryRun.files).toContain(file);
    }
    expect(dryRun.files.some((file) => file.startsWith('dist/chunks/'))).toBe(true);
    expect(dryRun.files.some((file) => file.startsWith('dist/dashboard/assets/'))).toBe(true);
    // For the release notes: the tarball's size.
    process.stdout.write(`packed ${dryRun.files.length} files: ${dryRun.size} bytes packed, ${dryRun.unpackedSize} bytes unpacked\n`);
  });

  gitTest('installed by `init --yes` into a fresh clone, serves MCP in both eras, the CLI, and the dashboard over HTTP and SSE', { timeout: 300_000 }, async ({ world }) => {
    const root = world.a.dir;
    const installed = await cli(bin, ['init', '--yes'], { cwd: root });
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    expect(await readFile(path.join(root, '.grimoire', 'config.yml'), 'utf8')).toMatch(new RegExp(`^version: ${VERSION.replace(/\./g, '\\.')}$`, 'm'));

    // MCP over stdio, both eras, through the frozen bootstrap as .mcp.json and Codex run it, from a subdirectory.
    const sub = path.join(root, 'packages', 'app');
    await mkdir(sub, { recursive: true });
    const createdByEra: Record<string, string> = {};
    for (const era of ['legacy', 'modern'] as const) {
      const client =
        era === 'legacy'
          ? new Client({ name: 'codex-mcp-client', version: '0.162.1' }, { capabilities: {}, supportedProtocolVersions: ['2025-06-18'] })
          : new Client({ name: 'claude-code', version: '2.1.296' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [...MCP_ENTRY_ARGS], cwd: sub, env: process.env as Record<string, string>, stderr: 'pipe' }));
      try {
        expect(client.getServerVersion(), era).toMatchObject({ name: 'grimoire', version: VERSION });
        expect((await client.listTools()).tools.map((tool) => tool.name), era).toEqual(expect.arrayContaining(['show', 'list', 'create', 'claim', 'close']));
        const created = await client.callTool({ name: 'create', arguments: { title: `Filed over MCP (${era})` } });
        expect(created.isError, `${era}: ${JSON.stringify(created.content)}`).toBeFalsy();
        createdByEra[era] = (created.structuredContent as { id: string }).id;
      } finally {
        await client.close();
      }
    }

    // The CLI through the committed shell shim.
    const shim = path.join(root, SHIM_PATH);
    const version = await cli(shim, ['--version'], { cwd: sub });
    const listed = await cli(shim, ['list'], { cwd: sub });
    expect(version.json).toEqual({ version: VERSION });
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect((listed.json.rows as { id: string }[]).map((row) => row.id).sort()).toEqual(Object.values(createdByEra).sort());

    // The dashboard: `start` from the same install, its static app, a signed-in read and write, and live events.
    const { env } = await startEnv(world.root);
    const start = await spawnStart(shim, root, env);
    const commonDir = path.join(root, '.git');
    try {
      const app = await request(start.port, { path: '/' });
      expect(app.status).toBe(200);
      expect(app.headers['content-type']).toContain('text/html');
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(app.body)?.[1];
      expect(script).toBeDefined();
      expect((await request(start.port, { path: script! })).status).toBe(200);

      const cookie = await signedIn(start.port, commonDir, env);
      const read = await request(start.port, { path: '/api/op/list?input=%7B%7D', headers: { cookie } });
      expect(read.status, read.body).toBe(200);
      expect((read.json().rows as unknown[]).length).toBe(2);

      const events = await SseClient.connect(start.port, cookie);
      try {
        await events.next((event) => event.event === 'ready');
        const written = await request(start.port, { method: 'POST', path: '/api/op/create', headers: writeHeaders(start.port, cookie), body: JSON.stringify({ title: 'Filed from the dashboard' }) });
        expect(written.status, written.body).toBe(200);
        const id = written.json().id as string;
        const byCli = await cli(shim, ['create', '--title', 'Filed from the CLI while the dashboard watches'], { cwd: root, env: humanEnv() });
        expect(byCli.code, byCli.stdout + byCli.stderr).toBe(0);
        const change = await events.next((event) => event.event === 'change' && (event.data.issues as string[]).includes(byCli.json.id as string), 30_000);
        expect(change.data.issues).toEqual(expect.any(Array));
        expect(id).toMatch(/^gr-/);
      } finally {
        events.close();
      }
    } finally {
      await stopStart(start, commonDir, env);
    }
  });
});
