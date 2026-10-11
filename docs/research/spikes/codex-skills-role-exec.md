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
| B2: skill folders written mid-session are picked up | **Confirmed, with two limits** (real Codex 0.162.1, scripted model). When `.agents/skills/` exists as the thread starts, the usual case: a folder written by the SessionStart hook is listed from turn 2. Any other change (a new folder or a description edit) is listed from the first turn that starts after Codex's file watcher delivers it. The watcher passes the first change at once and holds later ones until 10 s after the previous one. When `.agents/skills/` is created mid-session, it is listed once, from the next turn, and **nothing under it is re-read in that session**. | No |
| P2 (Codex half): stub matched by description, then the copy read | **Unverifiable: fallback applies.** The mock shows the stub is listed with its description, and what a stub read followed by a copy read looks like. It can't show that a model picks the stub. | **Yes**: the `.agents/skills/` stub body leads with a `skill_read` call |
| P5: `spawn_agent` honours the `grimoire-chores` role with a fresh context; shell disable holds | **Role-config side confirmed** (real Codex 0.162.1, scripted model). **Model side unverifiable: fallback applies.** Caveat: the role can't remove `apply_patch` or `web_search`. | **Yes** for the model side: the in-place run under the root-thread rule stays built |
| C4: a saved ChatGPT login survives `codex exec --ignore-user-config` | **Unverifiable: fallback applies.** Partial evidence: a ChatGPT-mode `auth.json` (fake tokens) is still loaded and sent. But a login kept in the OS keyring would not be found. | **Yes**: keep the user config and turn off what it adds: MCP servers, hooks, the legacy `notify` program, `developer_instructions`, the skills block and the model provider (flags below) |
| P7: read-only `codex exec` works on native Windows without `prefer_mxc` | **Confirmed** (real Codex 0.162.1, scripted model). The spec's invocation completes with the schema-shaped answer, and every shell command is refused there. The final runner invocation (C4 fallback flags, user config kept) also completes, with no shell at all. | No |
| R4 (Codex half): a detached `sync --background` child survives after the shell command returns | **Fallback taken.** It depends on the sandbox mode: the child survives unsandboxed, but under MXC it is **killed**, and under the unelevated sandbox the shell call **blocks until the child exits**. | **Yes**: the sync-pending marker, retried by the next upkeep |

**Items that took the fallback: P2 (Codex half), P5 (model side), C4, R4 (Codex half).**

**Overlap with Spike E (GOK-130).** Spike E's findings (`codex-mcp-hooks-transcripts.md`) also cover B2, P7 and R4 on this machine. For P7 the results agree. For B2 they agree on the case Spike E ran; this file adds the limits above. For R4, Spike E ran unsandboxed (`danger-full-access`) and recorded "confirmed". This spike repeated that, and also ran under Codex's two Windows sandboxes, where the child is killed or blocks the shell call. **Read R4 from this file**: the sync-pending marker is load-bearing on Codex.

## Setup common to every item

- **Kit:** `test/spikes/codex-skills-role-exec/`. `kit.mjs` holds the helpers: throwaway `CODEX_HOME`, temp git repos, spawning `codex.exe` directly, and the app-server driver. There is one script per item (`b2-skills.mjs`, `p5-role.mjs`, `p7-runner.mjs`, `r4-detached.mjs`, `c4-auth.mjs`, `c4-fallback.mjs`), plus `stub-mcp.mjs` (a stdio MCP server named `grimoire` serving the chore tools) and `sanitize.mjs`. This is spike scaffolding: it lives under `test/`, is not part of the package, and is not run by `npm test`.
- **The stand-in model:** a node HTTP server answering `POST /v1/responses` with SSE. Each request plays the next step of a `PLAN: [...]` found in the newest user message (the prompt, or a `spawn_agent` message), per thread. A step is a function call (with `namespace` for MCP and multi-agent tools), a custom tool call (`apply_patch`), a `tool_search` call, a message, an HTTP error, or `response.failed`. It logs every request body. It logs the `Authorization` header only as scheme plus length.
- **Wiring:** `model_provider = "mock"` with `[model_providers.mock] name = "mock", base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses"`, model slug `gpt-5.5`. Under `--ignore-user-config` the same goes in as `-c` overrides, which still apply. The final runner invocation pins `model_provider="openai"`, so its run reached the stand-in through `-c openai_base_url=…` instead.
- **Never the user's `~/.codex`:** every run set `CODEX_HOME` to a fresh folder under `%TEMP%\gok131\runs\<run>\home`. Working repos were `git init`ed under `%TEMP%\gok131\runs\<run>\work` and trusted in that `config.toml`.
- **Reproduce:** `node test/spikes/codex-skills-role-exec/<script>.mjs <scratch-dir> [variant]` (Node 22+, `codex` 0.162.1 installed globally with npm). Each script prints its observations as JSON.

## B2: skill folders written mid-session

**Question.** Does Codex pick up skill folders written mid-session, and from which turn?

**Runs** (`b2-skills.mjs <scratch> <variant>`). Each variant is one `codex app-server` thread (the TUI's core). A committed `.codex/config.toml` SessionStart hook writes `.agents/skills/grimoire-hook-skill/SKILL.md` and its copy in `.grimoire/skills/hook-skill/`. Turn 1 runs a shell command that writes the same pair for `tidewater-ledger`. Every generated folder gets a `.gitignore` of `*`. Two starting states were run:

- **Root present** (`existing-root`, `existing-root-wait11000`; fixture `codex/transcripts/skill-roots/`). A committed `.agents/skills/grimoire-chores/SKILL.md` means the root exists when the thread starts. This is the steady state from a repo's second session on. The hook also prints the time of its write, so the rollout records it. Turn 2 rewrites the tidewater stub's description in place (adding "(v2)"). Turn 3 writes a new pair, `late-folder`. Turns 4 and 5 only answer. Turn 5 always starts 11 s after turn 4. In the `-wait11000` variant every turn after the first starts 11 s after the previous one ends.
- **Root created mid-session** (`new-root`, fixture `codex/transcripts/skill-stub-read/`; `new-root-late`, fixture `codex/transcripts/skill-roots/new-root-late/`). There is no `.agents/` folder when the thread starts; the hook creates it. In `new-root`, turn 2 reads the stub and the copy, then rewrites the stub's description in place, and turn 3 only answers. `new-root-late` does the same, then 11 s later turn 3 writes the `late-folder` pair, and 11 s after that turn 4 only answers.

**Results: root present.**

| Turn | `existing-root` (back to back; turn 5 after 11 s) | `existing-root-wait11000` (11 s before each turn) |
| -- | -- | -- |
| 1 | the session's initial listing: `grimoire-chores` only. The hook's note comes after it. | the same |
| 2 | **new listing**: `hook-skill`, and `tidewater-ledger` written in turn 1 | the same |
| 3 | none (the "(v2)" edit from turn 2 is not listed) | **new listing** with the "(v2)" description |
| 4 | none (the `late-folder` pair from turn 3 is not listed) | **new listing** with `late-folder` |
| 5 | **new listing** with "(v2)" and `late-folder` | none (nothing changed) |

**Results: root created mid-session.**

| Turn | `new-root` | `new-root-late` (11 s before turns 3 and 4) |
| -- | -- | -- |
| 1 | the session's initial listing; no stub | the same |
| 2 | **new listing**: both stubs, under a new root `r1` = `<repo>/.agents/skills` | the same |
| 3 | none; "(v2)" is never listed | none; "(v2)" is never listed |
| 4 | — | none; `late-folder` is never listed |

A new listing is a full `<skills_instructions>` developer message at the start of the turn, plus a `world_state` line `{full: false, state: {host_skills}}`.

**Why** (source of the 0.162.1 tag, `rust-v0.162.1`):

- **The listing comes from a cache.** `ext/skills/src/host_service.rs` `snapshot_for_config` keys its snapshot cache on the resolved skill roots. `ext/skills/src/host_roots.rs` `repo_agents_skill_roots` adds `<repo>/.agents/skills` only if it is a directory at that moment.
- **A root that appears is a new cache key.** That is why `new-root` lists both stubs in turn 2.
- **Only roots present at thread start are watched.** `app-server/src/skills_watcher.rs` `register_thread_config` registers the resolved roots once, when the thread starts (`thread_lifecycle.rs`). A watched change clears the cache (`clear_cache`). A root created later is never watched. After its first listing its cache key stays the same, so nothing under it is re-read in that session. This is what `new-root` and `new-root-late` show.
- **The watcher delays; it doesn't drop.** It is wrapped in `ThrottledWatchReceiver` with `WATCHER_THROTTLE_INTERVAL` = 10 s (`file-watcher/src/lib.rs`). The first event goes through at once. Later events gather in a set until 10 s after the previous delivery, then go through together. So in `existing-root` the turn-2 edit and the turn-3 folder reached the listing at turn 5, not turns 3 and 4.
- **The hook's stub misses turn 1.** The rollouts have the initial listing, then the hook's note (`GRIM-B2-HOOK-WROTE <time>`), then turn 1's prompt. Codex builds the initial listing *before* the SessionStart hook runs. So a hook-written skill can't make turn 1, even though it lands before the prompt.
- **Self-ignored stubs are listed.** Each stub folder is git-ignored by its own `.gitignore`, and Codex lists it anyway.

**Decision for dependent slices.**

- **GOK-157 (SessionStart fast path):** in Codex, skills the hook writes appear from turn 2, never turn 1 (there is no `reloadSkills` equivalent). The stub's `skill_read` line covers turn 1. Build exactly that; no Codex-specific output is needed. This holds whether or not `.agents/skills/` existed when the session started.
- **GOK-153 (generated output):** self-ignoring `.agents/skills/grimoire-<name>/` folders are discovered. A stub written or rewritten during a session reaches that session from the first turn after Codex's watcher delivers the change. That is the next turn when the session is paced like a human's, and up to 10 s later after a burst of writes. **The exception:** if `.agents/skills/` did not exist when the session started, only the stubs present when it first appears are listed. Anything written after that waits for the next session. `init` writes the Codex chore carrier `.agents/skills/grimoire-chores/SKILL.md` (spec §11), so in an installed repo the root exists from the next session on. The case only arises in a session that was already running when grimoire was installed. Keep it that way: the chore carrier, or some other folder, must stay under `.agents/skills/`. In every case the copy's text is read fresh on each use, so a stale listing only delays discovery.

## P2 (Codex half): stub matched by description, then the copy read

**Question.** Does Codex match a stub in a self-ignoring `.agents/skills/grimoire-<name>/` folder by its description, and then read the copy in `.grimoire/skills/`?

**Verdict: unverifiable: fallback applies.** Choosing a skill from its description is model judgement, and the stand-in only follows its plan. What the real Codex did show:

- **The stub is offered.** The listing entry is `- grimoire-tidewater-ledger: <description> (file: r1/grimoire-tidewater-ledger/SKILL.md)`, under Codex's skill rules: "If the user names a skill … OR the task clearly matches a skill's description shown above, you must use that skill for that turn", and "open and read its `SKILL.md` completely before taking task actions".
- **Codex has no skill tool.** A skill is used by reading its `SKILL.md` through the shell, so the "match" is a shell read of the stub.
- **The read signal is structured, in paginated rollouts only.** Each shell read is an `event_msg` `item_completed` `CommandExecution` whose `parsed_cmd` is `[{type: "read", cmd, name, path}]`. Turn 2 has `path: ".agents/skills/grimoire-tidewater-ledger/SKILL.md"` and then `path: ".grimoire/skills/tidewater-ledger/SKILL.md"`, each with the file's text in `aggregated_output`. The `path` is as the command wrote it (relative here). **Legacy-mode rollouts have no `item_completed` lines and no `parsed_cmd`.** Spike E's `codex/transcripts/legacy/` fixture shows a shell read of `.grimoire/skills/probe/SKILL.md` only as a `response_item` `function_call` `exec_command` with `arguments` `{"cmd": "Get-Content .grimoire/skills/probe/SKILL.md"}`. Spike E's GOK-137 note says the same: structured `CommandExecution` items exist only in paginated mode.

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
- **GOK-158 (skill facts in traces), Codex read signal:** count a `skill_read` MCP call for `<name>` in either mode.
  - **Paginated rollouts:** also count a `CommandExecution` with a `parsed_cmd` entry `{type: "read"}` whose path, normalized for separators, ends in `.grimoire/skills/<name>/SKILL.md`.
  - **Legacy rollouts** (for example a resumed older thread) have no `parsed_cmd`. Match the `exec_command` `function_call`'s `arguments.cmd` for that normalized path instead, or record the turn's skill facts as incomplete.
  - A read of the stub alone is not a read of the skill.

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
- **`apply_patch` does not go away.** The child's `apply_patch` succeeded ("Success. Updated the following files: A chore-wrote.txt"). The run shows only that it stays when the role doesn't ask for it to go. That no role key *can* remove it comes from the source below, not from a run. The child also kept `web_search`, `view_image`, `request_user_input`, the goal tools and the MCP resource tools. Source (`core/src/agent/role.rs`): a role layer applies only `developer_instructions`, model settings, `skills` narrowing, and **disabling** of exactly five features: `shell_tool`, `apps`, `plugins`, `memories` and `request_permissions_tool`. It can't change the sandbox, `web_search` or `apply_patch`. The child inherits the parent's sandbox: `danger-full-access` in this run, typically `workspace-write` in a session. So the chore thread can still edit workspace files.
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

**The fallback, tested** (`c4-fallback.mjs <scratch> <variant>`). The throwaway user `config.toml` declares five things: the stand-in as its `model_provider`, an MCP server `usermcp`, a SessionStart hook, a legacy `notify` program that records what it is handed, and `developer_instructions` carrying a marker. Every variant but `final` also passes `--dangerously-bypass-hook-trust`, standing in for a user who has trusted their own hook.

| Variant | Flags added to the exec | User MCP server started | User hook ran | `notify` ran | User `developer_instructions` in the prompt | Model request went to |
| -- | -- | -- | -- | -- | -- | -- |
| `on` | none | yes | yes | yes | yes | the user config's provider (the stand-in) |
| `off` | `-c mcp_servers.usermcp.enabled=false -c features.hooks=false` | no | no | **yes, handed the bundle** | **yes** | the stand-in |
| `off-notify` | `off`, plus `-c notify=[] -c developer_instructions=""` | no | no | no | no | the stand-in |
| `pin-provider` | `off-notify`, plus `-c model_provider="openai"` | no | no | no | no | `api.openai.com` (401, no login); nothing reached the stand-in |
| `projmcp` | `off-notify`, plus a disable for each name `mcp list` gave in the repo | — | — | — | — | nowhere: exit 1, "Error loading config.toml: invalid transport in `mcp_servers.grimoire`" |
| `final` | the runner invocation under P7, verbatim | no | no | no | no | the stand-in, through the test-only `openai_base_url`; exit 0 |

What the runs show:

- **`codex mcp list --json`** prints `[{name, enabled, disabled_reason, transport: {type, command, args, env, …}, …}]`. `-c mcp_servers.<name>.enabled=false` keeps that server from starting. `-c features.hooks=false` keeps the user hook from running, even a trusted one.
- **`notify` is not a hook feature.** `features.hooks=false` leaves the legacy `notify` program running after every turn.
  - Source: `core/src/session/mod.rs` builds `HooksConfig` with `legacy_notify_argv: config.notify` and, separately, `feature_enabled` from `features.hooks`. In `hooks/src/registry.rs` the after-agent hook comes from `legacy_notify_argv` alone, and an empty argv is filtered out.
  - The payload goes in as the last argv argument (`hooks/src/legacy_notify.rs`): `{type: "agent-turn-complete", thread-id, turn-id, cwd, client, input-messages, last-assistant-message}`. That is the served bundle and the answer. In `off`, the user's `notify` program received exactly that.
  - `-c notify=[]` stopped it.
- **The user config's `developer_instructions` reached the runner's prompt** until `-c developer_instructions=""` replaced them.
- **The user config picks the model provider.** Every variant before `pin-provider` reached the stand-in, which only the user `config.toml` declares. `-c model_provider="openai"` overrides that (`pin-provider`). A profile can't undo the pin:
  - 0.162.1 refuses a legacy `profile = "…"` selector outright ("legacy `profile = "p"` config is no longer supported; use `--profile p` with `p.config.toml` instead").
  - A profile-v2 file applies only with `--profile`, which the runner never passes.
- **The MCP names must come from a list run the way the exec runs.** `codex mcp list --json` lists what the config for its *cwd* holds, including a trusted repo's project layer and plugin servers. In `projmcp`, run in the repo it listed `grimoire` (from the repo's `.codex/config.toml`, the layout grimoire installs) and `usermcp`. Run in the runner's empty temp dir, it listed only `usermcp`. The trouble is `-c mcp_servers.grimoire.enabled=false` on an exec whose config has no `grimoire`. It creates a table with neither `command` nor `url`, and Codex refuses the whole config.
- **Auth mode is visible.** `codex login status` prints one of three lines: "Logged in using ChatGPT", "Logged in using an API key - sk-…" (partly masked; never log it) or "Not logged in". It reads the same `CODEX_HOME` and config as the exec, so it also sees a keyring login. The ChatGPT and API-key lines were checked with fake `auth.json` files.
- **Still taken from the user config:** `model`, reasoning effort, `service_tier`, `instructions`, `model_instructions_file`, `openai_base_url`, `chatgpt_base_url`, `otel` and the personal `AGENTS.md`. None of these starts a program or a server, and `-c` can't unset the file paths. They are accepted: they are the user's own settings for their own login.

**Decision for dependent slices.**

- **GOK-167 (runner):** build the fallback: drop `--ignore-user-config` and run the invocation written out under P7.
  - **MCP names.** Run `codex.exe <the invocation's -c flags> mcp list --json` just before each spawn. Use the same `codex.exe`, `CODEX_HOME` and environment as the exec, the run's temp dir as cwd, and every `-c` flag of the invocation except the per-server disables (the `-c` flags go before `mcp`, as `c4-fallback.mjs` ran it). Read `name` only, and never log the output: `transport.env` can hold secrets. Pass `-c mcp_servers.<name>.enabled=false` for each name. A list taken in the repo, or once at enable time, can name a server the exec doesn't define, and then every run fails. If the list fails, the run is refused, and `runner enable codex` refuses with an explanation.
  - **`-c features.hooks=false -c notify=[]`.** The spec wants no hooks. `notify` would otherwise get every bundle and answer.
  - **`-c developer_instructions="" -c skills.include_instructions=false`.**
  - **Billing guard.** §16 refuses `CODEX_API_KEY` and `OPENAI_API_KEY`. With the user config kept, the runner must also pin `-c model_provider="openai"`. At `runner enable codex` and before each run, it runs `codex login status` with the same `CODEX_HOME` and environment, and refuses unless the output says "Logged in using ChatGPT" or `allow_api_billing` is set. It never logs that output.
  - **What the fallback costs.** The runner now relies on one `-c` override per user-config key that could run a program, start a server or pick who bills: MCP servers, hooks, `notify` and the provider. A later Codex release that adds such a key gets through until the runner adds its flag. `runner enable codex` should say which Codex version this list was verified against (0.162.1).
  - Keeping the user config also keeps keyring-stored logins working, which was the point.

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
| `success` (no `prefer_mxc`) | 0 | refused: "blocked by policy" | refused: "blocked by policy" | `thread.started`, `turn.started`, `item.completed` (`agent_message` = the schema JSON), `turn.completed`; `-o` holds the same text. The refusals are in what Codex sent the model next (`success.tool-io.jsonl`), not in the stream. |
| `mxc` (`-c features.prefer_mxc=true`) | 0 | ran (exit 0) | ran and failed: "Access to the path … is denied" | adds an `error` item ("Under-development features enabled: prefer_mxc…") and `command_execution` items |
| `notools` (`-c features.shell_tool=false -c web_search="disabled" -c skills.include_instructions=false`) | 0 | `unsupported call: exec_command` | the same | the same four events |
| `http400` (the model API answers 400) | 1 | — | — | `error`, then `turn.failed`, each with the API's error body |
| `nologin` (no stand-in, no login) | 1 | — | — | four WebSocket `error` events (`Reconnecting... 2/5` to `5/5`), an `error` item ("Falling back from WebSockets to HTTPS transport"), five HTTPS `error` events (`1/5` to `5/5`), a final `error` event, then `turn.failed` "unexpected status 401 Unauthorized …"; about 17 s |

**Notes.**

- **Shell is refused without a sandbox.** `--ignore-user-config` drops any `[windows] sandbox` setting. With none configured and approvals at `never`, Codex refuses every command, reads included, before running it. 0.162.1 emits no `command_execution` item for such a refused call (its CHANGELOG lists that as fixed after this release). The model sees `exec_command failed: CreateProcess { message: "Rejected(\"…\") rejected: blocked by policy" }`. **Under the C4 fallback this no longer holds.** The user config is kept, so a user's `[windows] sandbox` setting applies and read-only commands could run. That is why the final invocation turns the shell tool off.
- **The answer schema must be strict.** `--output-schema` reaches the model as `text.format = {type: "json_schema", strict: true, name: "codex_output_schema", schema}`. The schema must therefore be OpenAI-strict: every property required, `additionalProperties: false`.
- **The tool list stays long.** Even read-only, the runner's tool list holds `exec_command`, `write_stdin`, `apply_patch`, `web_search`, `view_image`, `request_user_input`, the goal tools and `tool_search`. `-c features.shell_tool=false` and `-c web_search="disabled"` remove the shell and web search.
- **The npm shim adds nothing the runner needs.** It (`bin/codex.js`) only sets package-manager variables before spawning the native binary. The binary sits at `<npm prefix>/node_modules/@openai/codex/node_modules/@openai/codex-win32-<arch>/vendor/<triple>/bin/codex.exe`.

**Decision for dependent slices.**

**The final runner invocation** (the §16 flags with the C4 fallback changes, plus no shell and no web search):

```
<codex.exe> exec --json --ephemeral --ignore-rules --skip-git-repo-check
  --cd <fresh empty temp dir> --sandbox read-only
  --output-schema <schema.json> -o <out>
  -c features.apps=false -c features.plugins=false
  -c features.hooks=false -c notify=[] -c developer_instructions=""
  -c features.shell_tool=false -c web_search="disabled"
  -c skills.include_instructions=false
  -c model_provider="openai"
  -c mcp_servers.<name>.enabled=false        (once per name the C4 list gives)
```

The bundle goes on stdin, with no prompt argument. Each `-c` value is one argv element, a TOML value: `notify=[]`, `developer_instructions=""`, `web_search="disabled"`, `model_provider="openai"`. Pass the argv to `spawn` directly, never as a shell string.

`c4-fallback.mjs <scratch> final` ran exactly that, with one test-only addition: `-c openai_base_url="http://127.0.0.1:<port>/v1"`, so the pinned `openai` provider reached the stand-in. The user config held an MCP server, a SessionStart hook, `notify`, `developer_instructions` and `[windows] sandbox = "unelevated"`. The hook was not trusted in this run, which has no bypass flag; the C4 `off` run showed that `features.hooks=false` stops a trusted one. Results (fixtures `fallback-final.jsonl` and `fallback-final.tool-io.jsonl`):

- Exit 0. `-o` held the schema JSON.
- No user MCP server, hook or `notify` ran, and the user's `developer_instructions` were not in the prompt.
- The model's tools were `request_user_input`, `apply_patch`, `view_image`, the goal tools and `tool_search`. Its `exec_command` call and its call to the user's MCP tool both got "unsupported call".
- The stream was `thread.started`, `turn.started`, four `error` events (`Reconnecting... 2/5` to `5/5`), an `error` item ("Falling back from WebSockets to HTTPS transport"), the `agent_message`, then `turn.completed`. The built-in `openai` provider tries WebSockets first, and the stand-in has no WebSocket endpoint. **So `error` events and error items in the stream don't mean the run failed.**

**Decision for dependent slices.**

- **GOK-167:** run the final invocation above. No `prefer_mxc`: it is an under-development feature, and it adds a warning item. Failure means any of three things: a non-zero exit, a `turn.failed` event, or a missing or invalid `-o` file. `error` events and `error` items alone are not failure (see `fallback-final.jsonl`). These fixtures are the parser's test data. Resolve and store the `codex.exe` path at enable time, never the `.cmd` shim.

## R4 (Codex half): a detached child after the shell command returns

**Question.** Does a detached `sync --background` child survive Codex's job object after the shell command returns?

**Run** (`r4-detached.mjs`). The scripted model ran `node bg-parent.cjs <marks>` through `exec_command`. The parent spawned `bg-child.cjs` the way `sync --background` will (`detached: true, stdio: 'ignore', windowsHide: true`, then `unref()`) and exited. The child tried a write under `.git/grimoire/`, wrote `started.json`, slept 8 s, then wrote `finished.json`. The script checked 15 s after `codex exec` exited.

| Mode | Child ran | Child survived to the end | Shell call returned | `codex exec` exit | Write under `.git/grimoire/` |
| -- | -- | -- | -- | -- | -- |
| `-s danger-full-access` (no sandbox) | yes | **yes** | at once (0.06 s) | **waited** for the child (8.7 s) | ok |
| `-s workspace-write`, no Windows sandbox configured | no: the command was refused ("blocked by policy") | — | at once | 4 s | — |
| `-s workspace-write -c windows.sandbox="unelevated"` | yes | **yes** | **only when the child exited** (8.05 s wall time) | 18.5 s (first-run sandbox setup included) | **EPERM** |
| `-s workspace-write -c features.prefer_mxc=true` (MXC) | **unknown** when the parent exits at once: the command exited 0 and printed the child's pid, but none of its writes persisted, not even the parent's own `parent.json` (no `r4-marks/` folder at all). With the parent lingering 3 s, `parent.json` and `started.json` persisted: the child started. | **no: killed** when the shell command ended (lingering run) | at once | 1 to 5 s | **EPERM** |

**Verdict: fallback taken.** The child survives only unsandboxed. Under the unelevated sandbox it survives but holds the agent's shell call open. Under MXC it is killed with the command.

**Decision for dependent slices.**

- **The background sync owner (spec §4 write path; GOK-139 per Spike E):** keep the sync-pending marker, retried by the next upkeep, as the spec requires. On Codex it is the only reliable path. Keep `sync --background` short, since it can hold the shell call open (unelevated) or the `codex exec` exit (unsandboxed).
- **Side finding, for every CLI write from a Codex shell:** under both Windows sandboxes in `workspace-write`, writes under `.git/` fail with EPERM: Codex protects `.git` as read-only. A sandboxed Codex agent running `grimoire` CLI writes will fail to write `<git-common-dir>/grimoire/` (and git refs). Prefer the MCP tools (the `grimoire mcp` process runs unsandboxed) in Codex instructions, and make CLI write failures under a Codex sandbox explain that. Under MXC it is worse: a short-lived command's writes did not persist at all, even outside `.git/`. The same writes from a command that ran 3 s did persist. MXC is an under-development opt-in (`prefer_mxc`), but a CLI write from a Codex shell under it can't be trusted even when it reports success. Spike E's P3 covers the hook process. This covers the agent's shell. (Posted on GOK-139, GOK-141 and GOK-142.)

## Fixtures added (seam 2)

All were captured from the real Codex 0.162.1 and sanitized by `sanitize.mjs` (user name to `USER`, time zone to `Etc/UTC`, the package name `@goksening/grimoire` kept). Each folder has a README with provenance. Encoded in `test/spikes/codex-skills-role-exec.test.ts`.

- `codex/exec-json/runner/`: `success.jsonl`, `no-shell-tool.jsonl`, `model-api-error.jsonl` and `fallback-final.jsonl` (scripted model), and `not-logged-in.jsonl` (no stand-in at all). The `*.tool-io.jsonl` files are the tool calls and outputs Codex sent the stand-in in a run's last request (`sanitize.mjs --tool-io`). They hold the refusals the streams don't show.
- `codex/transcripts/skill-stub-read/`: the B2 `new-root` and P2 rollout. The listings per turn, then the stub read followed by the copy read with `parsed_cmd` read actions (scripted model).
- `codex/transcripts/skill-roots/`: the B2 `existing-root`, `existing-root-wait11000` and `new-root-late` rollouts (scripted model).
- `codex/transcripts/chore-role/`: the P5 root and child rollouts (scripted model).
- `codex/mcp/chore-role/c2s.jsonl`: the child thread's MCP messages, with the `tools/call` `_meta`.
