// Telling grimoire's own calls apart in a transcript, for every client.

/** Grimoire's MCP tools, by the flat name both clients give them: `mcp__<server>__<tool>`. */
const GRIMOIRE_TOOL = /^mcp__grimoire__(.+)$/;

/**
 * A command running the CLI (spec §10): `node .grimoire/run.cjs <verb>` as
 * agents do, or `grimoire` as a word (`npm run -s grimoire -- <verb>`, `npx
 * @goksening/grimoire <verb>`), never a path inside `.grimoire/`.
 */
const RUNS_GRIMOIRE = /\.grimoire[\\/]+run\.cjs(?![\w.-])|(?<![\w.-])grimoire(?![\w.-])/;

/** The grimoire MCP tool a flat tool name calls (`claim`, `show`, `chore_start`, …), or `null`. */
export function grimoireTool(flatName: string): string | null {
  return GRIMOIRE_TOOL.exec(flatName)?.[1] ?? null;
}

/** Whether a shell command runs the grimoire CLI. */
export function runsGrimoire(command: string): boolean {
  return RUNS_GRIMOIRE.test(command);
}
