# Claude Code `tools/call` requests and `_meta` shapes

## Spike C (GOK-128)

- **Client:** Claude Code 2.1.296, `claude -p`, Windows 11, captured 2026-10-11.
- **How:** a stub stdio MCP server logged each JSON-RPC line it received; the
  file is that line parsed and re-serialized with `JSON.stringify` (Claude Code
  sends compact JSON, so the bytes match what it wrote, minus the newline).
- **Sanitized:** nothing needed changing.

| File | What it shows |
| -- | -- |
| `tools-call-chore-subagent.json` | `tools/call` for `chore_start` from the forked `grimoire-chores` subagent. `_meta` holds only `claudecode/toolUseId` and `progressToken`: no session or agent identity. Its `claudecode/toolUseId` equals `tool_use_id` in `../hook-payloads/pre-tool-use-chore-subagent.json`. The connection had negotiated protocol `2025-06-18` (the stub declined `server/discover`). |

## Spike A (GOK-126)

`tools-call.json` is the JSON-RPC `tools/call` request that Claude Code 2.1.296
sent to spike A's probe stdio server for the call in
`../hook-payloads/pre-tool-use.json`. The probe parsed each line and logged it,
and this file is that message re-serialized, with its field order kept.
Provenance and sanitizing are in `../README.md`.

- `params.arguments` is the hook's `updatedInput`, reserved key included.
- `params._meta` holds `"claudecode/toolUseId"` (equal to the hook payload's
  `tool_use_id`) and `progressToken`.
- The connection had negotiated protocol `2025-11-25`. Claude Code first sent
  `server/discover` with `_meta["io.modelcontextprotocol/protocolVersion"]:
  "2026-07-28"`. The probe answered "method not found", and Claude Code fell
  back to `initialize` with `protocolVersion: "2025-11-25"`.
