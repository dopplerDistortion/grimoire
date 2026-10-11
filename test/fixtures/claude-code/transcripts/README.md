# Claude Code transcripts

Session transcripts as Claude Code writes them under
`~/.claude/projects/<encoded-cwd>/`. Subagent transcripts keep their real
relative layout: `<session-id>/subagents/agent-<agent_id>.jsonl` plus
`agent-<agent_id>.meta.json`.

## Spike C (GOK-128)

- **Client:** Claude Code 2.1.296, `claude -p` (headless). Windows 11 (native).
  Captured 2026-10-11.
- **Sanitized** (every line parsed and re-serialized with `JSON.stringify`,
  which reproduces Claude Code's bytes exactly for unchanged lines):
  - the Windows user name in every path became `user`; the account e-mail
    became `user@example.com`; the organization UUID became all zeros;
  - in the client-noise attachments (`skill_listing`, `deferred_tools_delta`,
    `deferred_tools_record`, `mcp_instructions_delta`, `agent_listing_delta`,
    `prompt_snapshot`): entries for the capturing user's personal, plugin and
    claude.ai skills and MCP servers were removed (only `grimoire-*` skills and
    `mcp__grimoire__*` tools are left; `skillCount` still shows the real count),
    and any string over 600 characters was cut to its first 300 with a
    `…[fixture sanitizer: shortened from N chars]` marker;
  - conversation lines (`user`, `assistant`, tool results) are untouched apart
    from the path, e-mail and UUID replacements.

| File | What it shows |
| -- | -- |
| `stub-match-read-tool.jsonl` | Model `claude-opus-5-5`. Prompt "Add a changelog entry saying we fixed the login timeout bug." in a repo with a self-ignoring stub `.claude/skills/grimoire-changelog-entry/` and copy `.grimoire/skills/changelog-entry/SKILL.md`. The first tool call is `Skill {skill: "grimoire-changelog-entry"}`; the stub body arrives as an `isMeta` user line whose `sourceToolUseID` is that call; then `Read` of the copy, then a `Write` that follows the copy's instructions. |
| `stub-match-shell-read.jsonl` | The same setup with `--model sonnet`: `Skill`, then the copy is read through `Bash` (`cat .grimoire/skills/changelog-entry/SKILL.md`), not the `Read` tool. |
| `chore-fork/c2eb58d9-….jsonl` | Main session: `Skill {skill: "grimoire-chores"}` (`context: fork`, `agent: grimoire-chores`) and its forked result carrying the chore `summary` verbatim. |
| `chore-fork/c2eb58d9-…/subagents/agent-a523fef26307d8241.jsonl` | The forked `grimoire-chores` subagent: a `deferred_tools_delta` naming only the 4 chore tools, `ToolSearch select:…`, then `chore_start`, `chore_read`, `chore_submit`. |
| `chore-fork/c2eb58d9-…/subagents/agent-a523fef26307d8241.meta.json` | `{"agentType":"grimoire-chores",…}`: how a reader tells a chore subagent's transcript apart without opening it. |

## Spike A (GOK-126)

Each folder below mirrors one Claude Code project folder, with the same file
names and the same `<session>/subagents/` and `<session>/tool-results/` layout.
All sessions ran in the probe repo
`C:\Users\user\AppData\Local\Temp\grimoire-spike-a\proj` (slug
`C--Users-user-AppData-Local-Temp-grimoire-spike-a-proj`). Provenance and
sanitizing are in `../README.md`.

| Folder | Files | What it shows |
| -- | -- | -- |
| `plain/` | `0b95f7c0….jsonl` | One prompt. A `ToolSearch` that loads the deferred grimoire tools, then `mcp__grimoire__show` (whose id is in `../hook-payloads/pre-tool-use.json`), Bash, a failing Bash (`is_error: true`), Read, Write, a Bash `git commit` (with a `Refs: gr-1` trailer and an agent co-author trailer) whose result has `[main cbbd0d3] Add notes`, and `mcp__grimoire__comment`. Path spellings: `C:\Users\user\…` (JSON-escaped), `C:/Users/user/…` (`pwd -W`), `/tmp/grimoire-spike-a/proj` (Git Bash's `pwd`, because the repo sits in `%TEMP%`), `/c/Users/user/…` (typed by the agent) and the project slug. |
| `clear/` | `249ac573….jsonl` (before), `bd89d1c0….jsonl` (after) | `/clear` sent over stream-json. The new file starts with a `mode` line, a `SessionStart:clear` hook record, and the `/clear` command lines. It shares no uuid with the old file and never names the old session. The old file ends with the queued `/clear` and a `cost-state` line. |
| `compaction/` | `18aa1670….jsonl` | A grimoire write and a Bash call, then `/compact`, then a grimoire read. One file and one session id. A `system`/`compact_boundary` line (`parentUuid: null`, `logicalParentUuid`, `compactMetadata.trigger: "manual"`), then one `isCompactSummary` user line, then a `SessionStart:compact` hook record. |
| `fork/` | `18aa1670….jsonl` (origin, the same file as `compaction/`), `c90649d0….jsonl` (fork) | `--resume 18aa1670… --fork-session`. The fork file copies the origin's active branch, from its compact boundary on. Copied lines keep their uuid, timestamp, `message.id` and tool-use ids, but `sessionId` is rewritten to the fork's id, `slug` is dropped, some `promptId`s are rewritten, and token counts on one copied assistant line are zeroed. The `SessionStart:fork` hook record is the first line the fork itself wrote. Forking left the origin file unchanged. |
| `subagent/` | `0e195270….jsonl`, `0e195270…/subagents/agent-aa0434c9616245e9e.jsonl` and `.meta.json` | The main thread launches a `general-purpose` subagent (`Agent` tool), which calls `mcp__grimoire__show` and Bash. Subagent lines carry the parent `sessionId`, `isSidechain: true` and `agentId`. The parent holds only the `Agent` call and its result (`toolUseResult.agentId`). `.meta.json` maps the subagent to the launching tool-use id. |
| `spill/` | `38eff1c4….jsonl`, `38eff1c4…/tool-results/b1w38gq52.txt` | A 198 KB Bash output. The transcript's `tool_result` holds a `<persisted-output>` preview naming the spill file. The spill file is cut to its first 40 lines, plus an elision marker. |
| `resume/` | `bd89d1c0….jsonl` | The `clear/` "after" file, then resumed with `--resume` (no fork). The same file and session id gain a `SessionStart:resume` hook record and a new turn. The first 39 lines are identical to `clear/bd89d1c0….jsonl`. |
