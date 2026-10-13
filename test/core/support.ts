// Shared setup for the core-operations seam (spec Testing Decisions, seam 1):
// a git world whose clone a holds an initialized tracker, a core, and call contexts.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createGitWorld, makeTempDir, removeDir, type Checkout, type Clone, type WorldTemplate } from '#harness';
import { createCore, type CallContext, type Core, type CoreOptions } from '../../src/core';
import { openTracker } from '../../src/tracker';

export const TRACKER_REF = 'refs/grimoire/tracker';

/** A fixed instant, so records and commits are byte-predictable. */
export const T0 = new Date('2026-10-11T03:15:08.750Z');

/** An MCP call from Claude Code in `checkout`, made on behalf of `clone`'s person. */
export function agentContext(clone: Clone, checkout: Checkout = clone): CallContext {
  return {
    surface: 'mcp',
    repo: { root: checkout.dir, pin: null },
    person: { name: clone.identity.name, email: clone.identity.email },
    client: { name: 'claude-code', version: '2.1.296' },
    evidence: { session: 'sess-1', context: 'main', callId: 'call-1' },
    nonce: 'nonce-1',
  };
}

/** Creates the tracker ref in `checkout` (what `init` will do). */
export async function initializeTracker(checkout: Checkout, clone: Clone): Promise<string> {
  const store = await openTracker(checkout.dir);
  try {
    const { root } = await store.initialize({
      author: { name: clone.identity.name, email: clone.identity.email },
      actor: { kind: 'human', client: 'cli', nonce: 'init' },
    });
    return root;
  } finally {
    await store.close();
  }
}

/** The tracker tip in `checkout`, or null when the ref doesn't exist. */
export async function trackerTip(checkout: Checkout): Promise<string | null> {
  const result = await checkout.gitResult(['rev-parse', '--verify', '--quiet', TRACKER_REF]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Raw bytes of a file at a tracker commit, as a string (no trimming). */
export async function trackerFile(checkout: Checkout, commit: string, path: string): Promise<string> {
  const result = await checkout.gitResult(['cat-file', 'blob', `${commit}:${path}`]);
  if (result.code !== 0) throw new Error(`no ${path} at ${commit}: ${result.stderr}`);
  return result.stdout;
}

/** Runs `action` and asserts the tracker ref did not move ("an error means nothing changed"). */
export async function expectRefUnmoved<T>(checkout: Checkout, action: () => Promise<T>): Promise<T> {
  const before = await trackerTip(checkout);
  const value = await action();
  expect(await trackerTip(checkout)).toBe(before);
  return value;
}

/**
 * Commits raw file changes onto the tracker ref with plain git, the way
 * another writer (a future release, a hand edit) would. `null` removes a file.
 */
export async function commitToTracker(
  checkout: Checkout,
  files: Record<string, string | null>,
  message = 'simulated writer',
): Promise<string> {
  const tip = await trackerTip(checkout);
  const env = { GIT_INDEX_FILE: path.join(checkout.dir, '.git', 'grimoire-test-index') };
  try {
    if (tip) await checkout.git(['read-tree', tip], { env });
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        await checkout.git(['update-index', '--force-remove', '--', file], { env });
      } else {
        const oid = await checkout.git(['hash-object', '-w', '--stdin'], { input: content });
        await checkout.git(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], { env });
      }
    }
    const tree = await checkout.git(['write-tree'], { env });
    const commit = await checkout.git(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', message]);
    await checkout.git(['update-ref', TRACKER_REF, commit]);
    return commit;
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

/** Publishes `checkout`'s tracker as the remote's `grimoire/tracker` branch. */
export async function pushTracker(checkout: Checkout): Promise<void> {
  await checkout.git(['push', '--quiet', 'origin', `+${TRACKER_REF}:refs/heads/grimoire/tracker`]);
}

/** Fetches the remote's `grimoire/tracker` into `checkout`'s remote-tracking ref. */
export async function fetchTracker(checkout: Checkout): Promise<void> {
  await checkout.git([
    'fetch',
    '--quiet',
    'origin',
    '+refs/heads/grimoire/tracker:refs/remotes/origin/grimoire/tracker',
  ]);
}

/**
 * Fetches `other`'s local tracker straight into `checkout`'s remote-tracking
 * ref, as if `other` had pushed it: lets two diverged clones each see the other.
 */
export async function fetchTrackerFrom(checkout: Checkout, other: Checkout): Promise<void> {
  await checkout.git(['fetch', '--quiet', other.dir, `+${TRACKER_REF}:refs/remotes/origin/grimoire/tracker`]);
}

/** A random-suffix source that hands out `suffixes` in order (then fails). */
export function suffixQueue(...suffixes: string[]): (length: number) => string {
  return () => {
    const next = suffixes.shift();
    if (next === undefined) throw new Error('suffixQueue ran dry');
    return next;
  };
}

/** The sharded path of an issue record (spec §3 Layout). */
export function issuePath(id: string): string {
  return `issues/${id[3]}/${id[4]}/${id}/issue.md`;
}

export interface Grimoire {
  core: Core;
  /** An MCP agent context in clone a, as Alice. */
  ctx: CallContext;
  /** Builds another core over the same machine, for multi-core tests (closed after the test). */
  makeCore(options?: CoreOptions): Core;
}

/** A git world whose clone a holds an initialized tracker: built once per test file, then copied (see createGitWorld). */
const WITH_TRACKER: WorldTemplate = { name: 'tracker', prepare: (world) => initializeTracker(world.a, world.a).then(() => undefined) };

/**
 * `gitTest`'s `world`, but its clone a holds an initialized tracker (every
 * world of a test file starts from the same tracker root), plus a `grimoire`
 * fixture: `grimoire.core` is a core with a fixed clock. Tests that need other
 * core options build their own with `grimoire.makeCore(…)`.
 */
export const coreTest = test.extend('world', async ({}, { onCleanup }) => {
  const world = await createGitWorld(WITH_TRACKER);
  onCleanup(() => world.cleanup());
  return world;
}).extend('grimoire', async ({ world }, { onCleanup }) => {
  const cores: Core[] = [];
  onCleanup(async () => {
    for (const core of cores) await core.close();
  });
  const makeCore = (options: CoreOptions = {}): Core => {
    // Background syncs would push to the world's remote behind a test's back: tests opt in.
    const core = createCore({ clock: () => T0, autoSync: 'off', ...options });
    cores.push(core);
    return core;
  };
  const grimoire: Grimoire = { core: makeCore(), ctx: agentContext(world.a), makeCore };
  return grimoire;
});

/**
 * Bundles `call-process.ts` (or another script beside it) into a temp dir, for
 * tests that run core calls in separate processes. Returns the script's path
 * and a cleanup.
 */
export async function bundleCallProcess(entry = 'call-process.ts'): Promise<{ script: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir('grimoire-caller-');
  const script = path.join(dir, entry.replace(/\.ts$/, '.mjs'));
  await esbuild.build({
    entryPoints: [fileURLToPath(new URL(`./${entry}`, import.meta.url))],
    outfile: script,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __GRIMOIRE_VERSION__: JSON.stringify('0.0.0-test') },
    logLevel: 'silent',
  });
  return { script, cleanup: () => removeDir(dir) };
}
