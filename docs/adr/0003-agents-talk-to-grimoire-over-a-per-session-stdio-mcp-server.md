# Agents talk to grimoire over a per-session stdio MCP server, with the CLI as a narrower fallback

Grimoire has no daemon and no single writer. Each agent session's client spawns its own `grimoire mcp` stdio process: one per session in Claude Code, shared by that session's subagents, and one per thread in Codex, subagent threads included. That process reads and writes the store directly, through the same core library the CLI and the dashboard use. `grimoire start` is never needed for agent work. The CLI offers the same operations with the same JSON shapes, but agents turn to it only when no grimoire tools are listed, for example in an untrusted project or a client without MCP. MCP is the primary channel because, inside Codex, it is the only channel that can always write:
- stdio servers run outside Codex's sandbox;
- agent shell commands cannot write `.git/` under `workspace-write`, and cannot write anything under `read-only`.

MCP also brings:
- typed tools, whose annotations drive both clients' approval and plan-mode rules;
- server instructions that load at session start;
- one warm process, instead of an `npx` cold start for every call.

## Considered Options

- **CLI first, as beads and Backlog.md do.** Rejected as the primary channel, for three reasons:
  - inside Codex's sandbox, shell writes to the shared store fail;
  - Claude Code's shell tool needs a permission rule for each command pattern;
  - every call pays a package cold start, which takes seconds on Windows.

  The CLI is kept as the fallback.
- **HTTP MCP served by `start`, as a single writer.** Rejected, for three reasons:
  - agents would depend on a running server;
  - neither client documents a session identity over HTTP;
  - MCP 2026-07-28 removed protocol-level sessions anyway.
- **MCP only.** Rejected: untrusted projects never load project MCP servers, and humans, hooks and scripts need the same operations.

## Consequences

- **Many writer processes run at once.** The store must be safe across processes and across concurrent calls inside one process. Every write must also be safe to repeat after a lost response, and an error must mean nothing changed.
- **The server cannot tell which session called.**
  - Claude Code's session id is fixed when the server is spawned. It goes stale after `/clear`, and subagents share it.
  - Codex's per-call `_meta.sessionId` is undocumented.
  - So capturing sessions depends on hooks and transcripts (Trace capture), never on the model reporting who it is.
- **Human-only operations cannot be offered over MCP.** A tool list cannot vary by caller, and no MCP mechanism guarantees that a human answers. These operations live in the dashboard, and in CLI commands that need an interactive terminal and a typed confirmation. That guards against accidents, not against a determined agent.
- **The server has to speak both MCP eras.** Claude Code negotiates 2026-07-28, while Codex still initializes with 2025-06-18.
