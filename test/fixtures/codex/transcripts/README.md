# Codex transcripts (rollout files)

Rollouts as Codex writes them under `$CODEX_HOME/sessions/YYYY/MM/DD/`
(`rollout-<local time>-<thread id>.jsonl`). Archived ones go to
`$CODEX_HOME/archived_sessions/`, and cold ones become `….jsonl.zst`. File names
are the real ones.

## Spike E (GOK-130)

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`. The format notes the reader needs are in
`docs/research/spikes/codex-mcp-hooks-transcripts.md` ("Codex transcripts").

**Scenario A** (`test/spikes/codex-mcp-hooks-transcripts/plan-a.mjs`) is one turn with:
- `tool_search` for the probe;
- an MCP `echo` naming `gr-7k2pq`;
- `Get-Content .grimoire/skills/probe/SKILL.md` (a skill read through the shell);
- `git commit --allow-empty` with a `Refs: gr-7k2pq` trailer;
- a failing `node -e "process.exit(3)"`;
- an `apply_patch` adding `notes.txt`;
- a long-running `exec_command` that yields "Process running with session ID N", then a `write_stdin` poll that sees it exit.

The repo had grimoire's SessionStart hook block, run with `--dangerously-bypass-hook-trust`, and `codex exec -s danger-full-access`.

| Folder | What it shows |
| -- | -- |
| `paginated/` | Scenario A under `codex exec`: `history_mode: "paginated"`, an `ordinal` on every line, `event_msg` `item_completed` items (`McpToolCall`, `CommandExecution` with `status`/`exit_code`, `FileChange`, …). The failing command reports exit code **1** (PowerShell flattens the native 3). |
| `legacy/` | Scenario A through `codex app-server` with `thread/start {historyMode: "legacy"}`: no `ordinal`, the legacy events (`user_message`, `mcp_tool_call_end`, `patch_apply_end`, `agent_message`), and no structured exit code anywhere. The hook was untrusted there, so it didn't run. |
| `subagent/` | A root thread (`thread_source: "user"`) that calls `spawn_agent` (namespace `multi_agent_v1`) and `wait_agent`, plus the child's own rollout (`thread_source: "subagent"`, `session_id` = root, `source.subagent.thread_spawn.parent_thread_id` = root). Both threads call `echo`, and the child runs `git log --oneline -1`. |
| `subagent-legacy-root/` | The same root-and-subagent plan through `codex app-server` with `thread/start {historyMode: "legacy"}`. The root is legacy (no `ordinal`, `source: "vscode"`, **no `thread_source` field**); the child it spawned is **paginated** (`thread_source: "subagent"`, `session_id` = root). The history mode is per file. |
| `compaction/` | An auto-compaction mid-turn in paginated mode, local because the provider isn't OpenAI. It was triggered by the stand-in reporting 50,000 tokens against `model_auto_compact_token_limit = 2000`. In order: the summarizer's reply as an assistant `response_item`, then `compacted` (`message`, `replacement_history`, …), `world_state`, `turn_context`, `thread_settings_applied`, and `item_completed` `ContextCompaction`. |
| `compaction-legacy/` | The same compaction in legacy mode, through `codex app-server`, followed by a second turn on the same thread. The order is the same up to `thread_settings_applied`, then `event_msg` `token_count` and `event_msg` `context_compacted`. The wire traffic is in `../mcp/two-turns/`. |
| `mcp-results/` | What the model saw for each MCP result shape (one turn, the wire traffic is in `../mcp/tools-call/`): `which` (only `structuredContent`), `big` (24,482 bytes, whole), `boom` (a JSON-RPC error as two content items), two parallel `echo`s. Every output starts with `Wall time: … seconds\nOutput:`. |
| `truncation/` | Codex's own cut, gpt-5.5: a raw MCP server's `huge` tool returning 30,000, 45,000, 60,000 and 120,000 bytes, then `fail` (`isError` with `structuredContent`) and `textonly`. The first two are whole. The other two keep 48,000 characters, head and tail, around Codex's first-pass mark (`…3020 tokens truncated…`, `…18013 tokens truncated…`). What the model received instead is in `../model-input/truncation.jsonl`. |
| `truncation-unknown-model/` | The 30,000-byte result under `-m unknown-model-x`, a slug missing from Codex's catalog: 12,000 characters kept, mark `…18188 chars truncated…` (the exact count). Then an `exec_command` printing `CODEX_SESSION_ID`, `CODEX_THREAD_ID` and `CODEX_VERSION`. The model's copy is in `../model-input/truncation-unknown-model.jsonl`. |
| `archived-zstd/` | A short paginated session (`tool_search`, an MCP `echo`, `git log`), in `before-archive/` as it was, and in `archived_sessions/` after `thread/archive` (moved, same name), back-dated 9 days and compressed by the app-server's `rollout/compress` RPC. Both are Codex's bytes, unchanged: the `.zst` is Codex's own zstd frame, and it decodes to exactly the `before-archive/` file. |

## Spike F (GOK-131)

Captured under a scripted model. Each folder's README has its run and
provenance.

| Folder | What it shows |
| -- | -- |
| `skill-stub-read/` | B2 (no `.agents/` at thread start) and P2: one app-server thread, three turns. Turn 1's skills listing lacks the stubs that the SessionStart hook and a turn-1 command wrote. Turn 2 opens with a new full `<skills_instructions>` listing them (plus a `world_state` `host_skills` update), then reads the stub and the copy (`CommandExecution` `parsed_cmd` `{type: "read", path}`). An in-place description edit is never re-listed, because the root created mid-session is not watched. |
| `skill-roots/` | B2 in depth, three rollouts. With `.agents/skills/` present at thread start, a change is listed from the first turn after Codex's file watcher delivers it (at once, or after up to 10 s in a burst). Without it, the new root is listed once and never re-read. |
| `chore-role/` | P5: a root thread spawning the `grimoire-chores` role (`.codex/agents/grimoire-chores.toml`) with `fork_context: false`, and the child's rollout: `agent_role: "grimoire-chores"` in `session_meta`, the role's developer instructions, no skills listing, `exec_command` refused, `apply_patch` still working, `chore_start` over MCP. |
