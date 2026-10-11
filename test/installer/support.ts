// Shared setup for the installer's tests: packages to install as version
// copies, joined clones, and client entries run as the clients run them.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { makeTempDir, removeDir, runCommand, type RunResult } from '#harness';
import { installCopy, installLauncher, writeJoinRecord, type CopySource } from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * A package folder for `version` whose `dist/launch.mjs` reports how the
 * launcher entered it (its version, args, info, cwd and the stdin a hook got)
 * instead of running grimoire. `failing` makes its entry throw.
 */
export async function reportingPackage(parent: string, version: string, options: { failing?: boolean } = {}): Promise<string> {
  const dir = path.join(parent, `package-${version}`);
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: '@goksening/grimoire', version })}\n`);
  const body = options.failing
    ? "export async function launch() { throw new Error('the copy failed to start'); }\n"
    : [
        "import { readFileSync } from 'node:fs';",
        'export async function launch(args, info) {',
        "  const words = args[0] === '--from' ? args.slice(2) : args;",
        "  const stdin = words[0] === 'hook' ? readFileSync(0, 'utf8') : '';",
        `  process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, args, info, cwd: process.cwd(), stdin }));`,
        '}',
        '',
      ].join('\n');
  await writeFile(path.join(dir, 'dist', 'launch.mjs'), body);
  return dir;
}

/** What `init` does on this machine for a pin (spec §12 step 5): the copy, the launcher, the join record. */
export async function joinClone(store: MachineLocalStore, version: string, source: CopySource): Promise<void> {
  await installCopy(store, version, source);
  await installLauncher(store);
  await writeJoinRecord(store, version, { excerpt_mode: 'facts', codex_hook_hash: null, joined_at: Date.now() });
}

/** Writes `.grimoire/config.yml` pinning `pin`, as `init` commits it. */
export async function writeConfig(root: string, pin: string): Promise<void> {
  await mkdir(path.join(root, '.grimoire'), { recursive: true });
  await writeFile(path.join(root, '.grimoire', 'config.yml'), `version: ${pin}\ninstall_format: 1\n`);
}

/** Runs `node <args>` the way an agent client spawns an entry: no shell, `${CLAUDE_PROJECT_DIR}` substituted. */
export function runEntry(
  args: readonly string[],
  options: { cwd: string; projectDir?: string; input?: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  const substituted = args.map((arg) => (options.projectDir === undefined ? arg : arg.replace('${CLAUDE_PROJECT_DIR}', options.projectDir)));
  return runCommand(process.execPath, substituted, { cwd: options.cwd, input: options.input ?? '', env: options.env, timeoutMs: 60_000 });
}

/** What a reporting copy printed. */
export interface Report {
  version: string;
  args: string[];
  info: { root: string; pin: string; home: string; copy: string; launcher: number };
  cwd: string;
  stdin: string;
}

export function reportOf(result: RunResult): Report {
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Report;
}

/** npm's own CLI script, run with this node (no shell, no PATH lookup). */
function npmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => file !== undefined && /npm-cli\.js$/.test(file) && existsSync(file));
  if (!found) throw new Error('npm-cli.js not found next to this node');
  return found;
}

/** `npm pack` of a package folder: the tarball's path and the integrity npm reports for it. */
export function npmPack(packageDir: string, destination: string): { tarball: string; integrity: string } {
  const result = spawnSync(process.execPath, [npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: packageDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  expect(result.status, result.stderr).toBe(0);
  const [packed] = JSON.parse(result.stdout) as { filename: string; integrity: string }[];
  return { tarball: path.join(destination, packed!.filename), integrity: packed!.integrity };
}

/** The environment a developer's shell would give `npm run build`, minus Vitest's markers. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && !key.startsWith('VITEST')) env[key] = value;
  }
  return env;
}

/**
 * Builds grimoire's CLI as `version` into a package folder laid out as
 * published (package.json, dist/), packs it with npm, and returns the
 * tarball, npm's integrity for it, and a cleanup.
 */
export async function packGrimoire(version: string): Promise<{ tarball: string; integrity: string; packageDir: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir('grimoire-pack-');
  try {
    const packageDir = path.join(dir, 'package');
    const built = await runCommand(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'build.mjs'), 'cli', '--out-dir', path.join(packageDir, 'dist'), '--version', version],
      { cwd: repoRoot, env: buildEnv() },
    );
    expect(built.code, built.stdout + built.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(path.join(packageDir, 'package.json'), `${JSON.stringify({ ...manifest, version, devDependencies: undefined, scripts: undefined }, null, 2)}\n`);
    const { tarball, integrity } = npmPack(packageDir, dir);
    return { tarball, integrity, packageDir, cleanup: () => removeDir(dir) };
  } catch (error) {
    // A failed build or pack leaves nothing behind, and its own error is the one reported.
    await removeDir(dir);
    throw error;
  }
}

/**
 * Installs a packed tarball the way `npx` installs a package: `npm install`
 * into a fresh prefix, which records npm's integrity for it in
 * `node_modules/.package-lock.json`. Returns the package's bin.
 */
export function npxInstall(tarball: string, prefix: string): string {
  const result = spawnSync(
    process.execPath,
    [npmCli(), 'install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', tarball],
    { cwd: prefix, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return path.join(prefix, 'node_modules', '@goksening', 'grimoire', 'dist', 'grimoire.mjs');
}
