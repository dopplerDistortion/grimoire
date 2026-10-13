// Git's words in another language (contributing.md portability): the write
// path and sync read git's stderr (a lost compare-and-set, a held ref lock),
// and git translates those lines into the UI language. Every git grimoire runs
// gets the C locale, so a German git reads like any other. Seam 1: the git
// environment, and the store against real git in temp repos.
import { describe, expect, vi } from 'vitest';
import { cleanGitEnv } from '../../src/git/run';
import { openTracker, type WriteSpec } from '../../src/tracker';
import { networkGitEnv } from '../../src/tracker/remote';
import { coreTest, trackerTip, TRACKER_REF } from './support';

const GERMAN = { LANG: 'de_DE.UTF-8', LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', PATH: '/usr/bin' };

function keyWrite(key: string): WriteSpec {
  return {
    op: 'test',
    author: { name: 'A', email: 'a@example.com' },
    actor: { kind: 'human', nonce: 'n' },
    idempotency: { key, fingerprint: key },
  };
}

describe('the C locale for git', () => {
  coreTest('local and network git run with LC_ALL=C and no LANGUAGE, whatever the person’s locale', () => {
    for (const env of [cleanGitEnv(GERMAN), networkGitEnv(false, GERMAN)]) {
      expect(env.LC_ALL).toBe('C');
      expect(Object.keys(env).filter((key) => key.toUpperCase() === 'LANGUAGE')).toEqual([]);
      expect(env.PATH).toBe('/usr/bin');
    }
    // Windows spells its variables in any case.
    const mixed = cleanGitEnv({ Language: 'de', Lc_All: 'de_DE.UTF-8' });
    expect(Object.entries(mixed).filter(([key]) => /^(language|lc_all)$/i.test(key))).toEqual([['LC_ALL', 'C']]);
  });

  coreTest('a write that loses its compare-and-set under LANG=de_DE.UTF-8 tries again and lands', async ({ world }) => {
    vi.stubEnv('LANG', 'de_DE.UTF-8');
    vi.stubEnv('LANGUAGE', 'de');
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
    const store = await openTracker(world.a.dir);
    try {
      let raced: string | null = null;
      const written = await store.transact(keyWrite('german'), async () => {
        if (raced === null) {
          // Another writer moves the tracker while this round is under way: its compare-and-set loses.
          const tip = (await trackerTip(world.a))!;
          raced = await world.a.git(['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'another writer']);
          await world.a.git(['update-ref', TRACKER_REF, raced, tip]);
        }
        return { result: 'ok' };
      });

      expect(written).toMatchObject({ result: 'ok', replayed: false });
      expect(await world.a.git(['rev-parse', `${TRACKER_REF}^`])).toBe(raced);
    } finally {
      await store.close();
    }
  });
});
