// A version copy's entry, `pkg/<version>/dist/launch.mjs` (spec §11, §21's
// launcher↔package contract, frozen): the clone's launcher imports this file
// and calls `launch(args, info)` for every client entry and every shell-shim
// run. `args` are the entry's own arguments; the launcher never reads
// process.argv, and neither does this (spike A R3).
import { fileURLToPath } from 'node:url';
import { exitWith, runEntry } from './entry';

/** What the launcher tells the copy. Fields may only be added. */
export interface LaunchInfo {
  /** The checkout that holds `.git`, as the bootstrap or the shim found it. */
  readonly root: string;
  /** The pinned version (this copy's). */
  readonly pin: string;
  /** `<git-common-dir>/grimoire`. */
  readonly home: string;
  /** This copy's folder, `pkg/<pin>`. */
  readonly copy: string;
  /** The launcher's own version. */
  readonly launcher: number;
}

export async function launch(args: readonly string[], info: LaunchInfo): Promise<void> {
  // This file and grimoire.mjs sit side by side in dist/.
  const bin = fileURLToPath(new URL('./grimoire.mjs', import.meta.url));
  const verb = args[0] === '--from' ? args[2] : args[0];
  // Beside the opening, never before it: the record only has to exist while the server lives.
  if (verb === 'mcp') void import('./mcp/process-record').then(({ recordServer }) => recordServer(info));
  exitWith(await runEntry(args, { bin, startDir: info.root }));
}
