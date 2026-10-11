// Seam 2 (spec Testing Decisions; spike C B1, spike E finding 1): the
// SessionStart payloads both clients really send, and the output each client
// accepts. Claude Code reloads skills from `hookSpecificOutput.reloadSkills`;
// Codex fails the hook on any key it doesn't know, so it only ever gets the
// plain line.
import { describe, expect, it, vi } from 'vitest';
import { readFixture, readFixtureJson } from '#harness';
import { sessionStart, sessionStartClient, sessionStartOutput } from '../../../src/surfaces/hooks/session-start';

const CLAUDE = ['startup', 'startup-plain', 'clear', 'compact', 'resume', 'fork'].map((name) => `claude-code/hook-payloads/session-start-${name}.json`);
const CODEX = ['startup', 'resume'].map((name) => `codex/hook-payloads/session-start-${name}.json`);
const LINE = 'grimoire: 1 chore is due; run the grimoire-chores skill';

describe('telling the clients apart by the payload alone', () => {
  it('every captured Claude Code payload is claude-code; every Codex payload (permission_mode) is codex', () => {
    for (const fixture of CLAUDE) expect(sessionStartClient(readFixtureJson(fixture)), fixture).toBe('claude-code');
    for (const fixture of CODEX) expect(sessionStartClient(readFixtureJson(fixture)), fixture).toBe('codex');
  });

  it('a Codex payload stays codex whatever the environment says (a Codex started from Claude Code’s shell inherits its markers)', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_PROJECT_DIR', process.cwd());

    expect(sessionStartClient(readFixtureJson(CODEX[0]!))).toBe('codex');
  });

  it('anything else is no client', () => {
    for (const payload of [null, 'SessionStart', [], {}, { hook_event_name: 'PreToolUse' }, readFixtureJson('claude-code/hook-payloads/pre-tool-use.json')]) {
      expect(sessionStartClient(payload)).toBeNull();
    }
  });
});

describe('what each client is given', () => {
  it('Claude Code: reloadSkills as hookSpecificOutput, with the line as additionalContext when there is one', () => {
    expect(sessionStartOutput('claude-code', { reloadSkills: true })).toBe('{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}\n');
    expect(JSON.parse(sessionStartOutput('claude-code', { reloadSkills: true, line: LINE }))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', reloadSkills: true, additionalContext: LINE },
    });
    expect(sessionStartOutput('claude-code', { line: LINE })).toBe(`${LINE}\n`);
  });

  it('Codex: the plain line only, never JSON, even when skills were written', () => {
    expect(sessionStartOutput('codex', { reloadSkills: true, line: LINE })).toBe(`${LINE}\n`);
    expect(sessionStartOutput('codex', { reloadSkills: true })).toBe('');
  });

  it('an unknown client gets the plain line, which both accept', () => {
    expect(sessionStartOutput(null, { reloadSkills: true, line: LINE })).toBe(`${LINE}\n`);
  });

  it('nothing to say prints nothing, for every captured payload and for an unreadable one', async () => {
    for (const fixture of [...CLAUDE, ...CODEX]) expect(await sessionStart(readFixture(fixture), { startDir: process.cwd() }), fixture).toBe('');
    expect(await sessionStart('not json', { startDir: process.cwd() })).toBe('');
  });
});
