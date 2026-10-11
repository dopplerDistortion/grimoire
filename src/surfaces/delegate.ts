// The `grimoire` bin run directly (spec §10): `npx @goksening/grimoire <verb>`
// for any verb but `init`, `leave` and `uninstall` runs the checkout's pinned,
// joined copy through the clone's launcher, in this process; with no launcher
// it prints the join command and exits 3. It never re-executes itself through
// npx. A checkout grimoire isn't installed in (no config.yml), and a version
// copy's own bin (the sync child's), run the verb right here.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCheckoutConfig } from '../core/host';
import { joinCommand, notSetUpLine } from '../installer/bootstrap';
import { isStrictSemver } from '../installer/semver';
import { findGitDirs } from '../machine-local/git-dirs';

/** Verbs that always run as the version invoked: they install, move or remove pins. */
const OWN_VERBS = new Set(['init', 'leave', 'uninstall']);

/** `--from <dir>` or `--from=<dir>` before any `--`, else the cwd. */
function startDirOf(argv: readonly string[], cwd: string): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') break;
    if (arg.startsWith('--from=')) return path.resolve(cwd, arg.slice('--from='.length));
    if (arg === '--from' && argv[i + 1] !== undefined) return path.resolve(cwd, argv[i + 1]!);
  }
  return cwd;
}

export interface DelegateOptions {
  /** The running `grimoire.mjs`. */
  readonly bin: string;
  readonly cwd: string;
}

/**
 * `local`: run the verb in this process as this version. `launched`: the
 * pinned copy ran it (and set the exit code). A number: the exit code, after
 * the not-set-up line.
 */
export async function delegate(argv: readonly string[], options: DelegateOptions): Promise<'local' | 'launched' | number> {
  const words = argv[0] === '--from' ? argv.slice(2) : argv;
  const verb = words[0];
  if (verb === undefined || verb.startsWith('-') || verb === 'help' || OWN_VERBS.has(verb)) return 'local';
  // A version copy (pkg/<v>/dist/grimoire.mjs, beside pkg/<v>/.complete) is the pinned copy already.
  if (existsSync(path.join(path.dirname(path.dirname(options.bin)), '.complete'))) return 'local';

  const dirs = await findGitDirs(startDirOf(argv, options.cwd));
  if (!dirs) return 'local';
  const config = await readCheckoutConfig(dirs.worktree).catch(() => null);
  if (!config) return 'local';

  // The hook verbs keep their rules: only session-start speaks, on stdout, and every hook exits 0.
  const tell = (line: string): number => {
    if (verb === 'hook') {
      if (words[1] === 'session-start') process.stdout.write(`${line}\n`);
      return 0;
    }
    process.stderr.write(`${line}\n`);
    return 3;
  };
  const strict = config.pin !== null && isStrictSemver(config.pin);
  const launcher = path.join(dirs.commonDir, 'grimoire', 'launcher.cjs');
  if (existsSync(launcher)) {
    try {
      const launch = createRequire(import.meta.url)(launcher) as (args: readonly string[], root: string) => Promise<void>;
      await launch(argv, dirs.worktree);
      return 'launched';
    } catch (error) {
      // A launcher that fails to load is one `init` replaces (it fails its self-check). A hook says
      // nothing, as the bootstrap does when the launcher throws.
      if (verb === 'hook') return 0;
      const message = error instanceof Error ? error.message : String(error);
      return tell(`grimoire's launcher ${launcher} failed to load (${message}); ask the user to run \`${joinCommand(strict ? config.pin : null)}\``);
    }
  }
  return tell(
    strict
      ? notSetUpLine(config.pin)
      : `grimoire can't run here: .grimoire/config.yml pins ${JSON.stringify(config.pin)}, which is not a strict semver version`,
  );
}
