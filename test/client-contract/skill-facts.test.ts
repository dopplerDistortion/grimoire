// Client contract for the skill-read facts (GOK-158; spec §14 Facts: Read,
// Normalization; seam 2). Real, sanitized transcripts go in through the
// client readers, with the ledger's versions of each skill; the reads come
// out: `{name, version, via, at, session, context}`. Fixtures: spike C
// (Claude Code reading the copy with `Read` and with `Bash cat`), spike F
// (Codex reading it through the shell, paginated) and spike E (a legacy
// Codex rollout reading a copy).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixturePath } from '#harness';
import {
  readClaudeCodeTranscript,
  readCodexTranscript,
  transcriptSkillReads,
  type Step,
  type Transcript,
} from '../../src/capture';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The copy spike C's repos held (`.grimoire/skills/changelog-entry/SKILL.md`), as the `Read` tool showed it. */
const CHANGELOG = [
  '---',
  'name: changelog-entry',
  'description: Add a changelog entry or release note for a change in this repo. Use when the user asks to record, log or note a change, fix or feature in the changelog or release notes.',
  '---',
  '',
  '# Changelog entries',
  '',
  'This repo does not edit CHANGELOG.md by hand; it is generated at release time.',
  '',
  'To record a change, create one new file `changes/<kebab-slug>.md` containing exactly:',
  '',
  '```',
  'kind: <fix|feat|chore>',
  'summary: <one line, imperative mood>',
  'marker: GRIM-P2-COPY-READ',
  '```',
  '',
  'The `marker` line must be copied exactly. Do not touch CHANGELOG.md.',
  '',
].join('\n');
/** An earlier version of it: the same body but for its last line. */
const CHANGELOG_EARLIER = CHANGELOG.replace('Do not touch CHANGELOG.md.', 'Never edit CHANGELOG.md.');

/** Spike F's copy (`.grimoire/skills/tidewater-ledger/SKILL.md`). */
const TIDEWATER = [
  '---',
  'name: tidewater-ledger',
  'description: Reconcile the tidewater ledger files in this repo. Use when the user asks to reconcile, balance or settle the tidewater ledger.',
  '---',
  '',
  'Write ledger/tidewater.md with one line: marker GRIM-B2-COPY-READ.',
  '',
].join('\n');

/** Spike E's copy (`.grimoire/skills/probe/SKILL.md`). */
const PROBE = '---\nname: probe\ndescription: probe skill copy\n---\nProbe skill body v1.\n';

/** The reader names a Claude Code session by its transcript's file name. */
const CLAUDE_SESSION = 'stub-match-read-tool';
const TIDEWATER_THREAD = '01a1295a-7c36-71b2-af4a-412ac1a31b9a';
const LEGACY_THREAD = '01a12947-770e-7b53-9c8c-cb3dc787936c';

function versions(...skills: [string, ...string[]][]): Map<string, Map<string, string>> {
  return new Map(skills.map(([name, ...texts]) => [name, new Map(texts.map((text) => [sha256(text), text]))]));
}

async function claude(file: string): Promise<Transcript> {
  const read = await readClaudeCodeTranscript(fixturePath(`claude-code/transcripts/${file}`));
  if (!read.found) throw new Error(`no fixture ${file}`);
  return read.transcript;
}

async function codex(folder: string, thread: string, stamp: string): Promise<Transcript> {
  const read = await readCodexTranscript(fixturePath(`codex/transcripts/${folder}/rollout-${stamp}-${thread}.jsonl`));
  if (!read.found) throw new Error(`no fixture ${folder}`);
  return read.transcript;
}

/** The transcript with one step's text replaced: the same real read, as another client wrapper or cut would show it. */
function withResult(transcript: Transcript, callId: string, text: (old: string) => string): readonly Step[] {
  return transcript.steps.map((step) => (step.kind === 'tool_result' && step.id === callId ? { ...step, text: text(step.text) } : step));
}

describe('Claude Code', () => {
  it('a Read of the copy is a read of the version whose text it shows, its `N\\t` line prefixes stripped; the Skill call before it adds nothing', async () => {
    const transcript = await claude('stub-match-read-tool.jsonl');

    const reads = transcriptSkillReads(transcript, transcript.steps, versions(['changelog-entry', CHANGELOG_EARLIER, CHANGELOG]));

    expect(reads).toEqual([
      { name: 'changelog-entry', version: sha256(CHANGELOG), via: 'file', at: '2026-10-11T03:21:37.110Z', session: CLAUDE_SESSION, context: 'main' },
    ]);
  });

  it('a shell command printing the copy among other output is a read of that version', async () => {
    const transcript = await claude('stub-match-shell-read.jsonl');

    const reads = transcriptSkillReads(transcript, transcript.steps, versions(['changelog-entry', CHANGELOG_EARLIER, CHANGELOG]));

    expect(reads).toEqual([
      { name: 'changelog-entry', version: sha256(CHANGELOG), via: 'shell', at: '2026-10-11T03:21:33.767Z', session: transcript.session, context: 'main' },
    ]);
  });

  it('a Skill call of grimoire-<name> with no read of the copy after it is a read with no version', async () => {
    const transcript = await claude('stub-match-read-tool.jsonl');
    // The window ends before the copy was read.
    const steps = transcript.steps.slice(0, 3);

    const reads = transcriptSkillReads(transcript, steps, versions(['changelog-entry', CHANGELOG]));

    expect(reads).toEqual([
      { name: 'changelog-entry', version: null, via: 'skill', at: '2026-10-11T03:21:32.810Z', session: CLAUDE_SESSION, context: 'main' },
    ]);
  });

  it('a copy that matches no version the ledger records is read at version unknown', async () => {
    const transcript = await claude('stub-match-read-tool.jsonl');

    const reads = transcriptSkillReads(transcript, transcript.steps, versions(['changelog-entry', CHANGELOG_EARLIER]));

    expect(reads).toMatchObject([{ name: 'changelog-entry', version: 'unknown', via: 'file' }]);
  });

  it('a partial read matches only when exactly one version contains it; text two versions share is unknown', async () => {
    const transcript = await claude('stub-match-read-tool.jsonl');
    // `Read` with an offset and a limit: lines 6 to 10 of the copy, as the tool numbers them.
    const partial = withResult(transcript, 'toolu_01DPgrRpFXVttb3XjjTys1Zh', (text) => text.split('\n').slice(5, 10).join('\n'));
    // And the last two lines, which tell the two versions apart.
    const tail = withResult(transcript, 'toolu_01DPgrRpFXVttb3XjjTys1Zh', (text) => text.split('\n').slice(17).join('\n'));
    const both = versions(['changelog-entry', CHANGELOG_EARLIER, CHANGELOG]);

    expect(transcriptSkillReads(transcript, partial, both)).toMatchObject([{ version: 'unknown', via: 'file' }]);
    expect(transcriptSkillReads(transcript, partial, versions(['changelog-entry', CHANGELOG]))).toMatchObject([{ version: sha256(CHANGELOG) }]);
    expect(transcriptSkillReads(transcript, tail, both)).toMatchObject([{ version: sha256(CHANGELOG) }]);
  });
});

describe('Codex', () => {
  it('a shell read of the copy (paginated) is a read of its version, CRLF and all; reading the stub, or writing the copy, is not', async () => {
    const transcript = await codex('skill-stub-read', TIDEWATER_THREAD, '2026-10-11T08-05-58');

    const reads = transcriptSkillReads(transcript, transcript.steps, versions(['tidewater-ledger', TIDEWATER]));

    expect(reads).toEqual([
      { name: 'tidewater-ledger', version: sha256(TIDEWATER), via: 'shell', at: '2026-10-11T05:05:59.283Z', session: TIDEWATER_THREAD, context: TIDEWATER_THREAD },
    ]);
  });

  it('a legacy rollout read of the copy is matched by the exec_command text', async () => {
    const transcript = await codex('legacy', LEGACY_THREAD, '2026-10-11T07-45-11');

    const reads = transcriptSkillReads(transcript, transcript.steps, versions(['probe', PROBE]));

    expect(reads).toEqual([
      { name: 'probe', version: sha256(PROBE), via: 'shell', at: '2026-10-11T04:45:12.029Z', session: LEGACY_THREAD, context: LEGACY_THREAD },
    ]);
  });

  it('the response header and a middle truncation marker are stripped before matching', async () => {
    const transcript = await codex('skill-stub-read', TIDEWATER_THREAD, '2026-10-11T08-05-58');
    const header = 'Chunk ID: 4f2a\r\nWall time: 0.2 seconds\r\nProcess exited with code 0\r\nOriginal token count: 61\r\nOutput:\r\n';
    const wrapped = withResult(transcript, 'call_4_0', (text) => `${header}${text}`);
    // Codex keeps a cut output's head and tail around its marker.
    const cut = withResult(transcript, 'call_4_0', (text) => `${text.slice(0, 40)}…12 tokens truncated…${text.slice(-50)}`);
    const shell = withResult(transcript, 'call_4_0', (text) => `Warning: truncated output (original token count: 61)\n${text}`);
    const tidewater = versions(['tidewater-ledger', TIDEWATER, TIDEWATER.replace('one line', 'a single line')]);

    for (const steps of [wrapped, cut, shell]) {
      expect(transcriptSkillReads(transcript, steps, tidewater)).toMatchObject([{ name: 'tidewater-ledger', version: sha256(TIDEWATER) }]);
    }
  });
});
