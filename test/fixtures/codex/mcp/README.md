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
