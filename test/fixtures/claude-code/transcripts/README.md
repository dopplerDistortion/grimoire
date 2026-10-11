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
