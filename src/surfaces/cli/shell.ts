// What the CLI observes about the shell it runs in (spec §7, Actors): agent
// markers, the agent client and session, and whether a person sits at an
// interactive terminal. Observed, never supplied: no flag carries identity.
import type { ClientInfo, Evidence } from '../../core';

/** The variables whose presence makes a CLI call an agent's (spec §7). */
export const AGENT_MARKERS = ['AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_CI', 'CODEX_THREAD_ID'] as const;

function set(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** The agent markers set in `env`, in the order above. */
export function agentMarkersIn(env: NodeJS.ProcessEnv): string[] {
  return AGENT_MARKERS.filter((name) => set(env, name) !== null);
}

/** Whether `env` is a Codex agent's shell (spike E, finding 5; spike F). */
export function inCodexShell(env: NodeJS.ProcessEnv): boolean {
  return ['CODEX_THREAD_ID', 'CODEX_CI', 'CODEX_SESSION_ID', 'CODEX_SANDBOX'].some((name) => set(env, name) !== null);
}

/**
 * The agent client of a marked shell, for display and attribution only:
 * Claude Code's Bash tool sets `AI_AGENT=claude-code_<version>_agent` (spike
 * A); Codex's shell sets `CODEX_THREAD_ID` and `CODEX_VERSION` (spike E).
 */
export function clientIn(env: NodeJS.ProcessEnv): ClientInfo | null {
  if (agentMarkersIn(env).length === 0) return null;
  const aiAgent = set(env, 'AI_AGENT');
  if (aiAgent?.startsWith('claude-code') || set(env, 'CLAUDE_CODE_CHILD_SESSION')) {
    const version = /^claude-code_([0-9][0-9.-]*?)_/.exec(aiAgent ?? '')?.[1]?.replaceAll('-', '.');
    return version ? { name: 'claude-code', version } : { name: 'claude-code' };
  }
  if (set(env, 'CODEX_THREAD_ID') || set(env, 'CODEX_CI')) {
    const version = set(env, 'CODEX_VERSION');
    return version ? { name: 'codex', version } : { name: 'codex' };
  }
  const name = aiAgent?.split('_')[0];
  return name ? { name } : null;
}

/**
 * The agent evidence of a CLI call: the markers, and the session the shell
 * env names (Claude Code: `CLAUDE_CODE_SESSION_ID`; Codex: `CODEX_SESSION_ID`
 * for the root thread, `CODEX_THREAD_ID` for this context).
 */
export function evidenceIn(env: NodeJS.ProcessEnv): Evidence {
  const agentMarkers = agentMarkersIn(env);
  if (agentMarkers.length === 0) return {};
  const session = set(env, 'CLAUDE_CODE_SESSION_ID') ?? set(env, 'CODEX_SESSION_ID') ?? set(env, 'CODEX_THREAD_ID');
  const context = set(env, 'CODEX_THREAD_ID');
  return {
    agentMarkers,
    ...(session ? { session } : {}),
    ...(context ? { context } : {}),
  };
}
