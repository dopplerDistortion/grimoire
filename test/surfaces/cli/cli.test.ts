// Seam 3 for the CLI (spec Testing Decisions; §10, §7): the built `grimoire`
// bin, run as a child process, for the transport and the human-only gate only.
// Without a terminal `skill edit` is refused before any editor opens; the
// agent markers themselves are covered where the CLI builds its call context
// (skill-edit.test.ts), since a child process here never has a terminal.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { gitTest, runCommand } from '#harness';
import { initializeTracker } from '../../core/support';
import { buildGrimoire } from '../mcp/support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

/** The test process's environment without any agent marker (the test may itself run under one). */
function unmarked(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'false' };
  for (const marker of ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID']) delete env[marker];
  return { ...env, ...extra };
}

describe('grimoire skill edit, from the built bin', () => {
  gitTest('without an interactive terminal it prints HUMAN_ONLY and exits 1, marked or not, never naming the marker', async ({ world }) => {
    await initializeTracker(world.a, world.a);

    const noTty = await runCommand(process.execPath, [bin, 'skill', 'edit', 'release-notes'], { cwd: world.a.dir, env: unmarked() });
    const marked = await runCommand(process.execPath, [bin, 'skill', 'edit', 'release-notes'], {
      cwd: world.a.dir,
      env: unmarked({ CODEX_THREAD_ID: 'thread-1' }),
    });

    for (const run of [noTty, marked]) {
      expect(run.code, run.stderr).toBe(1);
      const lines = run.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: 'HUMAN_ONLY', retryable: false } });
      expect(run.stdout + run.stderr).not.toContain('CODEX_THREAD_ID');
    }
  });

  gitTest('--help exits 0 and prints the op’s input schema as the one JSON object', async ({ world }) => {
    const run = await runCommand(process.execPath, [bin, 'skill', 'edit', '--help'], { cwd: world.a.dir, env: unmarked() });

    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      op: 'skill_edit',
      usage: 'grimoire skill edit <name>',
      input: { type: 'object', properties: { name: expect.any(Object), text: expect.any(Object), base: expect.any(Object) } },
      flags: [],
    });
  });

  gitTest('without a skill name it is a usage error, exit 2', async ({ world }) => {
    const run = await runCommand(process.execPath, [bin, 'skill', 'edit'], { cwd: world.a.dir, env: unmarked() });

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/usage: grimoire skill edit <name>/);
  });
});
