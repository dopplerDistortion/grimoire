// Client contract for the observed-commit facts (GOK-156; spec §14 Facts:
// Commits; seam 2). Real, sanitized transcripts go in through the client
// readers; the commits a context's own tool results show git creating come
// out, credited to the context, and the spans of its tool calls (what a
// creating HEAD-reflog entry must fall inside). Hashes `git log` printed never
// count. Fixtures: spike A's plain session (a Bash `git commit`), the
// subagent-commit session (a subagent's `git commit`, then the main line's
// `git log`), spike A's compaction session (`git log --oneline`) and spike E's
// Codex child thread (`git log --oneline -1`).
import { describe, expect, it } from 'vitest';
import { fixturePath } from '#harness';
import { callSpans, transcriptCommitLines } from '../../src/capture/commit-facts';
import { readClaudeCodeTranscript, readCodexTranscript, type Transcript } from '../../src/capture';

async function claude(file: string, agentId?: string): Promise<Transcript> {
  const read = await readClaudeCodeTranscript(fixturePath(file), agentId ? { agentId } : {});
  if (!read.found) throw new Error(`no transcript at ${file}`);
  return read.transcript;
}

async function codex(file: string): Promise<Transcript> {
  const read = await readCodexTranscript(fixturePath(file));
  if (!read.found) throw new Error(`no transcript at ${file}`);
  return read.transcript;
}

const lines = (transcript: Transcript) => transcriptCommitLines(transcript, transcript.steps.slice(transcript.copiedSteps));

const SUBAGENT_COMMIT = 'claude-code/transcripts/subagent-commit/ff9eace1-0645-4dd9-bf34-f61ffa87b3c2.jsonl';
const SUBAGENT = 'ae1c0b7534f14a681';

describe('creation lines in a context’s tool results', () => {
  it('a Bash `git commit` whose result prints `[main cbbd0d3] Add notes` is a commit the context created, at the call’s time', async () => {
    const transcript = await claude('claude-code/transcripts/plain/0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5.jsonl');

    expect(lines(transcript)).toEqual([
      { hash: 'cbbd0d3', at: '2026-10-11T03:30:38.942Z', session: '0b95f7c0-adbf-4acf-9fcb-c0c64014e3e5', context: 'main' },
    ]);
  });

  it('a subagent’s `git commit` is found in the subagent’s own transcript; the main line’s `git log` printing it and an older commit counts none', async () => {
    const main = await claude(SUBAGENT_COMMIT);
    const subagent = await claude(SUBAGENT_COMMIT, SUBAGENT);

    expect(lines(main)).toEqual([]);
    expect(lines(subagent)).toEqual([
      { hash: 'dba2f59', at: '2026-10-12T12:39:13.793Z', session: 'ff9eace1-0645-4dd9-bf34-f61ffa87b3c2', context: SUBAGENT },
    ]);
    // The main line shows the subagent only as its launch and its result, which quotes the creation line: no tool result of a commit.
    expect(main.steps.some((step) => step.kind === 'subagent_result' && step.text.includes('dba2f59'))).toBe(true);
  });

  it('`git log --oneline` output is never a creation, in Claude Code or in Codex', async () => {
    const compaction = await claude('claude-code/transcripts/compaction/18aa1670-988c-4aaf-bb6f-ca64e8e30d07.jsonl');
    const child = await codex('codex/transcripts/subagent/rollout-2026-10-11T07-44-47-01a12947-16a2-7152-be00-4e4b1e12a4d8.jsonl');

    expect(compaction.steps.some((step) => step.kind === 'tool_result' && /^[0-9a-f]{7} /m.test(step.text))).toBe(true);
    expect(child.steps.some((step) => step.kind === 'tool_result' && step.text.includes('c36fbac'))).toBe(true);
    expect(lines(compaction)).toEqual([]);
    expect(lines(child)).toEqual([]);
  });
});

describe('the spans of a context’s tool calls', () => {
  it('each answered call spans its call to its result; a subagent launch spans the whole subagent run', async () => {
    const main = await claude(SUBAGENT_COMMIT);

    expect(callSpans(main.steps).map(({ start, end }) => [new Date(start).toISOString(), new Date(end).toISOString()])).toEqual([
      ['2026-10-12T12:39:08.800Z', '2026-10-12T12:39:25.836Z'],
      ['2026-10-12T12:39:26.801Z', '2026-10-12T12:39:27.570Z'],
    ]);
  });
});
