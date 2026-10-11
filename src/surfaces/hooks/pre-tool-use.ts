// `hook pre-tool-use` (spec §11, §14 Hooks): Claude Code runs it before every
// grimoire MCP call (matcher `mcp__grimoire__.*`, timeout 5 s), so it is a tiny
// entry: it never loads the CLI, the core or the MCP SDK. The binding hint it
// adds through `updatedInput` plugs in here; until then it says nothing, which
// lets every call through unchanged.

export interface PreToolUseContext {
  readonly startDir: string;
}

/** The verb's body: the payload in, what to print out ('' leaves the call as it is). */
export async function preToolUse(_payloadText: string, _ctx: PreToolUseContext): Promise<string> {
  return '';
}
