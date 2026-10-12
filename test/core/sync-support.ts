// Shared by the sync tests (sync.test.ts, sync-clones.test.ts), split in two so that
// no one file holds a whole run up.
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { autoSync, type CallContext, type Core } from '../../src/core';
import { openTracker, type NetworkGit, type TrackerStore } from '../../src/tracker';
import { runNetworkGit, type NetworkGitRun } from '../../src/tracker/remote';
import { agentContext, type Grimoire } from './support';
import { git, type Checkout, type GitWorld } from '#harness';

/** A remote pre-receive hook that rejects every push the way GitHub's rulesets do. */
export const REJECTING_HOOK = [
  '#!/bin/sh',
  'echo "GH013: Repository rule violations found for refs/heads/grimoire/tracker." >&2',
  'exit 1',
  '',
].join('\n');

export const DEBRIEF = { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' };

export async function ok<T>(outcome: Promise<{ ok: true; result: T } | { ok: false; error: unknown }>): Promise<T> {
  const settled = await outcome;
  if (!settled.ok) throw new Error(`call failed: ${JSON.stringify(settled.error)}`);
  return settled.result;
}

/** Creates an issue, claims it and closes it as done: an attempt-ending write. */
export async function closeOne(core: Core, ctx: CallContext, title = 'Fix the flaky test'): Promise<string> {
  const { id } = await ok(core.call('create', { title }, ctx));
  const { attempt } = await ok(core.call('claim', { id }, ctx));
  await ok(core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  return id;
}

/** The remote's `grimoire/tracker` tip, or null. */
export async function remoteTracker(checkout: Checkout): Promise<string | null> {
  const run = await checkout.gitResult(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return run.stdout.split('\t')[0]?.trim() || null;
}

/** A core that syncs in-process after attempt-ending writes, as a long-lived process does. */
export function syncingCore(grimoire: Grimoire): Core {
  return grimoire.makeCore({ autoSync: 'in-process' });
}

/** Runs `body` with `checkout`'s tracker store open, closing it before the world is removed. */
export async function withTracker<T>(checkout: Checkout, body: (tracker: TrackerStore) => Promise<T>): Promise<T> {
  const tracker = await openTracker(checkout.dir);
  try {
    return await body(tracker);
  } finally {
    await tracker.close();
  }
}

export async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** A clone of the world's remote made with extra `git clone` flags, committing as Carol. */
export async function cloneWith(world: GitWorld, name: string, flags: readonly string[]): Promise<{ dir: string; ctx: CallContext }> {
  const dir = path.join(world.root, name);
  await git(world.root, ['clone', '--quiet', ...flags, '-c', 'user.name=Carol Example', '-c', 'user.email=carol@example.com', world.remoteUrl, dir]);
  const ctx: CallContext = { ...agentContext(world.b), repo: { root: dir, pin: null }, person: { name: 'Carol Example', email: 'carol@example.com' } };
  return { dir, ctx };
}

export async function errorOf(
  outcome: Promise<{ ok: boolean; error?: unknown }>,
): Promise<{ code: string; message: string; details: Record<string, unknown> }> {
  const settled = await outcome;
  if (settled.ok) throw new Error('expected an error');
  return settled.error as { code: string; message: string; details: Record<string, unknown> };
}

/** Writes `.grimoire/config.yml` naming tracker root `root` into `dir` (what `init` will commit). */
export async function nameRoot(dir: string, root: string): Promise<void> {
  await mkdir(path.join(dir, '.grimoire'), { recursive: true });
  await writeFile(path.join(dir, '.grimoire', 'config.yml'), `version: "0.0.0"\ninstall_format: 1\ntracker_root: "${root}"\n`);
}

/** The root commit R of `checkout`'s tracker. */
export function rootOf(checkout: Checkout): Promise<string> {
  return checkout.git(['rev-list', '--max-parents=0', 'refs/grimoire/tracker']);
}

/** How git answers a push that lost a race, by kind: the porcelain summary and what the remote said. */
export const LOST_RACES: readonly (readonly [string, string])[] = [
  // The remote moved since the fetch.
  ['[rejected] (fetch first)', ''],
  // Another push moved it while this one ran: the remote's compare-and-set failed.
  ['[remote rejected] (failed to update ref)', "remote: error: cannot lock ref 'refs/heads/grimoire/tracker': is at 1111111111111111111111111111111111111111 but expected 2222222222222222222222222222222222222222\n"],
  // Another push held the ref's lock.
  ['[remote rejected] (failed to update ref)', "remote: error: cannot lock ref 'refs/heads/grimoire/tracker': Unable to create '/srv/remote.git/refs/heads/grimoire/tracker.lock': File exists.\n"],
  ['[rejected] (non-fast-forward)', ''],
];

/**
 * A remote busy with other clones' pushes, standing in for sync's network git:
 * each of the first `lost` pushes loses a race, answered the way git answers
 * each kind in turn; the pushes after those reach the real remote. The other
 * clones' pushes never land here, so the remote's refs stay as first listed
 * until a push of Alice's does: each round's `ls-remote` is answered from that
 * listing rather than spawning git again. The pauses before retries are
 * recorded, not waited out.
 */
export function busyRemote(lost: number): { network: NetworkGit; pause: (ms: number) => Promise<void>; pushes: () => number; pauses: number[] } {
  let pushes = 0;
  let listing: NetworkGitRun | null = null;
  const pauses: number[] = [];
  const network: NetworkGit = async (cwd, args, options) => {
    if (args[0] === 'ls-remote' && pushes < lost) {
      listing ??= await runNetworkGit(cwd, args, options);
      return listing;
    }
    if (args[0] !== 'push' || ++pushes > lost) return runNetworkGit(cwd, args, options);
    const [summary, said] = LOST_RACES[(pushes - 1) % LOST_RACES.length]!;
    const stdout = `To ${args.at(-2)}\n!\t${args.at(-1)}\t${summary}\nDone\n`;
    return { code: 1, stdout: Buffer.from(stdout), stderr: `${said}error: failed to push some refs to '${args.at(-2)}'\n`, timedOut: false };
  };
  return { network, pause: async (ms) => void pauses.push(ms), pushes: () => pushes, pauses };
}
