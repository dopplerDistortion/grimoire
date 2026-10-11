# Spike F: Codex skills, the chore role and the exec runner

*Spike for GOK-131 (spec §22: B2, P2 Codex half, P5, C4, P7, R4 Codex half). Run on 2026-10-11 against **Codex CLI 0.162.1** (`@openai/codex` with the native `x86_64-pc-windows-msvc` build) on Windows 11 Pro 10.0.26200, Node 24.21.0, Git 2.55.0.windows.3, PowerShell 5.1 as Codex's shell.*

> **Codex was never logged in, and never will be during this build** (advisor ruling, 2026-10-11, on GOK-131). Per that ruling, every item was run against the **real Codex binary with a scripted model**: a local stand-in for the OpenAI Responses API (`test/spikes/codex-skills-role-exec/scripted-responses.mjs`) replays the tool calls each item needs. Codex itself is real: config and role loading, skill discovery and listing, the sandbox, hooks, MCP, rollouts and `--json` output. Only the model's choices are scripted. So:
>
> - Items whose question is about Codex are **"confirmed (real Codex 0.162.1, scripted model)"**.
> - Items whose question is about model judgement or a real ChatGPT login stay **"unverifiable: fallback applies"**: P2, C4 and the model side of P5. Their fallbacks get built downstream.
> - GOK-172 must say in the README and release notes that Codex support was verified against the real binary with a scripted model, not a live session, and that the fallback paths are on.

## Verdicts

| Item | Verdict | Fallback taken? |
| -- | -- | -- |
| B2: skill folders written mid-session are picked up | **Confirmed** (real Codex 0.162.1, scripted model). From the next turn: a folder written by the SessionStart hook or during turn N is listed from turn N+1. A description rewritten in place was **not** re-listed. | No |
| P2 (Codex half): stub matched by description, then the copy read | **Unverifiable: fallback applies.** The mock shows the stub is listed with its description, and what a stub read followed by a copy read looks like. It can't show that a model picks the stub. | **Yes**: the `.agents/skills/` stub body leads with a `skill_read` call |
| P5: `spawn_agent` honours the `grimoire-chores` role with a fresh context; shell disable holds | **Role-config side confirmed** (real Codex 0.162.1, scripted model). **Model side unverifiable: fallback applies.** Caveat: the role can't remove `apply_patch` or `web_search`. | **Yes** for the model side: the in-place run under the root-thread rule stays built |
| C4: a saved ChatGPT login survives `codex exec --ignore-user-config` | **Unverifiable: fallback applies.** Partial evidence: a ChatGPT-mode `auth.json` (fake tokens) is still loaded and sent. But a login kept in the OS keyring would not be found. | **Yes**: keep the user config and turn off what it adds (flags below) |
| P7: read-only `codex exec` works on native Windows without `prefer_mxc` | **Confirmed** (real Codex 0.162.1, scripted model). The runner's run completes with the schema-shaped answer, and every shell command is refused there. | No |
| R4 (Codex half): a detached `sync --background` child survives after the shell command returns | **Fallback taken.** It depends on the sandbox mode: the child survives unsandboxed, but under MXC it is **killed**, and under the unelevated sandbox the shell call **blocks until the child exits**. | **Yes**: the sync-pending marker, retried by the next upkeep |

**Items that took the fallback: P2 (Codex half), P5 (model side), C4, R4 (Codex half).**

**Overlap with Spike E (GOK-130).** Spike E's findings (`codex-mcp-hooks-transcripts.md`) also cover B2, P7 and R4 on this machine. For B2 and P7 the results agree. For R4, Spike E ran unsandboxed (`danger-full-access`) and recorded "confirmed". This spike repeated that, and also ran under Codex's two Windows sandboxes, where the child is killed or blocks the shell call. **Read R4 from this file**: the sync-pending marker is load-bearing on Codex.

## Setup common to every item

- **Kit:** `test/spikes/codex-skills-role-exec/`. `kit.mjs` holds the helpers: throwaway `CODEX_HOME`, temp git repos, spawning `codex.exe` directly, and the app-server driver. There is one script per item (`b2-skills.mjs`, `p5-role.mjs`, `p7-runner.mjs`, `r4-detached.mjs`, `c4-auth.mjs`, `c4-fallback.mjs`), plus `stub-mcp.mjs` (a stdio MCP server named `grimoire` serving the chore tools) and `sanitize.mjs`. This is spike scaffolding: it lives under `test/`, is not part of the package, and is not run by `npm test`.
- **The stand-in model:** a node HTTP server answering `POST /v1/responses` with SSE. Each request plays the next step of a `PLAN: [...]` found in the newest user message (the prompt, or a `spawn_agent` message), per thread. A step is a function call (with `namespace` for MCP and multi-agent tools), a custom tool call (`apply_patch`), a `tool_search` call, a message, an HTTP error, or `response.failed`. It logs every request body. It logs the `Authorization` header only as scheme plus length.
- **Wiring:** `model_provider = "mock"` with `[model_providers.mock] name = "mock", base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses"`, model slug `gpt-5.5`. Under `--ignore-user-config` the same goes in as `-c` overrides, which still apply.
- **Never the user's `~/.codex`:** every run set `CODEX_HOME` to a fresh folder under `%TEMP%\gok131\runs\<run>\home`. Working repos were `git init`ed under `%TEMP%\gok131\runs\<run>\work` and trusted in that `config.toml`.
- **Reproduce:** `node test/spikes/codex-skills-role-exec/<script>.mjs <scratch-dir> [variant]` (Node 22+, `codex` 0.162.1 installed globally with npm). Each script prints its observations as JSON.

## B2: skill folders written mid-session

**Question.** Does Codex pick up skill folders written mid-session, and from which turn?

**Run** (`b2-skills.mjs`, fixture `codex/transcripts/skill-stub-read/`). One `codex app-server` thread (the TUI's core) ran three turns:

- A committed `.codex/config.toml` SessionStart hook wrote `.agents/skills/grimoire-hook-skill/SKILL.md` and its copy in `.grimoire/skills/hook-skill/`. Every generated folder got a `.gitignore` of `*`.
- Turn 1 ran a shell command that wrote the same pair for `tidewater-ledger`.
- Turn 2 read the stub and the copy, then rewrote the stub's description in place (adding "(v2)").
- Turn 3 only answered.

**Results.**

| Turn | `<skills_instructions>` sent | Lists `grimoire-hook-skill` | Lists `grimoire-tidewater-ledger` |
| -- | -- | -- | -- |
| 1 | the session's initial listing | no | no |
| 2 | a **new full listing** as a developer message at the start of the turn, plus a `world_state` line `{full: false, state: {host_skills}}` | **yes** | **yes** |
| 3 | none; the turn-2 listing stands | yes | yes, with the **old** description (not "(v2)") |

A repeat with an 11 s pause before turn 3 (`b2-skills.mjs <scratch> 11000`) gave the same turn-3 result.

**Evidence.**

- The rollout timeline: `session_meta`, then turn 1's skills listing (05:05:58.486), then the hook's write (05:05:58.643), then turn 1's user message (05:05:58.659). Codex snapshots the skill listing *before* the SessionStart hook runs. So a hook-written skill can't make turn 1, even though it lands before the prompt.
- The turn-2 listing adds a root `r1` = `<repo>/.agents/skills`. The folder didn't exist when the session started, and is git-ignored by its own `.gitignore`. Codex lists the stubs anyway.
- Source (0.162.1, `app-server/src/skills_watcher.rs`): the app-server watches the skill roots and clears its skills cache on a change. It is throttled to one change event per 10 s (`WATCHER_THROTTLE_INTERVAL`), and the first event goes through at once. The in-place rewrite came within 10 s of the earlier writes and was never re-listed, even 11 s later. **Don't count on a mid-session description change reaching Codex.** A new folder does reach it.

**Decision for dependent slices.**

- **GOK-157 (SessionStart fast path):** in Codex, skills the hook writes appear from turn 2, never turn 1 (there is no `reloadSkills` equivalent). The stub's `skill_read` line covers turn 1. Build exactly that; no Codex-specific output is needed.
- **GOK-153 (generated output):** self-ignoring `.agents/skills/grimoire-<name>/` folders are discovered. A stub rewritten mid-session (for example, a description change) may not reach a running Codex session until its next session; that is acceptable, since the copy's text is read fresh on each use.

## P2 (Codex half): stub matched by description, then the copy read

**Question.** Does Codex match a stub in a self-ignoring `.agents/skills/grimoire-<name>/` folder by its description, and then read the copy in `.grimoire/skills/`?

**Verdict: unverifiable: fallback applies.** Choosing a skill from its description is model judgement, and the stand-in only follows its plan. What the real Codex did show:

- **The stub is offered.** The listing entry is `- grimoire-tidewater-ledger: <description> (file: r1/grimoire-tidewater-ledger/SKILL.md)`, under Codex's skill rules: "If the user names a skill … OR the task clearly matches a skill's description shown above, you must use that skill for that turn", and "open and read its `SKILL.md` completely before taking task actions".
- **Codex has no skill tool.** A skill is used by reading its `SKILL.md` through the shell, so the "match" is a shell read of the stub.
- **The read signal is structured.** Each shell read is an `event_msg` `item_completed` `CommandExecution` whose `parsed_cmd` is `[{type: "read", cmd, name, path}]`. Turn 2 has `path: ".agents/skills/grimoire-tidewater-ledger/SKILL.md"` and then `path: ".grimoire/skills/tidewater-ledger/SKILL.md"`, each with the file's text in `aggregated_output`. The `path` is as the command wrote it (relative here).

**Stub shape used** (the spec's body, unchanged; the copy has the same description and the unprefixed name):

```markdown
---
name: grimoire-tidewater-ledger
description: Reconcile the tidewater ledger files in this repo. Use when the user asks to reconcile, balance or settle the tidewater ledger.
---

Generated by grimoire. Read and follow `.grimoire/skills/tidewater-ledger/SKILL.md`.

If that file is missing, call `skill_read` with `tidewater-ledger`.

If `.grimoire/config.yml` is absent in this checkout, grimoire isn't installed here: ignore this skill, and tell the user that `npx @goksening/grimoire leave` cleans these files up.
```

**Decision for dependent slices.**

- **GOK-153:** build the P2 fallback for the **Codex stub only** (`.agents/skills/grimoire-<name>/SKILL.md`). Its body leads with "Call `skill_read` with `<name>` and follow what it returns." The "Read and follow `.grimoire/skills/<name>/SKILL.md`" line becomes the second step, for when `skill_read` is unavailable. The `config.yml`-absent line stays. The Claude stub keeps §15's body, because spike C confirmed P2 for Claude Code. ADR 0002 is not reopened: nothing failed, the Codex half just can't be verified.
- **GOK-158 (skill facts in traces), Codex read signal:** count a `skill_read` MCP call for `<name>`, and a `CommandExecution` with a `parsed_cmd` entry `{type: "read"}` whose path, normalized for separators, ends in `.grimoire/skills/<name>/SKILL.md`. A read of the stub alone is not a read of the skill.

## P5: the `grimoire-chores` role, spawned with a fresh context

**Question.** Does `spawn_agent`, called from a skill instruction, honour the `grimoire-chores` role with a fresh context, and does the role's shell disable hold?

**Run** (`p5-role.mjs fresh`, fixtures `codex/transcripts/chore-role/` and `codex/mcp/chore-role/`). The repo held three files. **The role file** `.codex/agents/grimoire-chores.toml`:

```toml
name = "grimoire-chores"
description = "Runs grimoire's due maintenance chores with the grimoire chore tools only. Spawn it only from the grimoire-chores skill."
developer_instructions = """
GRIM-P5-ROLE-INSTRUCTIONS
Run grimoire's due maintenance chore with the grimoire chore tools (chore_start, chore_read, chore_submit, chore_abandon).
1. Call chore_start. 2. Page the inputs with chore_read. 3. Reason. 4. Submit with chore_submit.
5. At most one fix-up. 6. Run the Skill Proposer if it became due. 7. Return the last summary verbatim.
Never edit files and never ask for approval.
"""

[features]
shell_tool = false
apps = false
plugins = false
memories = false
request_permissions_tool = false

[skills]
include_instructions = false
```

**The skill** `.agents/skills/grimoire-chores/SKILL.md`:

```markdown
---
name: grimoire-chores
description: Run grimoire's due maintenance chores in an isolated subagent. Use when grimoire's session notice says one is due and the user agrees, or when the user asks.
---

Spawn a subagent with `spawn_agent`, `agent_type` set to `grimoire-chores` and `fork_context` set to `false` (on the v2 tool: `fork_turns: "none"`). Give it the message "Run the due grimoire chore." Wait for it, then return its final message verbatim.

If spawning is unavailable, run the chore here instead: call `chore_start`, page with `chore_read`, submit with `chore_submit`, and return the last summary verbatim.
```

**The MCP server:** `.codex/config.toml` declared `[mcp_servers.grimoire]` (the stub server).

**The scripted turns:**

- **Root:** read the skill, `tool_search` for spawning, `spawn_agent` with `{agent_type: "grimoire-chores", fork_context: false, message}`, then `wait_agent`.
- **Child:** `exec_command`, then `apply_patch` (adding a file), then `tool_search` for the grimoire tools, then `chore_start`.

**Results (role-config side, all real Codex):**

- **The role is discovered.** Codex 0.162.1 found the project role file in `.codex/agents/` (the project must be trusted). `spawn_agent` is on the v1 multi-agent tool (namespace `multi_agent_v1`, deferred behind `tool_search`). Its `agent_type` description lists `grimoire-chores: {<description>}` with the built-in `default`, `explorer` and `worker`. Its `fork_context` reads "True forks the current thread history into the new agent; false or omitted starts with only the initial prompt."
- **The child starts fresh.** Its input is the base instructions, one developer message (the role's `developer_instructions`, then the permissions block), the environment context and the spawn message. None of the root's history reached it (the root-only marker is absent from the child's rollout).
- **The skills listing can be dropped.** `[skills] include_instructions = false` in the role removed it. Without that line, a first run listed every skill to the child, including `grimoire-chores` itself and every evolved-skill stub.
- **The shell disable holds.** The child's tool list had no `exec_command` or `write_stdin`, and its `exec_command` call got `unsupported call: exec_command`.
- **`apply_patch` does not go away.** The child's `apply_patch` succeeded ("Success. Updated the following files: A chore-wrote.txt"). The child also kept `web_search`, `view_image`, `request_user_input`, the goal tools and the MCP resource tools. Source (`core/src/agent/role.rs`): a role layer applies only `developer_instructions`, model settings, `skills` narrowing, and **disabling** of exactly five features: `shell_tool`, `apps`, `plugins`, `memories` and `request_permissions_tool`. It can't change the sandbox, `web_search` or `apply_patch`. The child inherits the parent's sandbox: `danger-full-access` in this run, typically `workspace-write` in a session. So the chore thread can still edit workspace files.
- **The MCP tools stay reachable.** The child reached the grimoire MCP tools through `tool_search` (namespace `mcp__grimoire`), from its own server process. Its `tools/call` `_meta` has `threadId` = the child, `sessionId` = the root, and `x-codex-turn-metadata` with `subagent_kind: "thread_spawn"`, `thread_source: "subagent"` and `parent_thread_id`. **No role name** appears in `_meta`, so admission sees "a Codex subagent thread", whatever its role (spec §16's table already admits any subagent thread).
- **The child's rollout names its role.** Its `session_meta` has `agent_role: "grimoire-chores"`, `source.subagent.thread_spawn.agent_role: "grimoire-chores"`, `thread_source: "subagent"` and `session_id` = the root.
- **A role forbids a full-history fork.** `spawn_agent` with both `agent_type` and `fork_context: true` fails: "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork." (`p5-role.mjs fork`). A role can only run with a fresh context.

**Model side: unverifiable: fallback applies.** Whether a real model, reading the skill, actually calls `spawn_agent` with the role (and doesn't just run the procedure itself) is model judgement. `spawn_agent`'s own description supports it: "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents" (a skill instruction counts).

**Decision for dependent slices.**

- **GOK-166 (Codex carrier):** ship the role file as `.codex/agents/grimoire-chores.toml` in the shape above (`name`, `description`, `developer_instructions` = the procedure, the five `[features]` set to `false`), **plus `[skills] include_instructions = false`**. The skill passes `agent_type: "grimoire-chores"` and `fork_context: false`, and keeps the in-place fallback paragraph (the fallback applies, so the root-thread admission path must work end to end). Add "never use `apply_patch` or `web_search`" to the procedure text. Grimoire's admission check plus the role's instructions are the only guard against file edits: §16's "shell … disabled" holds, but "no tools but the chore tools" does not.
- **Admission (`chore_start`, Codex rows):** the `threadId` ≠ `sessionId` test is the subagent signal. The role is not visible to the server.
- **Capture (the Codex transcript reader):** identify a Codex chore thread by `session_meta.agent_role == "grimoire-chores"` (or `source.subagent.thread_spawn.agent_role`), to exclude it from excerpts and fact scans as §14 requires.

## C4: a saved ChatGPT login under `codex exec --ignore-user-config`

**Question.** Does a saved ChatGPT login survive `codex exec --ignore-user-config`?

**Verdict: unverifiable: fallback applies.** There is no ChatGPT login on this machine. What could be shown (`c4-auth.mjs`):

- **A file login is loaded.** With a ChatGPT-mode `CODEX_HOME/auth.json` holding **fake, unsigned** tokens, and the stand-in declared with `requires_openai_auth = true`, Codex sent `Authorization: Bearer <access_token>` and `chatgpt-account-id: <account_id>` to it. That held with `--ignore-user-config` (variant `ignore`) and without it (`plain`). `exec --help` says the same: "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`".
- **The store setting is lost.** With `cli_auth_credentials_store = "keyring"` in `config.toml`, `--ignore-user-config` dropped that setting too, and Codex read `auth.json` (variant `keyring`). Source: the store mode comes from the merged config and defaults to `file`. **A user whose login lives in the OS keyring (`keyring`, or `auto` with a keyring available) would look logged out under `--ignore-user-config`.**
- **Your own instructions leak in.** Under `--ignore-user-config`, the personal `CODEX_HOME/AGENTS.md` and personal skills (`CODEX_HOME/skills/`) still reached the prompt (`p7-runner.mjs`). `-c skills.include_instructions=false` removes the skills listing. No flag was found that drops the personal `AGENTS.md`.
- **Not tested:** whether OpenAI accepts a real saved login, and token refresh.

**The fallback works** (`c4-fallback.mjs`, a throwaway `config.toml` with one MCP server and one SessionStart hook):

- `codex mcp list --json` prints `[{name, enabled, disabled_reason, transport: {type, command, args, env, …}, …}]`.
- `-c mcp_servers.<name>.enabled=false` kept that server from starting.
- `-c features.hooks=false` kept the user hook from running.

**Decision for dependent slices.**

- **GOK-167 (runner):** build the fallback. Drop `--ignore-user-config`. Before each run, take server names from `codex mcp list --json` (read `name` only, never log the output: `transport.env` can hold secrets), and pass `-c mcp_servers.<name>.enabled=false` for each. Add **`-c features.hooks=false`**, because the user config's hooks would otherwise run, and the spec wants none. Also pass `-c skills.include_instructions=false`. If `codex mcp list` fails, `runner enable codex` refuses with an explanation. This also keeps keyring-stored logins working.

## P7: read-only `codex exec` on native Windows

**Question.** Does read-only `codex exec` work on native Windows without `prefer_mxc`?

**Run** (`p7-runner.mjs`, fixtures `codex/exec-json/runner/`). The spec's invocation was spawned as `codex.exe` by absolute path, with `windowsHide`, the bundle on stdin, a fresh empty temp `--cd`, and the stand-in passed as `-c` overrides:

```
exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
  --cd <tmp> --sandbox read-only --output-schema <schema.json> -o <out>
  -c features.apps=false -c features.plugins=false
```

**Results.**

| Variant | Exit | Shell read | Shell write | Stream |
| -- | -- | -- | -- | -- |
| `success` (no `prefer_mxc`) | 0 | refused: "blocked by policy" | refused: "blocked by policy" | `thread.started`, `turn.started`, `item.completed` (`agent_message` = the schema JSON), `turn.completed`; `-o` holds the same text |
| `mxc` (`-c features.prefer_mxc=true`) | 0 | ran (exit 0) | ran and failed: "Access to the path … is denied" | adds an `error` item ("Under-development features enabled: prefer_mxc…") and `command_execution` items |
| `notools` (`-c features.shell_tool=false -c web_search="disabled" -c skills.include_instructions=false`) | 0 | `unsupported call: exec_command` | the same | the same four events |
| `http400` (the model API answers 400) | 1 | — | — | `error`, then `turn.failed`, each with the API's error body |
| `nologin` (no stand-in, no login) | 1 | — | — | 5 WebSocket retries, an `error` item ("Falling back from WebSockets to HTTPS transport"), 5 HTTPS retries, `turn.failed` "unexpected status 401 Unauthorized …", about 17 s |

**Notes.**

- **Shell is refused without a sandbox.** `--ignore-user-config` drops any `[windows] sandbox` setting. With none configured and approvals at `never`, Codex refuses every command, reads included, before running it. 0.162.1 emits no `command_execution` item for such a refused call (its CHANGELOG lists that as fixed after this release). The model sees `exec_command failed: CreateProcess { message: "Rejected(\"…\") rejected: blocked by policy" }`.
- **The answer schema must be strict.** `--output-schema` reaches the model as `text.format = {type: "json_schema", strict: true, name: "codex_output_schema", schema}`. The schema must therefore be OpenAI-strict: every property required, `additionalProperties: false`.
- **The tool list stays long.** Even read-only, the runner's tool list holds `exec_command`, `write_stdin`, `apply_patch`, `web_search`, `view_image`, `request_user_input`, the goal tools and `tool_search`. `-c features.shell_tool=false` and `-c web_search="disabled"` remove the shell and web search.
- **The npm shim adds nothing the runner needs.** It (`bin/codex.js`) only sets package-manager variables before spawning the native binary. The binary sits at `<npm prefix>/node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe`.

**Decision for dependent slices.**

- **GOK-167:** no `prefer_mxc` (it is an under-development feature, and it adds a warning item). The runner needs no shell. Use the §16 flags with the C4 fallback changes above, plus `-c features.shell_tool=false -c web_search="disabled"` so the model has no shell or web to try. Treat a non-zero exit, a `turn.failed` event, or a missing or invalid `-o` file as failure; these fixtures are the parser's test data. Resolve and store the `codex.exe` path at enable time, never the `.cmd` shim.

## R4 (Codex half): a detached child after the shell command returns

**Question.** Does a detached `sync --background` child survive Codex's job object after the shell command returns?

**Run** (`r4-detached.mjs`). The scripted model ran `node bg-parent.cjs <marks>` through `exec_command`. The parent spawned `bg-child.cjs` the way `sync --background` will (`detached: true, stdio: 'ignore', windowsHide: true`, then `unref()`) and exited. The child tried a write under `.git/grimoire/`, wrote `started.json`, slept 8 s, then wrote `finished.json`. The script checked 15 s after `codex exec` exited.

| Mode | Child ran | Child survived to the end | Shell call returned | `codex exec` exit | Write under `.git/grimoire/` |
| -- | -- | -- | -- | -- | -- |
| `-s danger-full-access` (no sandbox) | yes | **yes** | at once (0.06 s) | **waited** for the child (8.7 s) | ok |
| `-s workspace-write`, no Windows sandbox configured | no: the command was refused ("blocked by policy") | — | at once | 4 s | — |
| `-s workspace-write -c windows.sandbox="unelevated"` | yes | **yes** | **only when the child exited** (8.05 s wall time) | 18.5 s (first-run sandbox setup included) | **EPERM** |
| `-s workspace-write -c features.prefer_mxc=true` (MXC) | not when the parent exits at once (no `started.json`); with the parent lingering 3 s it started | **no: killed** when the shell command ended | at once | 1 to 5 s | **EPERM** |

**Verdict: fallback taken.** The child survives only unsandboxed. Under the unelevated sandbox it survives but holds the agent's shell call open. Under MXC it is killed with the command.

**Decision for dependent slices.**

- **The background sync owner (spec §4 write path; GOK-139 per Spike E):** keep the sync-pending marker, retried by the next upkeep, as the spec requires. On Codex it is the only reliable path. Keep `sync --background` short, since it can hold the shell call open (unelevated) or the `codex exec` exit (unsandboxed).
- **Side finding, for every CLI write from a Codex shell:** under both Windows sandboxes in `workspace-write`, writes under `.git/` fail with EPERM: Codex protects `.git` as read-only. A sandboxed Codex agent running `grimoire` CLI writes will fail to write `<git-common-dir>/grimoire/` (and git refs). Prefer the MCP tools (the `grimoire mcp` process runs unsandboxed) in Codex instructions, and make CLI write failures under a Codex sandbox explain that. Spike E's P3 covers the hook process. This covers the agent's shell.

## Fixtures added (seam 2)

All were captured from the real Codex 0.162.1 and sanitized by `sanitize.mjs` (user name to `USER`, time zone to `Etc/UTC`, the package name `@goksening/grimoire` kept). Each folder has a README with provenance. Encoded in `test/spikes/codex-skills-role-exec.test.ts`.

- `codex/exec-json/runner/`: `success.jsonl`, `no-shell-tool.jsonl`, `model-api-error.jsonl` (scripted model) and `not-logged-in.jsonl` (no stand-in at all).
- `codex/transcripts/skill-stub-read/`: the B2/P2 rollout. The listings per turn, then the stub read followed by the copy read with `parsed_cmd` read actions (scripted model).
- `codex/transcripts/chore-role/`: the P5 root and child rollouts (scripted model).
- `codex/mcp/chore-role/c2s.jsonl`: the child thread's MCP messages, with the `tools/call` `_meta`.
