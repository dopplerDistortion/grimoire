// The Codex reader on a Node without zstd (before 22.15): a `.jsonl.zst`
// rollout is unreadable, never misparsed (GOK-137; spec §14 Readers). Its own
// file, because it replaces `node:zlib` for every module it loads.
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixturePath, makeTempDir, readFixtureBytes, removeDir } from '#harness';
import { cutCodex, readCodexTranscript } from '../../src/capture';

vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  const withoutZstd = { ...zlib, createZstdDecompress: undefined, zstdDecompressSync: undefined, zstdDecompress: undefined };
  return { ...withoutZstd, default: withoutZstd };
});

const THREAD = '01a12946-7d23-7f93-b8c8-aa18d1bca5ef';
const ARCHIVED_ZST = `codex/transcripts/archived-zstd/archived_sessions/rollout-2026-10-11T07-44-07-${THREAD}.jsonl.zst`;
const PAGINATED = `codex/transcripts/paginated/rollout-2026-10-11T07-44-07-${THREAD}.jsonl`;
const evidence = {
  issue: 'gr-7k2pq',
  attemptOpenedAt: '2026-10-11T04:44:00.000Z',
  bindingCalls: [{ id: 'call_2_0', at: '2026-10-11T04:44:09.130Z' }],
};
const paths = { home: 'C:\\Users\\USER', repo: 'C:\\Users\\USER\\AppData\\Local\\Temp\\gok130\\repos\\a1' };

let home: string | null = null;
afterEach(async () => {
  if (home !== null) await removeDir(home);
  home = null;
});

describe('without zstd support', () => {
  it('a .jsonl.zst rollout is unreadable: no steps, no excerpt', async () => {
    home = await makeTempDir('grimoire-codex-no-zstd-');
    await mkdir(path.join(home, 'archived_sessions'));
    await writeFile(path.join(home, 'archived_sessions', path.basename(ARCHIVED_ZST)), readFixtureBytes(ARCHIVED_ZST));
    const result = await cutCodex({ codexHome: home, context: THREAD, evidence, paths });
    const read = await readCodexTranscript(fixturePath(ARCHIVED_ZST));

    expect(result.status).toBe('unreadable');
    expect(result).toMatchObject({ excerpt: null, steps: [], window: null, reach: null, context: THREAD });
    expect(read).toEqual({ found: false, file: fixturePath(ARCHIVED_ZST), unreadable: 'zstd_unavailable' });
  });

  it('a plain rollout is still read', async () => {
    const result = await cutCodex({ transcript: fixturePath(PAGINATED), context: THREAD, evidence, paths });

    expect(result.status).toBe('cut');
  });
});
