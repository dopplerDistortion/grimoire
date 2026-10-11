import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { openTracker } from '../../src/tracker';
import { VERSION } from '../../src/version';
import { coreTest as test, expectRefUnmoved, trackerTip, TRACKER_REF } from './support';

/** The trailers of a commit, as `key: value` lines in order. */
async function trailersOf(checkout: { git(args: readonly string[]): Promise<string> }, commit: string) {
  return (await checkout.git(['log', '-1', '--format=%(trailers:only,unfold)', commit])).split('\n');
}

describe('tracker commits', () => {
  test('a create commit carries the four trailers, with the actor as one-line JSON of ids', async ({
    world,
    grimoire,
  }) => {
    const created = await grimoire.core.call('create', { title: 'Trailered' }, grimoire.ctx);
    const id = created.ok ? created.result.id : '';
    const tip = (await trackerTip(world.a))!;

    expect(await trailersOf(world.a, tip)).toEqual([
      'Grimoire-Actor: {"kind":"agent","client":"claude-code","session":"sess-1","context":"main","call":"call-1","nonce":"nonce-1"}',
      'Grimoire-Op: create',
      `Grimoire-Issue: ${id}`,
      `Grimoire-Version: ${VERSION}`,
    ]);
    expect(await world.a.git(['log', '-1', '--format=%s', tip])).toBe(`grimoire: create ${id}`);
  });

  test('author and committer are the person; a human CLI call records no agent facts', async ({
    world,
    grimoire,
  }) => {
    const ctx = {
      ...grimoire.ctx,
      surface: 'cli' as const,
      client: null,
      evidence: { session: 'ignored', agentMarkers: [] },
    };

    await grimoire.core.call('create', { title: 'By hand' }, ctx);
    const tip = (await trackerTip(world.a))!;

    expect(await world.a.git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', tip])).toBe(
      'Alice Example <alice@example.com>|Alice Example <alice@example.com>',
    );
    expect((await trailersOf(world.a, tip))[0]).toBe('Grimoire-Actor: {"kind":"human","client":"cli","nonce":"nonce-1"}');
  });

  test('a CLI call under an agent marker is an agent actor', async ({ world, grimoire }) => {
    const ctx = {
      ...grimoire.ctx,
      surface: 'cli' as const,
      client: null,
      evidence: { agentMarkers: ['CODEX_THREAD_ID'], session: 'th-9' },
    };

    await grimoire.core.call('create', { title: 'From a shell tool' }, ctx);

    expect((await trailersOf(world.a, (await trackerTip(world.a))!))[0]).toBe(
      'Grimoire-Actor: {"kind":"agent","client":"cli","session":"th-9","nonce":"nonce-1"}',
    );
  });

  test('commits are unsigned even when the repo asks for signing, and no git hook runs', async ({
    world,
    grimoire,
  }) => {
    await world.a.git(['config', 'commit.gpgsign', 'true']);
    await world.a.git(['config', 'user.signingkey', 'DEADBEEF']);
    const marker = path.join(world.root, 'hook-ran');
    const hook = `#!/bin/sh\necho "$0" >> "${marker.replace(/\\/g, '/')}"\n`;
    for (const name of ['reference-transaction', 'pre-commit', 'post-commit', 'post-rewrite']) {
      await writeFile(path.join(world.a.dir, '.git', 'hooks', name), hook, { mode: 0o755 });
    }
    // The hook is live for plain git on this platform…
    await world.a.git(['update-ref', 'refs/probe/hook', 'HEAD']);
    expect(existsSync(marker)).toBe(true);
    await world.a.git(['update-ref', '-d', 'refs/probe/hook']);
    await rm(marker);

    // …but grimoire's writes never run it.
    await grimoire.core.call('create', { title: 'No hooks' }, grimoire.ctx);

    expect(existsSync(marker)).toBe(false);
    expect(await world.a.git(['cat-file', 'commit', TRACKER_REF])).not.toMatch(/^gpgsig/m);
  });

  test('a trailer value with a line break is refused, and the ref does not move', async ({ world, grimoire }) => {
    void grimoire; // initializes the tracker
    const store = await openTracker(world.a.dir);
    try {
      const outcome = await expectRefUnmoved(world.a, () =>
        store
          .transact({ op: 'create', author: { name: 'A', email: 'a@example.com' }, actor: { kind: 'human', nonce: 'n' } }, async (draft) => {
            const id = await draft.mintIssueId();
            draft.putIssue({
              id,
              seq: draft.nextSeq(),
              title: 't',
              status: 'open',
              labels: [],
              parent: null,
              blocked_by: [],
              links: [],
              created_at: '',
              created_by: '',
              updated_at: '',
              body: '',
              extra: {},
            });
            return { result: null, issue: `${id}\nGrimoire-Op: forged` };
          })
          .catch((error: { code?: string }) => error.code),
      );
      expect(outcome).toBe('INVALID');
    } finally {
      await store.close();
    }
  });
});
