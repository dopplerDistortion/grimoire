// Shared by the seam-1 `init` tests (init-rules.test.ts, init-checkout.test.ts), split in
// two so that no one file holds a whole run up: runInit in process, and its helpers.
import path from 'node:path';
import { expect } from 'vitest';
import { runCommand, type Checkout, type Clone } from '#harness';
import type { Identity } from '../../src/core/context';
import { readPerson } from '../../src/core/host';
import { runInit, type InitFlags, type InitReport, type Prompter } from '../../src/installer/init';
import { openTracker } from '../../src/tracker';
import { reportingPackage } from './support';

export const VERSION = '1.0.0-test.2';

export const NO_FLAGS: InitFlags = { yes: true, clients: null, excerpts: null, newTracker: false, adapter: false };

export interface InitRun {
  readonly report: InitReport;
  /** What init showed the person, joined. */
  readonly said: string;
}

/**
 * `init` in `root` as `runInit` runs it for the CLI. With no `answers` it runs
 * as under --yes; with `answers` each question is matched in turn and
 * answered, and a question nothing matches fails the test.
 */
export async function initIn(
  root: string,
  options: { flags?: Partial<InitFlags>; answers?: { when: RegExp; type: string }[]; person?: Identity; dryRun?: boolean } = {},
): Promise<InitRun> {
  const said: string[] = [];
  const answers = options.answers ? [...options.answers] : null;
  const prompter: Prompter | null = answers
    ? {
        async ask(question) {
          said.push(question);
          const at = answers.findIndex((answer) => answer.when.test(question));
          if (at < 0) throw new Error(`unexpected question: ${question}`);
          return answers.splice(at, 1)[0]!.type;
        },
      }
    : null;
  const report = await runInit({
    root,
    flags: { ...NO_FLAGS, yes: answers === null, ...options.flags },
    source: { dir: await reportingPackage(path.dirname(root), VERSION), integrity: null },
    version: VERSION,
    person: options.person ?? (await readPerson(root)),
    nonce: 'test',
    prompter,
    say: (text) => said.push(text),
    ...(options.dryRun ? { dryRun: true } : {}),
  });
  return { report, said: said.join('\n') };
}

/** Mints a tracker in `clone` and commits and pushes what init wrote, as the person who installed grimoire does. */
export async function installAndPush(clone: Clone, flags: Partial<InitFlags> = {}): Promise<{ report: InitReport; trackerRoot: string }> {
  const { report } = await initIn(clone.dir, { flags });
  await clone.git(['add', '-A']);
  await clone.git(['commit', '--quiet', '-m', 'install grimoire']);
  await clone.git(['push', '--quiet', 'origin', 'main']);
  return { report, trackerRoot: await clone.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']) };
}

/** A new tracker root minted in `clone` (as `init --new-tracker` does) and forced onto the remote's branch. */
export async function replaceTrackerOnRemote(clone: Clone): Promise<string> {
  const store = await openTracker(clone.dir);
  try {
    const { root } = await store.initialize(
      { author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'human', client: 'cli', nonce: 'test' } },
      { replace: true },
    );
    await clone.git(['push', '--quiet', '--force', 'origin', 'refs/grimoire/tracker:refs/heads/grimoire/tracker']);
    return root;
  } finally {
    await store.close();
  }
}

/** The roots of the history at `rev`. */
export async function rootsAt(checkout: Checkout, rev: string): Promise<string[]> {
  return (await checkout.git(['rev-list', '--max-parents=0', rev])).split('\n');
}

/** A clone of a bare remote that has no branch yet, so no default branch. */
export async function cloneOfEmptyRemote(root: string): Promise<string> {
  const empty = path.join(root, 'empty.git');
  await runCommand('git', ['init', '--quiet', '--bare', empty], { cwd: root });
  const clone = path.join(root, 'c');
  const cloned = await runCommand('git', ['clone', '--quiet', '-c', 'user.name=Carol', '-c', 'user.email=carol@example.com', empty, clone], { cwd: root });
  expect(cloned.code, cloned.stderr).toBe(0);
  return clone;
}
