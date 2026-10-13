// The surface policy every op carries (spec §2.1, §7): which surfaces may call
// it. The policies are checked over every surface the core sees.
import { describe, expect, test } from 'vitest';
import type { CallContext } from '../../src/core';
import { checkSurface, type SurfacePolicy } from '../../src/core/op';
import { GrimoireError } from '../../src/errors';

const base: CallContext = {
  surface: 'cli',
  repo: { root: '/repo', pin: null },
  person: { name: 'Alice', email: 'alice@example.com' },
  client: null,
  evidence: {},
  nonce: 'nonce-1',
};

const SURFACES: Record<string, CallContext> = {
  mcp: { ...base, surface: 'mcp', client: { name: 'claude-code' } },
  'cli at a terminal': { ...base, tty: true },
  'cli without a tty': { ...base, tty: false },
  'cli under an agent marker, at a terminal': { ...base, tty: true, evidence: { agentMarkers: ['CODEX_THREAD_ID'] } },
  'cli under an agent marker, without a tty': { ...base, tty: false, evidence: { agentMarkers: ['AI_AGENT'] } },
  dashboard: { ...base, surface: 'dashboard' },
  hook: { ...base, surface: 'hook' },
  runner: { ...base, surface: 'runner', client: { name: 'runner:claude' } },
};

/** What each policy gives on each surface: `ok`, or the error code. */
const EXPECTED: Record<SurfacePolicy, Record<keyof typeof SURFACES, string>> = {
  agent: {
    mcp: 'ok',
    'cli at a terminal': 'ok',
    'cli without a tty': 'ok',
    'cli under an agent marker, at a terminal': 'ok',
    'cli under an agent marker, without a tty': 'ok',
    dashboard: 'ok',
    hook: 'ok',
    runner: 'ok',
  },
  'human-only': {
    mcp: 'HUMAN_ONLY',
    'cli at a terminal': 'ok',
    'cli without a tty': 'HUMAN_ONLY',
    'cli under an agent marker, at a terminal': 'HUMAN_ONLY',
    'cli under an agent marker, without a tty': 'HUMAN_ONLY',
    dashboard: 'ok',
    hook: 'HUMAN_ONLY',
    runner: 'HUMAN_ONLY',
  },
  'human-read': {
    mcp: 'HUMAN_ONLY',
    'cli at a terminal': 'ok',
    'cli without a tty': 'ok',
    'cli under an agent marker, at a terminal': 'HUMAN_ONLY',
    'cli under an agent marker, without a tty': 'HUMAN_ONLY',
    dashboard: 'ok',
    hook: 'HUMAN_ONLY',
    runner: 'HUMAN_ONLY',
  },
  internal: {
    mcp: 'INVALID',
    'cli at a terminal': 'ok',
    'cli without a tty': 'ok',
    'cli under an agent marker, at a terminal': 'ok',
    'cli under an agent marker, without a tty': 'ok',
    dashboard: 'INVALID',
    hook: 'ok',
    runner: 'ok',
  },
};

function outcome(policy: SurfacePolicy, ctx: CallContext): { code: string; message: string } {
  try {
    checkSurface({ name: 'some_op', policy }, ctx);
    return { code: 'ok', message: '' };
  } catch (error) {
    if (!(error instanceof GrimoireError)) throw error;
    return { code: error.code, message: error.message };
  }
}

describe('the surface policy', () => {
  for (const [policy, bySurface] of Object.entries(EXPECTED) as [SurfacePolicy, Record<string, string>][]) {
    test(`${policy}: ${Object.entries(bySurface).filter(([, code]) => code === 'ok').map(([surface]) => surface).join('; ')}`, () => {
      const seen = Object.fromEntries(Object.entries(SURFACES).map(([surface, ctx]) => [surface, outcome(policy, ctx).code]));

      expect(seen).toEqual(bySurface);
    });
  }

  test('a refusal never names the agent markers, and an internal op looks like no op at all', () => {
    const refusals = Object.values(SURFACES).flatMap((ctx) =>
      (['human-only', 'human-read'] as const).map((policy) => outcome(policy, ctx)).filter((seen) => seen.code !== 'ok'),
    );

    expect(refusals.length).toBeGreaterThan(0);
    for (const { message } of refusals) expect(message).not.toMatch(/AI_AGENT|CLAUDE_CODE|CODEX|marker|environment|env/i);
    expect(outcome('internal', SURFACES.mcp!).message).toBe('there is no operation named some_op');
  });
});
