# Claude Code hook payloads

Each file is the exact stdin a hook command received, saved byte for byte by an
observer hook that printed nothing.

## Spike C (GOK-128)

- **Client:** Claude Code 2.1.296, `claude -p` (headless), model `claude-opus-5-5`
  except `pre-tool-use-main-context.json` (`claude-haiku`; the model is not in
  the payload).
- **OS:** Windows 11 (native, no WSL). Captured 2026-10-11.
- **Setup:** throwaway git repos with a stub stdio MCP server named `grimoire`
  (`.mcp.json`) serving the 4 chore tools, observer hooks in exec form
  (`PreToolUse` matcher `mcp__grimoire__.*` and `.*`, `SubagentStart`,
  `SubagentStop`, `SessionStart`). Full setup:
  `docs/research/spikes/claude-skills-chores.md`.
- **Sanitized:** the Windows user name in every path became `user`
  (`C:\Users\user\…`, `C--Users-user-…`). Nothing else changed.

| File | What it shows |
| -- | -- |
| `pre-tool-use-chore-subagent.json` | `PreToolUse` for `mcp__grimoire__chore_start` called by the `grimoire-chores` subagent that the `context: fork` skill `grimoire-chores` launched: `agent_id` and `agent_type: "grimoire-chores"` present, `mcp_server: {name, source: "project"}`, `transcript_path` is the parent session's. Pairs with `../meta/tools-call-chore-subagent.json` by `tool_use_id`. |
| `pre-tool-use-general-purpose-subagent.json` | The same tool called from a `general-purpose` subagent launched with the Agent tool: `agent_type: "general-purpose"`. Chore admission must refuse it. |
| `pre-tool-use-main-context.json` | The same tool called from the main conversation: no `agent_id`, no `agent_type`. |
| `subagent-start-chore-subagent.json` | `SubagentStart` for the forked `grimoire-chores` subagent (same session and `agent_id` as the transcripts in `../transcripts/chore-fork/`). |
| `session-start-startup.json` | `SessionStart` (`source: "startup"`) as a `-p` session delivers it to an exec-form hook run through the bootstrap stand-in. |

## Spike A (GOK-126)

What Claude Code 2.1.296 wrote to a hook's stdin, byte for byte (with its
trailing newline), apart from spike A's sanitizing. Provenance and sanitizing
are in `../README.md`.

| File | Event | Session | Notes |
| -- | -- | -- | -- |
| `pre-tool-use.json` | `PreToolUse` | `0b95f7c0…` (`../transcripts/plain/`) | Main thread, `mcp__grimoire__show`. No `agent_id` or `agent_type`. Its `tool_use_id` is in the plain transcript. |
| `pre-tool-use-subagent.json` | `PreToolUse` | `0e195270…` (`../transcripts/subagent/`) | Inside a `general-purpose` subagent: adds `agent_id` and `agent_type`. `session_id` and `transcript_path` are the parent's. |
| `session-start-startup-plain.json` | `SessionStart` | `0b95f7c0…` | `source: "startup"`. |
| `session-start-clear.json` | `SessionStart` | `bd89d1c0…` (`../transcripts/clear/`) | `source: "clear"`, fired for the new session that `/clear` started. |
| `session-start-compact.json` | `SessionStart` | `18aa1670…` (`../transcripts/compaction/`) | `source: "compact"`, same session id as before `/compact`. Adds `prompt_id` and `model`. |
| `session-start-resume.json` | `SessionStart` | `bd89d1c0…` (`../transcripts/resume/`) | `source: "resume"` (`--resume` without `--fork-session`). Adds `seconds_since_last_response`, `context_tokens` and cache fields. |
| `session-start-fork.json` | `SessionStart` | `c90649d0…` (`../transcripts/fork/`) | `source: "fork"`, the new session id. It does not name the session it was forked from. |
