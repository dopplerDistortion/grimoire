// The call context of a CLI verb (spec §7, §10): what the CLI observes about
// the process that runs it. Agent markers make the call an agent's; a person's
// human-only verb also needs a terminal on both stdin and stdout.
import { randomBytes } from 'node:crypto';
import type { CallContext } from '../../core';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';

/** The agent markers of spec §7: any one set (non-empty) makes a CLI call an agent's. */
export const AGENT_MARKERS = ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID'] as const;

/** What the CLI observes about its process. */
export interface CliProcess {
  /** The start directory: the host repo is its first ancestor that holds `.git`. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Both stdin and stdout are a terminal. */
  readonly tty: boolean;
}

/** The CLI call context of `process`: NO_REPO outside a git checkout. */
export async function cliContext({ cwd, env, tty }: CliProcess): Promise<CallContext> {
  const root = await findHostRoot(cwd);
  const config = await readCheckoutConfig(root);
  const markers = AGENT_MARKERS.filter((marker) => (env[marker] ?? '') !== '');
  return {
    surface: 'cli',
    repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
    person: await readPerson(root),
    client: null,
    evidence: markers.length > 0 ? { agentMarkers: markers } : {},
    tty,
    nonce: randomBytes(8).toString('hex'),
  };
}
