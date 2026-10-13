// `hook pre-tool-use` (spec §11, §14 Hooks; spike A T1, spike B T2): Claude
// Code runs it before every grimoire MCP call (matcher `mcp__grimoire__.*`,
// timeout 5 s), so it is a tiny entry: it never loads the CLI, the core or the
// MCP SDK.
//
// It fills the reserved hint key through `updatedInput`, never with a
// `permissionDecision`: the call's own input plus the session and tool-use
// ids, and the subagent's ids inside a subagent. Ids only: Claude Code's
// auto-mode classifier denies calls whose hint holds the transcript path
// (spike A), so the path is recorded machine-locally instead, for the cut to
// find (§6, revealed transcript roots). The server counts the hint only when
// its `tool_use_id` matches the call's own `_meta`.
//
// Anything it can't read leaves the call as it is: no output, and the verb
// exits 0 (./run-hook.ts).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { recordRevealedRoot } from '../../capture/transcript-roots';
import { findGitDirs } from '../../machine-local/git-dirs';
import { MachineLocalStore } from '../../machine-local/store';
import { RESERVED_KEY } from '../mcp/hint';
import { hookFailed } from './debug';

export interface PreToolUseContext {
  readonly startDir: string;
}

/** Longest id the hook passes on; the server keeps nothing longer either. */
const MAX_ID = 256;

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && !/[\r\n]/.test(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A grimoire tool: the server `init` registers as `grimoire`. */
function grimoireTool(payload: Record<string, unknown>): boolean {
  const server = isObject(payload.mcp_server) ? payload.mcp_server.name : undefined;
  return (typeof payload.tool_name === 'string' && payload.tool_name.startsWith('mcp__grimoire__')) || server === 'grimoire';
}

interface HintedCall {
  readonly input: Record<string, unknown>;
  readonly hint: { session_id: string; tool_use_id: string; agent_id?: string; agent_type?: string };
  /** The session's transcript, which stays out of the hint. */
  readonly transcriptPath: string | null;
}

/** The PreToolUse payload's call and its hint, or null when it isn't one the hook should touch. */
function hintedCall(payloadText: string): HintedCall | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (!isObject(payload) || payload.hook_event_name !== 'PreToolUse' || !grimoireTool(payload)) return null;
  const { session_id, tool_use_id, agent_id, agent_type, tool_input, transcript_path } = payload;
  if (!isId(session_id) || !isId(tool_use_id) || !isObject(tool_input)) return null;
  return {
    input: tool_input,
    hint: {
      session_id,
      tool_use_id,
      ...(isId(agent_id) ? { agent_id } : {}),
      ...(isId(agent_type) ? { agent_type } : {}),
    },
    transcriptPath: typeof transcript_path === 'string' && transcript_path !== '' && !/[\r\n]/.test(transcript_path) ? transcript_path : null,
  };
}

/**
 * Records the session's transcript in the clone the hook runs for (spec §6,
 * revealed transcript roots), only when grimoire is set up there: its
 * machine-local folder exists. Best effort: the hint never waits on a failure.
 */
async function recordTranscript(call: HintedCall, startDir: string): Promise<void> {
  if (call.transcriptPath === null) return;
  try {
    const dirs = await findGitDirs(startDir);
    if (!dirs || !existsSync(path.join(dirs.commonDir, 'grimoire'))) return;
    const store = new MachineLocalStore(dirs.commonDir, dirs.worktree);
    await recordRevealedRoot(store, { client: 'claude-code', session: call.hint.session_id, transcriptPath: call.transcriptPath });
  } catch (error) {
    hookFailed(error);
  }
}

/** The verb's body: the payload in, what to print out ('' leaves the call as it is). */
export async function preToolUse(payloadText: string, ctx: PreToolUseContext): Promise<string> {
  const call = hintedCall(payloadText);
  if (!call) return '';
  await recordTranscript(call, ctx.startDir);
  // The key is the hook's alone: one the model wrote into its own input is replaced whole.
  const updatedInput = { ...call.input, [RESERVED_KEY]: call.hint };
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })}\n`;
}
