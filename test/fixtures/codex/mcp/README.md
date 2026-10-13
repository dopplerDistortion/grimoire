# Codex MCP wire traffic (2025-06-18 era)

Real stdio traffic between Codex and spike B's probe server
(`test/spikes/mcp-dual-era/probe-server.ts`). Findings:
`docs/research/spikes/mcp-dual-era.md`.

`handshake/` holds:

- `c2s.jsonl`: the bytes Codex wrote to the server's stdin, exactly as received
  (newline-delimited JSON, LF only): `initialize`, `notifications/initialized`,
  `tools/list`.
- `s2c.jsonl`: the bytes the probe server wrote back (produced by the probe).
- `starts.jsonl`: one line per server process Codex started.

## Provenance

- Client: Codex CLI 0.162.1, **not logged in**. `codex exec
  --skip-git-repo-check "say hi"` with a throwaway `CODEX_HOME` whose
  `config.toml` declared only the probe under `[mcp_servers.probe]`. Codex
  started and initialized the MCP server before its model requests failed with
  401, so the handshake is real but no `tools/call` was ever sent (that half,
  with Codex's per-call `_meta`, belongs to spike E).
- Server: the probe bundled by esbuild, `@modelcontextprotocol/server` 2.3.1,
  Node 24.21.0.
- OS: Windows 11 Pro 10.0.26200. Captured 2026-10-11.

## Sanitizing

None needed: the traffic holds no paths, names or secrets.

## Spike E (GOK-130)

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`. Each folder uses the same layout as `handshake/` (`c2s.jsonl`,
`s2c.jsonl` and `starts.jsonl`, all as the probe captured them).

| Folder | What it shows |
| -- | -- |
| `tools-call/` | One `codex exec` turn with the `initialize` (2025-06-18) / `tools/list` handshake and six `tools/call`s: `echo`, `big` (spike B's 24 KB cut), `which` (`structuredContent` and text differ), `boom` (the handler throws, so the server answers `-32603`), then two `echo`s the model issued in one response. Every call's `_meta` has `callId`, `threadId`, `sessionId`, `windowId`, `itemId`, `progressToken` and the `x-codex-turn-metadata` object. The matching rollout is `../transcripts/mcp-results/`. |
| `subagent/` | A root thread that spawns a subagent (`spawn_agent`), with both threads calling `echo`. Codex started **two** server processes (`starts.jsonl`), and both appended to the same capture files, so `c2s.jsonl` interleaves two connections (each opens with its own `initialize`; request ids restart at 0). The child's calls have `threadId` ≠ `sessionId`. There is no `s2c.jsonl`: the replies of the two connections can't be paired by id. The matching rollouts are `../transcripts/subagent/`. |
| `two-turns/` | Fix pass, under `C:\gok130`: one `codex app-server` thread (legacy history mode) with two turns, three `echo` calls in all, and one compaction in turn 1. Codex started **one** server process (`starts.jsonl`), so the process lives per thread, not per turn. The matching rollout is `../transcripts/compaction-legacy/`. |

## Spike F (GOK-131)

`chore-role/c2s.jsonl`: the messages Codex sent to the grimoire server process
of a `grimoire-chores` role thread, including its `tools/call` `_meta`
(`threadId` = child, `sessionId` = root, no role name). See
`chore-role/README.md`.
