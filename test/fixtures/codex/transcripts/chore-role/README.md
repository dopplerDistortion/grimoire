# Codex rollouts: the grimoire-chores role spawned with a fresh context (Spike F, GOK-131)

Two rollouts from one `codex exec` run (file names kept): the root thread
(`thread_source: "user"`) and the child it spawned (`thread_source:
"subagent"`). Findings: `docs/research/spikes/codex-skills-role-exec.md` (P5).
Encoded in `test/spikes/codex-skills-role-exec.test.ts`. The child's grimoire
MCP traffic is in `../../mcp/chore-role/`.

The repo held:

- `.codex/agents/grimoire-chores.toml`: a project role file (`name`,
  `description`, `developer_instructions` starting with the marker
  `GRIM-P5-ROLE-INSTRUCTIONS`, `[features]` with `shell_tool`, `apps`,
  `plugins`, `memories` and `request_permissions_tool` all `false`, and
  `[skills] include_instructions = false`). The full text is in the findings.
- `.agents/skills/grimoire-chores/SKILL.md`: the chore skill, telling the agent
  to spawn that role with `fork_context: false`.
- `.codex/config.toml`: `[mcp_servers.grimoire]`, a stub stdio server
  (`test/spikes/codex-skills-role-exec/stub-mcp.mjs`) serving the chore tools.

The root's prompt began with the marker `GRIM-P5-ROOT-ONLY-CONTEXT`. Its
scripted turn: read the skill (`Get-Content`), `tool_search` for spawning,
`spawn_agent` (namespace `multi_agent_v1`) with
`{agent_type: "grimoire-chores", fork_context: false, message}`, `wait_agent`,
then "chores done". The child's scripted turn: `exec_command` (refused:
"unsupported call: exec_command"), `apply_patch` adding `chore-wrote.txt`
(succeeded), `tool_search` for the grimoire tools, `chore_start` (namespace
`mcp__grimoire`), then a summary line.

**Captured under a scripted model**: which tools were called, with which
arguments, and the assistant texts. Whether a real model follows the skill and
honours the role is not shown. Everything else (the role reaching the child's
config, its tool list, the session metadata) is the real Codex.

## Provenance

- **Client:** Codex CLI 0.162.1 (`codex.exe exec --json -s danger-full-access
  --skip-git-repo-check "<prompt>"`), not logged in. Throwaway `CODEX_HOME`
  declaring the stand-in provider (`wire_api = "responses"`, model `gpt-5.5`)
  and trusting the repo.
- **OS:** Windows 11 Pro 10.0.26200, Node 24.21.0. Captured 2026-10-11.
- **Script:** `test/spikes/codex-skills-role-exec/p5-role.mjs fresh`.

## Sanitizing

`test/spikes/codex-skills-role-exec/sanitize.mjs`: the Windows user name became
`USER` and the time zone `Europe/Istanbul` became `Etc/UTC`, everywhere they
occurred. Nothing else changed.
