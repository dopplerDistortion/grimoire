# Claude Code `tools/call` requests (`_meta`)

`tools-call.json` is the JSON-RPC `tools/call` request that Claude Code 2.1.296
sent to the probe stdio server for the call in
`../hook-payloads/pre-tool-use.json`. The probe parsed each line and logged it,
and this file is that message re-serialized, with its field order kept.
Sanitizing and provenance are in `../README.md`.

- `params.arguments` is the hook's `updatedInput`, reserved key included.
- `params._meta` holds `"claudecode/toolUseId"` (equal to the hook payload's
  `tool_use_id`) and `progressToken`.
- The connection had negotiated protocol `2025-11-25`. Claude Code first sent
  `server/discover` with `_meta["io.modelcontextprotocol/protocolVersion"]:
  "2026-07-28"`. The probe answered "method not found", and Claude Code fell
  back to `initialize` with `protocolVersion: "2025-11-25"`. Handshake fixtures
  belong to spike B (GOK-127).
