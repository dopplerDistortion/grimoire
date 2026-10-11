import { describe, expect } from 'vitest';
import { VERSION } from '../../src/version';
import { commitToTracker, coreTest as test, expectRefUnmoved, trackerFile, trackerTip, TRACKER_REF } from './support';

describe('the tracker ref and its format marker', () => {
  test('the tracker is an orphan history whose root holds the v1 marker and `* -text`', async ({
    world,
    grimoire,
  }) => {
    void grimoire; // initializes the tracker
    const tip = await trackerTip(world.a);

    expect(await world.a.git(['rev-list', '--parents', '-n', '1', tip!])).toBe(tip);
    expect(await world.a.git(['ls-tree', '--name-only', tip!])).toBe('.gitattributes\nformat');
    expect(await trackerFile(world.a, tip!, 'format')).toBe('format: 1\ncompat: 1\nrequires: "1.0.0"\n');
    expect(await trackerFile(world.a, tip!, '.gitattributes')).toBe('* -text\n');
    expect(await world.a.git(['merge-base', tip!, 'main']).catch(() => 'unrelated')).toBe('unrelated');
  });

  test('the local tracker is a ref with a reflog, not a branch', async ({ world, grimoire }) => {
    await grimoire.core.call('create', { title: 'x' }, grimoire.ctx);

    expect(await world.a.git(['branch', '--list', '--all'])).not.toContain('tracker');
    expect((await world.a.git(['reflog', 'show', '--format=%gs', TRACKER_REF])).split('\n')).toHaveLength(2);
  });

  test('a store whose compat is newer than this release gives UPGRADE_REQUIRED on writes and reads', async ({
    world,
    grimoire,
  }) => {
    await commitToTracker(world.a, { format: 'format: 3\ncompat: 2\nrequires: "2.0.0"\n' });
    const { core, ctx } = grimoire;

    const write = await expectRefUnmoved(world.a, () => core.call('create', { title: 'x' }, ctx));
    const read = await core.call('labels', {}, ctx);

    const expected = {
      ok: false,
      error: {
        code: 'UPGRADE_REQUIRED',
        message: expect.stringContaining('relay the remedies'),
        retryable: false,
        details: {
          marker: 'store',
          why: 'newer',
          running: VERSION,
          pin: null,
          requires: '2.0.0',
          remedies: [
            {
              kind: 'upgrade',
              command: 'npx @goksening/grimoire@2.0.0 init --upgrade',
              text: expect.stringContaining('then commit'),
            },
            { kind: 'join', command: 'npx @goksening/grimoire@2.0.0 init', text: expect.any(String) },
          ],
        },
      },
    };
    expect(write).toEqual(expected);
    expect(read).toEqual(expected);
  });

  test('the first remedy is a rebase when the remote default branch already pins a new enough release', async ({
    world,
    grimoire,
  }) => {
    await world.b.commitFile('.grimoire/config.yml', 'version: 2.1.0\ninstall_format: 1\n');
    await world.b.git(['push', '--quiet', 'origin', 'HEAD:main']);
    await world.a.git(['fetch', '--quiet', 'origin']);
    await commitToTracker(world.a, { format: 'format: 2\ncompat: 2\nrequires: "2.0.0"\n' });
    const ctx = { ...grimoire.ctx, repo: { ...grimoire.ctx.repo, pin: '1.0.0' } };

    const outcome = await grimoire.core.call('create', { title: 'x' }, ctx);

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'UPGRADE_REQUIRED',
        details: {
          pin: '1.0.0',
          requires: '2.0.0',
          remedies: [
            { kind: 'rebase', text: expect.stringContaining('origin/main') },
            { kind: 'upgrade', command: 'npx @goksening/grimoire@2.1.0 init --upgrade' },
            { kind: 'join', command: 'npx @goksening/grimoire@2.1.0 init' },
          ],
        },
      },
    });
  });

  test('a store whose compat is older than this release gives UPGRADE_REQUIRED with why: older', async ({
    world,
    grimoire,
  }) => {
    await commitToTracker(world.a, { format: 'format: 0\ncompat: 0\nrequires: "0.1.0"\n' });
    const ctx = { ...grimoire.ctx, repo: { ...grimoire.ctx.repo, pin: '1.0.0' } };

    const outcome = await expectRefUnmoved(world.a, () => grimoire.core.call('create', { title: 'x' }, ctx));

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'UPGRADE_REQUIRED',
        details: {
          marker: 'store',
          why: 'older',
          running: VERSION,
          pin: '1.0.0',
          requires: '0.1.0',
          remedies: [{ kind: 'init', command: 'npx @goksening/grimoire@1.0.0 init' }],
        },
      },
    });
  });

  test('a later format with compat still in range runs normally (J ≤ compat ≤ K)', async ({ world, grimoire }) => {
    await commitToTracker(world.a, { format: 'format: 4\ncompat: 1\nrequires: "1.0.0"\nnew_field: true\n' });

    const created = await grimoire.core.call('create', { title: 'Still fine' }, grimoire.ctx);

    expect(created).toMatchObject({ ok: true, result: { created: true } });
    const tip = await trackerTip(world.a);
    expect(await trackerFile(world.a, tip!, 'format')).toBe('format: 4\ncompat: 1\nrequires: "1.0.0"\nnew_field: true\n');
  });
});
