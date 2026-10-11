# Claude Code hook outputs that were honoured

The exact stdout of the spike's probe `PreToolUse` hook, which Claude Code
2.1.296 honoured. The server received the updated input (see
`../meta/tools-call.json`). Sanitizing and provenance are in `../README.md`.

| File | Hint | Honoured in |
| -- | -- | -- |
| `pre-tool-use-updated-input.json` | `session_id`, `transcript_path`, `tool_use_id` (the subagent fields are omitted when absent) | default, `manual`, plan (read-only tools), acceptEdits, auto and dontAsk with an `mcp__grimoire` allow rule; bypassPermissions; and default mode with no rule, approved through a permission prompt. Its input is the one in `../hook-payloads/pre-tool-use.json`. |
| `pre-tool-use-updated-input-ids-only.json` | `session_id`, `tool_use_id` | Also in auto mode with no allow rule, where the auto-mode classifier denied grimoire calls (a write and a read) whose hint held `transcript_path` ("[Data Exfiltration]"). Captured in a separate probe session (`76c4bd48…`), so its ids match no fixture transcript. |

Neither output carries a `permissionDecision`. The key name `_grimoire_hint` was
the probe's choice; the MCP slice picks the real one.
