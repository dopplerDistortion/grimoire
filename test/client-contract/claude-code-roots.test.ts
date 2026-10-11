// Client contract for finding a Claude Code context's transcript by id (GOK-149;
// spec §14 Roots; seam 2): real, sanitized Claude Code 2.1.296 sessions from
// spike A laid out the way Claude Code keeps them, `projects/<slug>/<session>.jsonl`
// with each subagent's own `<session>/subagents/agent-<id>.jsonl`.
import { cp, mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePath, makeTempDir, removeDir } from '#harness';
import { findClaudeTranscript } from '../../src/capture';

const PLAIN = '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5';
const PARENT = '0e195270-803a-4006-be3c-4af4e288c343';
const AGENT = 'aa0434c9616245e9e';
/** The subagent's `mcp__grimoire__show`, and the plain session's `mcp__grimoire__comment`. */
const SUBAGENT_CALL = 'toolu_01RgZkxkBkrfVmCHWzxZ2nWH';
const PLAIN_CALL = 'toolu_01FGkSuaFCkBXSzKt8JWTnv7';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeDir(dir);
});

/** A config dir holding each session in the project folder named, with its subagents. */
async function configDir(layout: Record<string, { folder: string; session: string }[]>): Promise<string> {
  const dir = await makeTempDir('grimoire-claude-roots-');
  dirs.push(dir);
  for (const [slug, sessions] of Object.entries(layout)) {
    const project = path.join(dir, 'projects', slug);
    await mkdir(project, { recursive: true });
    for (const { folder, session } of sessions) {
      await cp(fixturePath(`claude-code/transcripts/${folder}/${session}.jsonl`), path.join(project, `${session}.jsonl`));
      if (folder === 'subagent') await cp(fixturePath(`claude-code/transcripts/${folder}/${session}`), path.join(project, session), { recursive: true });
    }
  }
  return dir;
}

describe('a session the evidence names', () => {
  it('is found by its id in any project folder', async () => {
    const dir = await configDir({ 'C--a': [{ folder: 'plain', session: PLAIN }] });

    expect(await findClaudeTranscript({ configDir: dir, session: PLAIN })).toEqual({
      status: 'found',
      transcript: path.join(dir, 'projects', 'C--a', `${PLAIN}.jsonl`),
      session: PLAIN,
    });
  });

  it('is read where a hook revealed it first, and in the spawn-env session’s project folder before the others', async () => {
    const dir = await configDir({
      'C--a': [{ folder: 'plain', session: PLAIN }],
      'C--b': [
        { folder: 'plain', session: PLAIN },
        { folder: 'subagent', session: PARENT },
      ],
    });
    const revealed = fixturePath(`claude-code/transcripts/plain/${PLAIN}.jsonl`);

    expect(await findClaudeTranscript({ configDir: dir, session: PLAIN, revealed: [revealed] })).toMatchObject({ transcript: revealed });
    expect(await findClaudeTranscript({ configDir: dir, session: PLAIN, spawnEnv: PARENT })).toMatchObject({
      transcript: path.join(dir, 'projects', 'C--b', `${PLAIN}.jsonl`),
    });
  });

  it('with no transcript anywhere is not found', async () => {
    const dir = await configDir({ 'C--a': [{ folder: 'plain', session: PLAIN }] });

    expect(await findClaudeTranscript({ configDir: dir, session: 'ffffffff-0000-4000-8000-000000000000' })).toEqual({ status: 'not_found' });
  });
});

describe('a context known only by its tool-use ids', () => {
  it('is the transcript holding one of them, a subagent’s own included: its session and agent come with it', async () => {
    const dir = await configDir({ 'C--a': [{ folder: 'plain', session: PLAIN }, { folder: 'subagent', session: PARENT }] });

    expect(await findClaudeTranscript({ configDir: dir, callIds: [SUBAGENT_CALL] })).toEqual({
      status: 'found',
      transcript: path.join(dir, 'projects', 'C--a', `${PARENT}.jsonl`),
      session: PARENT,
      agentId: AGENT,
    });
    expect(await findClaudeTranscript({ configDir: dir, callIds: [PLAIN_CALL] })).toMatchObject({ session: PLAIN });
  });

  it('is never looked for in a transcript last written before the call', async () => {
    const dir = await configDir({ 'C--a': [{ folder: 'plain', session: PLAIN }] });
    const file = path.join(dir, 'projects', 'C--a', `${PLAIN}.jsonl`);
    const before = new Date('2026-10-11T03:00:00.000Z');
    await utimes(file, before, before);

    expect(await findClaudeTranscript({ configDir: dir, callIds: [PLAIN_CALL], calledAt: '2026-10-11T03:30:40.000Z' })).toEqual({ status: 'not_found' });
    expect(await findClaudeTranscript({ configDir: dir, callIds: [PLAIN_CALL], calledAt: '2026-10-11T02:30:40.000Z' })).toMatchObject({ session: PLAIN });
  });

  it('gives budget once the search overruns its deadline', async () => {
    const dir = await configDir({ 'C--a': [{ folder: 'plain', session: PLAIN }] });

    expect(await findClaudeTranscript({ configDir: dir, callIds: [PLAIN_CALL], deadline: Date.now() - 1 })).toEqual({ status: 'budget' });
  });
});
