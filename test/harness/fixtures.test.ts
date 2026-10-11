import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  fixturePath,
  readFixture,
  readFixtureBytes,
  readFixtureJson,
} from '#harness';

describe('client-contract fixtures', () => {
  it('live in test/fixtures, whose README states the real-sanitized-artifacts rule', () => {
    expect(path.basename(FIXTURES_DIR)).toBe('fixtures');
    const readme = readFixture('README.md');
    expect(readme).toMatch(/real/i);
    expect(readme).toMatch(/sanitized/i);
  });

  it('resolve forward-slash relative paths inside the fixture directory', () => {
    expect(fixturePath('README.md')).toBe(path.join(FIXTURES_DIR, 'README.md'));
    expect(readFixtureBytes('README.md').toString('utf8')).toBe(readFixture('README.md'));
  });

  it('name the missing fixture when it does not exist', () => {
    expect(() => readFixture('codex/transcripts/nope.jsonl')).toThrow(
      /codex\/transcripts\/nope\.jsonl/,
    );
    expect(() => readFixtureJson('claude-code/meta/nope.json')).toThrow(/nope\.json/);
  });

  it('refuse paths that leave the fixture directory', () => {
    expect(() => fixturePath('../harness/index.ts')).toThrow(/outside/);
    expect(() => fixturePath(path.resolve('package.json'))).toThrow(/outside/);
  });
});
