// Shared by the fold tests (folds.test.ts, folds-attempts.test.ts, folds-records.test.ts),
// split in three so that no one file holds a whole run up: two clones, a bare remote,
// and the issues both clones hold.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CallContext, Core } from '../../src/core';
import { agentContext, fetchTracker, pushTracker, T0, TRACKER_REF, type Grimoire } from './support';
import type { GitWorld } from '#harness';

export async function createIssue(core: Core, ctx: CallContext, input: Record<string, unknown>): Promise<string> {
  const created = await core.call('create', input, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

/** Both clones on one tracker: a pushes it, b fetches it. */
export async function shared(world: GitWorld, grimoire: Grimoire): Promise<{ alice: CallContext; bob: CallContext }> {
  await pushTracker(world.a);
  await fetchTracker(world.b);
  return { alice: grimoire.ctx, bob: agentContext(world.b) };
}

/** b publishes its tracker and a fetches it: a's local and remote-tracking tips diverge. */
export async function bobPublishes(world: GitWorld): Promise<void> {
  await pushTracker(world.b);
  await fetchTracker(world.a);
}

/** A minute after T0: Bob's clock in tests where his change is the later one. */
export const T1 = new Date(T0.getTime() + 60_000);

/** An issue both clones hold: created and published by a, fetched by b. */
export async function sharedIssue(world: GitWorld, core: Core, alice: CallContext, input: Record<string, unknown>): Promise<string> {
  const id = await createIssue(core, alice, input);
  await pushTracker(world.a);
  await fetchTracker(world.b);
  return id;
}

export const MAP = '# Map\n\n## Next\n- [ ] first\n- [ ] second\n\n## Done\n- [x] zero\n';

export const DEBRIEF = { asked: 'a', tried: 'b', failed: 'none', worked: 'c', next: 'none' };

/** Both clones retitle the shared issue; Bob's change is later, so Alice's is set aside. */
export async function titleConflict(world: GitWorld, grimoire: Grimoire, alice: CallContext, bob: CallContext, id: string) {
  const bobCore = grimoire.makeCore({ clock: () => T1 });
  await grimoire.core.call('update', { id, title: 'Alice’s title' }, alice);
  await bobCore.call('update', { id, title: 'Bob’s title' }, bob);
  await bobPublishes(world);
}

/** Lets b write raw commits: its local tracker starts where the fetched one is. */
export async function bobTracksRemote(world: GitWorld): Promise<void> {
  await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
}

export const setting = (value: unknown, at: string, by: string) => JSON.stringify({ value, at, by });

/** The two sides of the gr-k1m0x collision, by whose record each is. */
export async function renamedIds(core: Core, ctx: CallContext): Promise<{ alice: string; bob: string }> {
  const listed = await core.call('list', {}, ctx);
  const rows = listed.ok ? listed.result.rows : [];
  const find = (title: string) => rows.find((row) => row.title === title)?.id ?? `missing ${title}`;
  return { alice: find('Alice’s k1m0x'), bob: find('Bob’s k1m0x') };
}

/** Every object file in the clone's object database (loose objects and packs). */
export async function looseObjects(dir: string): Promise<string[]> {
  const root = path.join(dir, '.git', 'objects');
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  return files
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}
