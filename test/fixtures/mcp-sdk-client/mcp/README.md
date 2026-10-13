# MCP TypeScript SDK client wire traffic (2025-06-18 era)

Traffic from the MCP TypeScript SDK's own client, standing in for a generic
2025-era MCP client. No real agent client sends a `tools/call` without `_meta`
(Claude Code always stamps the 2026-07-28 envelope; Codex sends its own
per-call `_meta`), so this is the fixture for that case. Findings:
`docs/research/spikes/mcp-dual-era.md`.

`session-2025-06-18/` holds `c2s.jsonl` (the client's bytes, exactly as the
server received them), `s2c.jsonl` (the probe's replies) and `starts.jsonl`:

1. `initialize` at `2025-06-18`, declaring only `elicitation` (Codex's shape);
2. `notifications/initialized`, `tools/list`;
3. `tools/call` with no `_meta` at all;
4. `tools/call` carrying the reserved key `_grimoire` (its values are
   placeholders written by the capture script, in the shape grimoire's hook
   fills).

## Provenance

- Client: `@modelcontextprotocol/client` 2.3.1 (`supportedProtocolVersions:
  ['2025-06-18']`), Node 24.21.0.
- Server: the probe bundled by esbuild, `@modelcontextprotocol/server` 2.3.1.
- OS: Windows 11 Pro 10.0.26200. Captured 2026-10-11.
- Reproduce: `node test/spikes/mcp-dual-era/capture-sdk-client.mjs <new-dir>`.

## Sanitizing

None needed.
