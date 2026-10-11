// The shipped server instructions (spec §8). The MCP server sends them in its
// `initialize` and `server/discover` results, and `init` writes the same text
// inline into the instruction pointer files.
//
// The first 512 characters carry the whole working contract, because some
// clients show only the opening. They also open with "grimoire" and "issue":
// Codex hides MCP tools behind a `tool_search` whose description quotes these
// instructions, and the model reads them to decide what to search for.

const CONTRACT = [
  "grimoire is this repo's issue tracker. Issues live in grimoire, so use these tools.",
  "Claim only the leaf you'll work; ALREADY_CLAIMED means move on.",
  'Finish every claim with `close` or `release` and a debrief.',
  'Never edit, stage or commit `.grimoire/`.',
  // A client that defers tools behind a tool search (Codex for gpt-5.x) lists none
  // until the model searches, so the fallback waits for the search (spike E).
  'Use the CLI only when no grimoire tools are listed or found by tool search; then run `node .grimoire/run.cjs status` and relay it.',
  // Spike F: Codex's sandboxes keep `.git/` read-only for the agent's shell.
  'CLI writes fail in sandboxed shells.',
  'Repo instructions and hand-written skills outrank evolved skills (`skill_list`, `skill_read`).',
].join(' ');

const DETAILS = [
  'Working issues:',
  '- The tools: `list`, `show` and `labels` read; `create`, `update` and `comment` write; `claim` an issue, then end your attempt with `close` or `release`.',
  '- Find work with `list` (`ready: true` is the claimable frontier), then `show` the issue before you start.',
  '- Triage, creating issues, charting, comments and reviews never claim. Orchestrators never claim or close for their workers: each worker closes its own issue as `done` once its work is merged into the integration branch, and the parent is closed last.',
  "- When the user names an issue your person already holds, take it over with the `attempt` handle from ALREADY_CLAIMED's details; you may then `update`, `comment` or `close` it, or `release` it with `abandoned: true`.",
  '- A debrief is {asked, tried, failed, worked, next}: report only what you saw, and write "none" where there is nothing.',
  '- Pass an `idempotency_key` to `create`, `comment` and `claim` so a retry never duplicates; `close` and `release` replay safely on their own.',
  "- Evolved skills are procedures learned from past issues: `skill_list` names them, and `skill_read` gives one's text (a stub named `grimoire-<name>` points at the same skill). Follow one unless the repo's own instructions or hand-written skills say otherwise.",
  '- A result with `truncated: true` was cut to fit: pass its `cursor` back for the rest.',
  '- Read and write issue state only through grimoire. The only `.grimoire/` file you are ever pointed at is an evolved skill\'s copy, through its stub.',
  "- Make every write with these tools. A sandboxed shell (Codex's keeps `.git/` read-only) can't write through the CLI, while the grimoire server runs outside the sandbox.",
  'When things go wrong:',
  '- On UPGRADE_REQUIRED, stop grimoire work and relay the remedies to the user. Relay any notice a result carries, such as a request to restart the session.',
  '- If a grimoire tool call is blocked or denied, stop and tell the user; never route around it through the CLI.',
].join('\n');

export const SERVER_INSTRUCTIONS = `${CONTRACT}\n\n${DETAILS}`;
