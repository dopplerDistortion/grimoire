# Codex `tools/call` requests and `_meta` shapes

## Spike E (GOK-130)

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`. Each file is one `tools/call` line exactly as Codex 0.162.1
wrote it to the probe's stdin (2025-06-18 era), with the newline kept.

| File | What it shows |
| -- | -- |
| `tools-call.json` | A root-thread call (`echo`). In `_meta`: `callId` (the model's `function_call.call_id`), `threadId` = `sessionId` (the root thread), `windowId` (`<thread>:0`), `itemId` (the `fc_…` item id), `progressToken`, and an `x-codex-turn-metadata` object (snake_case `session_id`, `thread_id`, `turn_id`, model, sandbox, absolute workspace paths, `codex_version`). Its `callId` is a `function_call` (namespace `mcp__probe`, name `echo`) in `../transcripts/paginated/`. |
| `tools-call-subagent.json` | A call from a `spawn_agent` subagent thread. `threadId` is the child thread and `sessionId` is still the root. The turn metadata adds `parent_thread_id`, `subagent_kind` and `thread_source: "subagent"`. Its `callId` is in the child rollout in `../transcripts/subagent/`. |
