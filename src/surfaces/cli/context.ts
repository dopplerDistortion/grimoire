// The call context of a CLI verb (spec §7, §10): what the CLI observes about
// the process that runs it. Agent markers make the call an agent's (./shell.ts
// reads them, with the agent's client and session); a person's human-only verb
// also needs a terminal on both stdin and stdout.
import { randomBytes } from 'node:crypto';
import type { CallContext } from '../../core';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';
import { clientIn, evidenceIn } from './shell';

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
  return {
    surface: 'cli',
    repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
    person: await readPerson(root),
    client: clientIn(env),
    evidence: evidenceIn(env),
    tty,
    ...(env.GRIMOIRE_CHORE_ORIGIN?.trim() ? { choreOrigin: env.GRIMOIRE_CHORE_ORIGIN.trim() } : {}),
    nonce: randomBytes(8).toString('hex'),
  };
}
