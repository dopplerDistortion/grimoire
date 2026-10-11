import { stat } from 'node:fs/promises';
import path from 'node:path';
import { GrimoireError } from '../errors';
import type { ObjectFormat } from './objects';
import { runGit } from './run';

export interface RepoLocation {
  /** The checkout's top level. */
  readonly root: string;
  /** The git common directory, shared by every worktree of the clone. */
  readonly commonDir: string;
  readonly objectFormat: ObjectFormat;
}

/**
 * Asks git where the checkout rooted at `dir` keeps its shared state, and its
 * object format. `dir` must hold `.git` itself (a host repo's root, spec §7):
 * git's discovery is never allowed to wander up to an enclosing repository.
 */
export async function locateRepo(dir: string): Promise<RepoLocation> {
  const dotGit = await stat(path.join(dir, '.git')).catch(() => null);
  if (!dotGit) throw new GrimoireError('NO_REPO', `no git repository at ${dir}`, { root: dir });
  const run = await runGit(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
    '--show-object-format',
  ]).catch(() => null);
  if (!run || run.code !== 0) {
    throw new GrimoireError('NO_REPO', `no git repository at ${dir}`, { root: dir });
  }
  const [root, commonDir, format] = run.stdout.toString('utf8').split(/\r?\n/);
  if (!root || !commonDir || (format !== 'sha1' && format !== 'sha256')) {
    throw new GrimoireError('NO_REPO', `no usable git repository at ${dir}`, { root: dir });
  }
  return { root: path.normalize(root), commonDir: path.normalize(commonDir), objectFormat: format };
}
