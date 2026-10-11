// Client contract for the Claude runner (spike D, GOK-129): what `claude -p
// --output-format json` and `claude auth status` really print, as captured
// from Claude Code 2.1.296 on Windows. The runner's failure detection and its
// billing guard are built against these fixtures. See
// docs/research/spikes/claude-runner-ipc.md and the fixture READMEs.
import { describe, expect, it } from 'vitest';
import { readFixtureJson } from '#harness';

interface ClaudePrintResult {
  type: string;
  subtype: string;
  is_error: boolean;
  num_turns: number;
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  api_error_status?: number | null;
  terminal_reason?: string;
}

const printResult = (name: string) =>
  readFixtureJson<ClaudePrintResult>(`claude-code/print-json/${name}`);

describe('claude -p --output-format json --json-schema results (C3)', () => {
  it('a success carries the answer as structured_output, and result holds the same JSON as text', () => {
    const r = printResult('success-structured-output.json');
    expect(r.type).toBe('result');
    expect(r.subtype).toBe('success');
    expect(r.is_error).toBe(false);
    expect(r.structured_output).toEqual({
      first_token: 'alpha-7731',
      last_token: 'omega-4402',
      line_count: 12,
      summary: expect.stringMatching(/^PROC-OK: /),
    });
    expect(JSON.parse(r.result ?? 'null')).toEqual(r.structured_output);
  });

  it('an answer that never satisfies the schema ends as error_max_turns, with no answer at all', () => {
    const r = printResult('error-max-turns.json');
    expect(r.type).toBe('result');
    expect(r.subtype).toBe('error_max_turns');
    expect(r.is_error).toBe(true);
    expect(r.terminal_reason).toBe('max_turns');
    expect(r.errors).toEqual(['Reached maximum number of turns (3)']);
    expect(r).not.toHaveProperty('structured_output');
    expect(r).not.toHaveProperty('result');
  });

  it('an API error still says subtype success, but sets is_error and has no structured_output', () => {
    const r = printResult('api-error-invalid-key.json');
    expect(r.subtype).toBe('success');
    expect(r.is_error).toBe(true);
    expect(r.api_error_status).toBe(401);
    expect(r.result).toBe('Invalid API key · Fix external API key');
    expect(r).not.toHaveProperty('structured_output');
  });

  it('a prompt that starts with a slash command runs the command instead of the model: success, no structured_output', () => {
    const r = printResult('success-local-command.json');
    expect(r.subtype).toBe('success');
    expect(r.is_error).toBe(false);
    expect(r.num_turns).toBe(0);
    expect(r.result).toBe("/cost isn't available in this environment.");
    expect(r).not.toHaveProperty('structured_output');
  });
});

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
  apiKeySource?: string;
}

describe('claude auth status --json, run with the child environment (P6)', () => {
  it.each([
    // fixture, authMethod, loggedIn, apiProvider
    ['claude-ai.json', 'claude.ai', true, 'firstParty'],
    ['api-key.json', 'api_key', true, 'firstParty'],
    ['api-key-helper.json', 'api_key_helper', true, 'firstParty'],
    ['oauth-token.json', 'oauth_token', true, 'firstParty'],
    ['third-party-bedrock.json', 'third_party', true, 'bedrock'],
    ['none.json', 'none', false, 'firstParty'],
  ] as const)('%s reports authMethod %s', (fixture, authMethod, loggedIn, apiProvider) => {
    const s = readFixtureJson<ClaudeAuthStatus>(`claude-code/auth-status/${fixture}`);
    expect(s.authMethod).toBe(authMethod);
    expect(s.loggedIn).toBe(loggedIn);
    expect(s.apiProvider).toBe(apiProvider);
  });

  it('names the key source when a key, not the subscription login, is in force', () => {
    const fromEnv = readFixtureJson<ClaudeAuthStatus>('claude-code/auth-status/api-key.json');
    const fromHelper = readFixtureJson<ClaudeAuthStatus>(
      'claude-code/auth-status/api-key-helper.json',
    );
    const subscription = readFixtureJson<ClaudeAuthStatus>(
      'claude-code/auth-status/claude-ai.json',
    );
    expect(fromEnv.apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(fromHelper.apiKeySource).toBe('apiKeyHelper');
    expect(subscription).not.toHaveProperty('apiKeySource');
  });
});
