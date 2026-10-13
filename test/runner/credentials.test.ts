// Seam 1 (spec §16 Billing guard: "Credential files are never read"): the
// guard asks the client which login it would bill and never opens a
// credential file itself. Asserted by tracking every file this process opens
// or reads (node:fs and node:fs/promises, patched for the test) through a
// whole enable and run, for both clients, with credential files planted where
// each client keeps them.
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, onTestFinished } from 'vitest';
import { enableRunner, runChores } from '../../src/runner';
import { coreTest as test } from '../core/support';
import { agentsForTest, dueCompile, noPatternAnswer } from './scenario';
import { authStatus, claudeAnswer, codexAnswer, makeTempDir } from './support';

type Patched = Record<string, (...args: unknown[]) => unknown>;

/** Records the path of every file opened or read through node:fs until the test ends. */
function trackFileAccess(): string[] {
  const seen: string[] = [];
  const note = (target: unknown) => {
    if (typeof target === 'string') seen.push(path.resolve(target));
    else if (target instanceof URL) seen.push(path.resolve(target.pathname));
    else if (Buffer.isBuffer(target)) seen.push(path.resolve(target.toString()));
  };
  const wrap = (owner: Patched, names: string[]) => {
    for (const name of names) {
      const original = owner[name];
      if (typeof original !== 'function') continue;
      owner[name] = function (this: unknown, ...args: unknown[]) {
        note(args[0]);
        return original.apply(this, args);
      };
      onTestFinished(() => {
        owner[name] = original;
        syncBuiltinESMExports();
      });
    }
  };
  wrap(fs as unknown as Patched, ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'openAsBlob']);
  wrap(fs.promises as unknown as Patched, ['open', 'readFile']);
  syncBuiltinESMExports();
  return seen;
}

/** A home folder holding each client's credential files, and the env that points the clients at it. */
async function plantedHome(): Promise<{ files: string[]; env: NodeJS.ProcessEnv }> {
  const home = await makeTempDir('grimoire-home-');
  const files = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.codex', 'config.toml'),
  ];
  for (const file of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"secret":"never-read"}');
  }
  return { files, env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') } };
}

describe('the runner never opens a credential file', () => {
  test('claude: enable and a run open none of them', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await agentsForTest();
    const home = await plantedHome();
    await fake.plan('claude', { auth: authStatus('claude-ai'), answers: [claudeAnswer(noPatternAnswer(d.pairs))] });
    const env = fake.env(home.env);
    const opened = trackFileAccess();

    await enableRunner({ root: world.a.dir, kind: 'claude', allowApiBilling: false, env });
    const report = await runChores({ root: world.a.dir, core: d.core, env, now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'compiled' })]);
    // The tracking saw this run's own files: it works.
    expect(opened.length).toBeGreaterThan(0);
    const home0 = path.dirname(path.dirname(home.files[0]!));
    expect(opened.filter((file) => file.startsWith(home0))).toEqual([]);
  });

  test('codex: enable and a run open none of them', async ({ world, grimoire }) => {
    const d = await dueCompile(grimoire);
    const fake = await agentsForTest();
    const home = await plantedHome();
    await fake.plan('codex', { login: { stdout: 'Logged in using ChatGPT\n', code: 0 }, mcp: { stdout: '[]', code: 0 }, answers: [codexAnswer(noPatternAnswer(d.pairs))] });
    const env = fake.env(home.env);
    const opened = trackFileAccess();

    await enableRunner({ root: world.a.dir, kind: 'codex', allowApiBilling: false, env });
    const report = await runChores({ root: world.a.dir, core: d.core, env, now: d.clock.now, due: true });

    expect(report.runs).toEqual([expect.objectContaining({ result: 'compiled' })]);
    // The answer file was read through the tracked calls.
    expect(opened.some((file) => path.basename(file) === 'answer.json')).toBe(true);
    const home0 = path.dirname(path.dirname(home.files[0]!));
    expect(opened.filter((file) => file.startsWith(home0))).toEqual([]);
  });
});
