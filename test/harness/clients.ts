import os from 'node:os';
import path from 'node:path';

/** Where the harness points the agent clients' folders: a path that never exists. */
export const NO_CLIENT_HOME = path.join(os.tmpdir(), 'grimoire-test-no-client-home');

/**
 * Points `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME` at a folder that doesn't
 * exist, so code under test that looks for transcripts (the attempt-end cut,
 * sweeps) never reads the user's own Claude Code or Codex sessions, in this
 * process or in the grimoire processes it spawns. Tests that want transcripts
 * pass their own folders, or stub the variables.
 */
export function isolateAgentClients(env: NodeJS.ProcessEnv = process.env): void {
  env.CLAUDE_CONFIG_DIR = path.join(NO_CLIENT_HOME, '.claude');
  env.CODEX_HOME = path.join(NO_CLIENT_HOME, '.codex');
}
