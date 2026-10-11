# Claude Code hook payloads

What Claude Code 2.1.296 wrote to a hook's stdin, byte for byte (with its
trailing newline), apart from the sanitizing in `../README.md`. Provenance is
in `../README.md`.

| File | Event | Session | Notes |
| -- | -- | -- | -- |
| `pre-tool-use.json` | `PreToolUse` | `0b95f7c0…` (`../transcripts/plain/`) | Main thread, `mcp__grimoire__show`. No `agent_id` or `agent_type`. Its `tool_use_id` is in the plain transcript. |
| `pre-tool-use-subagent.json` | `PreToolUse` | `0e195270…` (`../transcripts/subagent/`) | Inside a `general-purpose` subagent: adds `agent_id` and `agent_type`. `session_id` and `transcript_path` are the parent's. |
| `session-start-startup.json` | `SessionStart` | `0b95f7c0…` | `source: "startup"`. |
| `session-start-clear.json` | `SessionStart` | `bd89d1c0…` (`../transcripts/clear/`) | `source: "clear"`, fired for the new session that `/clear` started. |
| `session-start-compact.json` | `SessionStart` | `18aa1670…` (`../transcripts/compaction/`) | `source: "compact"`, same session id as before `/compact`. Adds `prompt_id` and `model`. |
| `session-start-resume.json` | `SessionStart` | `bd89d1c0…` (`../transcripts/resume/`) | `source: "resume"` (`--resume` without `--fork-session`). Adds `seconds_since_last_response`, `context_tokens` and cache fields. |
| `session-start-fork.json` | `SessionStart` | `c90649d0…` (`../transcripts/fork/`) | `source: "fork"`, the new session id. It does not name the session it was forked from. |
