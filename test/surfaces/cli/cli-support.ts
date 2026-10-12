// Shared by the CLI tests (cli.test.ts, cli-gate.test.ts), split in two so that no
// one file holds a whole run up: the CLI test's fixture and its helpers.
import path from 'node:path';
import { expect } from 'vitest';
import type { Clone } from '#harness';
import type { CallContext, Core } from '../../../src/core';
import { MachineLocalStore } from '../../../src/machine-local';
import { coreTest, trackerTip } from '../../core/support';
import { cli } from './support';

/** coreTest whose clone `a` has a tracker, whether or not the test uses the in-process core. */
export const cliTest = coreTest.extend('a', async ({ world }, { onCleanup }) => {
  // No detached sync child of a CLI write outlives its test: the world is removed next.
  onCleanup(() => until(async () => (await machineOf(world.a).processes.live({ role: 'sync' })).length === 0, 'the sync children to exit'));
  return world.a;
});

/** What the CLI builds for a person at their own shell, without a terminal. */
export function personAtShell(clone: Clone): CallContext {
  return {
    surface: 'cli',
    repo: { root: clone.dir, pin: null },
    person: { name: clone.identity.name, email: clone.identity.email },
    evidence: {},
    tty: false,
    nonce: 'test',
  };
}

export async function coreResult(core: Core, name: string, input: unknown, ctx: CallContext): Promise<unknown> {
  const outcome = await core.call(name, input, ctx);
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

export async function until(check: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function machineOf(clone: Clone): MachineLocalStore {
  return new MachineLocalStore(path.join(clone.dir, '.git'));
}

/** The remote's `grimoire/tracker` tip, or null. */
export async function remoteTracker(clone: Clone): Promise<string | null> {
  const run = await clone.gitResult(['ls-remote', 'origin', 'refs/heads/grimoire/tracker']);
  return run.stdout.split('\t')[0]?.trim() || null;
}

/**
 * Waits for the detached sync child of an attempt-ending write to push and
 * exit, so nothing runs in the world when it is removed.
 */
export async function syncedInBackground(clone: Clone): Promise<void> {
  await until(async () => (await remoteTracker(clone)) === (await trackerTip(clone)), 'the background push');
  await until(async () => (await machineOf(clone).processes.live({ role: 'sync' })).length === 0, 'the sync child to exit');
}

/** Creates, claims and closes an issue through the CLI; returns the close's stdout. */
export async function closeThroughCli(bin: string, clone: Clone): Promise<Record<string, unknown>> {
  const { json: created } = await cli(bin, ['create', 'Ship it'], { cwd: clone.dir });
  const { json: claimed } = await cli(bin, ['claim', created.id as string], { cwd: clone.dir });
  const closed = await cli(bin, ['close', created.id as string, 'done', '--attempt', claimed.attempt as string], { cwd: clone.dir });
  expect(closed.code, closed.stdout + closed.stderr).toBe(0);
  return closed.json;
}

/** Every agent marker's name (spec §7); a refusal's message names none of them. */
export const MARKER_NAMES = /AI_AGENT|CLAUDE_CODE_CHILD_SESSION|CODEX_CI|CODEX_THREAD_ID|marker/i;
