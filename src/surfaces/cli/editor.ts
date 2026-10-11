// The person's own editor, for the CLI's human-only edit verbs (spec §17 `wiki
// edit`, §15 `skill edit`): the text goes into a temp copy outside every
// worktree, so it never lands in a checkout, and opens in the editor git would
// use, started the way git starts it.
import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invalid } from '../../errors';
import { runGit } from '../../git/run';

export interface EditWorkspace {
  /** The temp directory: outside every worktree of the repo. */
  readonly dir: string;
  /** Removes the directory and everything in it. */
  remove(): Promise<void>;
}

/** Whether `dir` lies inside `tree` (or is it). */
function inside(dir: string, tree: string): boolean {
  const relative = path.relative(tree, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The root of every worktree of the repo at `root`, as real paths. */
async function worktrees(root: string): Promise<string[]> {
  const run = await runGit(root, ['worktree', 'list', '--porcelain', '-z']);
  const roots = run.code === 0 ? run.stdout.toString('utf8').split('\0').filter((line) => line.startsWith('worktree ')) : [];
  const listed = roots.map((line) => line.slice('worktree '.length));
  return Promise.all([root, ...listed].map((tree) => realpath(tree).catch(() => path.resolve(tree))));
}

/** A fresh temp directory for one edit, checked to lie outside every worktree of the repo at `root`. */
export async function editWorkspace(root: string): Promise<EditWorkspace> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'grimoire-edit-')));
  // Retries the transient Windows failures (EBUSY, EPERM) an editor or a virus scanner still holding a file causes.
  const remove = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if ((await worktrees(root)).some((tree) => inside(dir, tree))) {
    await remove();
    const temp = path.dirname(dir);
    throw invalid(
      { temp_dir: `${temp} lies inside a worktree of this repo` },
      `the temp directory ${temp} lies inside a worktree of this repo, so the text would land in a checkout; point TMPDIR (TEMP and TMP on Windows) outside the repo and run it again`,
    );
  }
  return { dir, remove };
}

/** The editor command git would use: GIT_EDITOR, else what `git var GIT_EDITOR` says (core.editor, VISUAL, EDITOR, vi). */
async function editorCommand(root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env.GIT_EDITOR?.trim();
  if (fromEnv) return fromEnv;
  const run = await runGit(root, ['var', 'GIT_EDITOR']);
  const command = run.stdout.toString('utf8').trim();
  return run.code === 0 && command !== '' ? command : 'vi';
}

/** The `sh` that ships with Git for Windows, next to git's exec path; null when there is none. */
async function gitShell(root: string): Promise<string | null> {
  if (process.platform !== 'win32') return '/bin/sh';
  const run = await runGit(root, ['--exec-path']);
  const exec = run.stdout.toString('utf8').trim();
  if (run.code !== 0 || exec === '') return null;
  for (const candidate of ['../../../bin/sh.exe', '../../../usr/bin/sh.exe', '../../bin/sh.exe', '../../usr/bin/sh.exe']) {
    const shell = path.resolve(exec, candidate);
    if (await access(shell).then(() => true, () => false)) return shell;
  }
  return null;
}

/**
 * Opens `file` in the person's git editor and resolves when they close it. Like
 * git, it runs the command through `sh -c '<editor> "$@"'`, so editor commands
 * with arguments and quoted paths work; on Windows without Git's `sh` it falls
 * back to the system shell. Rejects when the editor exits with an error.
 * `env` is the editor's environment (default: this process's).
 */
export async function openGitEditor(file: string, root: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const editor = await editorCommand(root, env);
  if (editor === ':') return;
  const shell = await gitShell(root);
  // Ctrl-C while the editor is open is the editor's to handle: like git,
  // grimoire ignores SIGINT until the editor closes, so it lives on to clean up.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    const child = shell
      ? spawn(shell, ['-c', `${editor} "$@"`, editor, file], { stdio: 'inherit', env })
      : spawn(`${editor} "${file}"`, { stdio: 'inherit', shell: true, env });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`the editor (${editor}) exited with ${code ?? signal}`));
      });
    });
  } finally {
    process.off('SIGINT', ignore);
  }
}
