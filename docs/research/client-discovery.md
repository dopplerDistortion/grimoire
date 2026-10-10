# Client discovery: where do Claude Code and Codex look for MCP servers, skills, and instructions?

*Researched on 2026-10-11 for GOK-111. Fact-checked on 2026-10-11; see "Verification notes" at the end.*

**Claude Code** was checked against the docs at code.claude.com. The latest release is v2.1.296 (2026-10-09), and v2.1.296 is the version installed on the developer machine (`claude --version` → `2.1.296 (Claude Code)`) ([changelog](https://code.claude.com/docs/en/changelog)).

**Codex** was checked against its docs (learn.chatgpt.com, developers.openai.com) and the `openai/codex` `main` branch, last pushed 2026-10-10 (HEAD `de8fab6`). The latest stable release is `rust-v0.162.1` (2026-10-09). A newer pre-release, `rust-v0.163.0-alpha.5`, came out on 2026-10-10 ([releases](https://github.com/openai/codex/releases)).

Labels used below:
- **Inference**: my own reasoning, not something a source states.
- **Unverified**: I couldn't confirm it.
- **Local observation**: something I checked on this Windows 11 machine.
- **Source reading**: what the Codex source on `main` does, where the docs say nothing.

## Question

At project scope, which files and settings do Claude Code and Codex read to discover:
- (a) MCP servers,
- (b) skills,
- (c) project instructions?

The goal is for `grimoire init` to write the smallest possible set of pointer files outside `.grimoire/`.

The document also covers:
- whether MCP prompts and resources could deliver skills and the wiki with no files at all;
- which lifecycle hooks are available for capturing traces;
- Windows behaviour, trust prompts, and environment and working-directory handling.

---

## 1. Claude Code

### 1.1 MCP servers

**Where servers are configured**
- Project-scoped servers live in `.mcp.json` at the project root, and you commit it to the repo ([mcp](https://code.claude.com/docs/en/mcp)).
- The file sits at the root, not inside `.claude/`.
- There are two other scopes, both stored in `~/.claude.json` ([mcp](https://code.claude.com/docs/en/mcp)):
  - **local** (the default): applies to one project and is private to you;
  - **user**: applies to all your projects.
- If the same server is defined in several places, the whole entry from the highest-priority source wins. Fields are not merged. The order is local, then project, then user, then plugin, then claude.ai connectors. The three scopes match duplicates by name; plugins and connectors match by endpoint ([mcp](https://code.claude.com/docs/en/mcp)).

**Schema**

The file looks like `{"mcpServers": {"<name>": {…}}}`.
- **stdio servers:** `command`, `args`, `env`. An entry with no `type` is treated as stdio.
- **HTTP servers:** `"type": "http"` (or its alias `streamable-http`), plus `url` and `headers` (and `headersHelper`). An entry with a `url` but no `type` is a configuration error: Claude Code skips the server.
- **Older and other transports:** `sse` is deprecated, and `ws` also exists.
- **Timeouts and loading:**
  - a per-server `timeout` in milliseconds overrides `MCP_TOOL_TIMEOUT` for that server. Values below 1000 are ignored;
  - `alwaysLoad: true` loads the server's tools up front and makes startup wait for them (capped at 5 s). `alwaysLoad: false` (v2.1.287+) keeps all of them deferred;
  - the `MCP_TIMEOUT` environment variable sets the startup timeout.

All of the above is from [mcp](https://code.claude.com/docs/en/mcp).

**Environment variables and working directory**
- `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url` and `headers`. An unset variable with no default loads anyway: `claude mcp list` shows a warning, and the literal `${VAR}` text is used ([mcp](https://code.claude.com/docs/en/mcp)).
- Claude Code sets `CLAUDE_PROJECT_DIR` (the project root) in the spawned server's environment ([mcp](https://code.claude.com/docs/en/mcp)).
  - That variable lives only in the server's environment. To use it inside `.mcp.json` itself, you need the default form, `${CLAUDE_PROJECT_DIR:-.}`. Plugin MCP configs substitute it directly.
- Claude Code answers the MCP `roots/list` request with the launch directory plus any added directories, and sends `notifications/roots/list_changed` when that set changes. This needs v2.1.203 or later ([mcp](https://code.claude.com/docs/en/mcp)).
- The docs give no rule for which working directory a stdio server starts in ([mcp](https://code.claude.com/docs/en/mcp)).

**Inference:** grimoire's MCP server should find the repo through `CLAUDE_PROJECT_DIR`, then MCP roots, then by walking up from its working directory.

**Approval and trust**
- In interactive sessions, Claude Code "prompts for approval … before using project-scoped servers from `.mcp.json` files". You can reset those answers with `claude mcp reset-project-choices` ([mcp](https://code.claude.com/docs/en/mcp)).
- `claude -p`, Agent SDK sessions and cloud sessions load project servers without asking. The SDK loads `.mcp.json` only when `settingSources` includes project settings ([mcp](https://code.claude.com/docs/en/mcp), [permissions](https://code.claude.com/docs/en/permissions)).
- A cloned repo can't approve its own servers. `enableAllProjectMcpServers` and `enabledMcpjsonServers` in a committed `.claude/settings.json` are ignored until the user accepts the workspace trust dialog. In an untrusted folder they are honored only from user settings, managed settings and `--settings`.
- A `disabledMcpjsonServers` entry always rejects the server.
- When the user approves (or rejects) in the dialog, Claude Code writes the answer to `.claude/settings.local.json`.
- You can also trust a folder without the dialog by setting `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json`.

Sources for the last four points: [mcp](https://code.claude.com/docs/en/mcp), [settings reference](https://code.claude.com/docs/en/settings-reference), [permissions](https://code.claude.com/docs/en/permissions).

**Windows and `npx`**
- The current MCP docs say nothing about Windows or the `cmd /c` wrapper. Their examples use a plain `"command": "npx"` ([mcp](https://code.claude.com/docs/en/mcp)).
- The changelog for v2.1.119 (2026-04-23) says: "Windows: removed false-positive 'Windows requires 'cmd /c' wrapper' MCP config warning" ([changelog](https://code.claude.com/docs/en/changelog)).
- The warning had been a long-running complaint ([anthropics/claude-code#9594](https://github.com/anthropics/claude-code/issues/9594); I did not re-check the issue thread).
- **Inference, unverified at runtime:** a plain `"command": "npx"` should start on native Windows in current versions.
- A committed `cmd /c` wrapper would break macOS and Linux teammates.
- For comparison, the hooks docs say that in exec form the `.cmd`/`.bat` shims in `node_modules/.bin` "are not executables" and can't be spawned without a shell ([hooks](https://code.claude.com/docs/en/hooks)).

**Server instructions**
- With tool search on (the default), only tool names and each server's instructions load at session start ([mcp](https://code.claude.com/docs/en/mcp)).
- **Corrected:** v2.1.296 "Changed the default limit on MCP tool descriptions sent up front and on MCP server instructions from 2,048 to 4,096 characters" ([changelog](https://code.claude.com/docs/en/changelog)). The MCP docs page still says 2,048, so the docs are behind.
- `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (v2.1.280+) changes the limit ([mcp](https://code.claude.com/docs/en/mcp)).
- **Inference:** keep the critical guidance in the first 2,048 characters for older clients, and in the first 512 for Codex.

### 1.2 Skills

**Discovery locations** ([skills](https://code.claude.com/docs/en/skills)):

| Location | Path |
|---|---|
| Enterprise | `.claude/skills/<name>/SKILL.md` in the managed settings directory |
| Personal | `~/.claude/skills/<name>/SKILL.md` |
| Project | `.claude/skills/<name>/SKILL.md` |
| Nested | `<subdir>/.claude/skills/…`, loaded once Claude reads or edits a file in `<subdir>` |
| Added directory | `.claude/skills/` inside a directory passed with `--add-dir` |
| Plugin | `<plugin>/skills/<name>/SKILL.md`, invoked as `/plugin:skill` |
| claude.ai account | synced skills |

How these are searched ([skills](https://code.claude.com/docs/en/skills)):
- Project skills are read from the start directory and every parent directory up to the repo root. In a linked worktree the search stops at the worktree root. From v2.1.277, a worktree with no `.claude/skills` falls back to the main checkout's skills.
- The `permissions.additionalDirectories` setting "grants file access only and loads none of these".

**`.agents/skills` is not supported by Claude Code.**
- The skills location table lists only `.claude/skills`, and neither the skills docs nor the changelog mention `.agents/skills` ([skills](https://code.claude.com/docs/en/skills)).
- The memory docs say Claude doesn't read "anything under a `.agents/` directory" when it reads `AGENTS.md` ([memory](https://code.claude.com/docs/en/memory)).

**Format** ([skills](https://code.claude.com/docs/en/skills))
- Skills follow the [Agent Skills](https://agentskills.io/specification) standard, with Claude Code extensions.
- Claude Code frontmatter fields:
  - `name`, which defaults to the directory name;
  - `description` and `when_to_use`, which together are cut off at 1,536 characters in the listing;
  - `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`;
  - `allowed-tools`, `disallowed-tools`, `model`, `effort`;
  - `context`, `agent`, `background`, `hooks`, `paths`, `shell`;
  - `metadata`, `license`, `compatibility`.
- Unknown fields are ignored without an error.
- The list of skills shown to the model gets a budget of 1% of the context window.
- **Corrected scope:** the "only six spec fields" rule (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) applies to claude.ai uploads, the Skills API and `package_skill.py`, where any other field is a hard error. It is not a general rule for every other client; Codex's handling of extra fields isn't documented.
  - The spec requires `name` to be 1–64 characters (lowercase letters, digits and hyphens) and to match the parent directory name. `description` must be at most 1,024 characters ([Agent Skills spec](https://agentskills.io/specification)).

**Symlinks**
- A `<skill-name>` entry in the enterprise, personal or project location "can be a symlink to a directory elsewhere on disk", and the skill is loaded only once ([skills](https://code.claude.com/docs/en/skills)).
- **Local observation (re-checked):** in this repo, `.claude/skills/<name>` are NTFS junctions (`LinkType = Junction`) pointing at `.agents/skills/<name>`.
  - Claude Code 2.1.296 loads them.
  - But git (with `core.symlinks=false`) committed the junction contents as duplicate regular files. `git ls-files -s` shows `100644 … .claude/skills/ask-matt/SKILL.md`.
- The docs separately warn that on Windows, creating symlinks needs admin rights or Developer Mode, and that Git checks committed symlinks out as plain text files unless `core.symlinks` is set ([memory](https://code.claude.com/docs/en/memory)).

**Live reload** ([skills](https://code.claude.com/docs/en/skills))
- Claude Code picks up changes to `SKILL.md` text in watched skill directories during the session.
- A newly created top-level skills directory needs `/reload-skills`.
- Commands have been merged into skills: `.claude/commands/x.md` still works.

**Indirection in the skill body** (corrected)
- **`@` file references:** the docs don't describe them directly, but they do say that local skill bodies expand them.
  - The skills page says that for synced skills Claude Code "doesn't attach the files that `@` references name the way it does for a local skill".
  - The v2.1.228 changelog says synced skill bodies "don't … expand `@` files".
  - **Unverified:** how the path is resolved (against the project or the skill directory) and whether `${CLAUDE_PROJECT_DIR}` works inside the reference. If it works, a stub whose body is `@.grimoire/skills/<name>/SKILL.md` needs no shell at all. Spike needed.
- **`` !`command` ``:** runs a shell command before the skill content is sent to the model, and inserts its output ([skills](https://code.claude.com/docs/en/skills)).
  - So a stub skill could inline `.grimoire/skills/<name>/SKILL.md` through a shell command.
  - **Missing fact:** injected commands never prompt. Each one is checked against the permission rules, and outside auto mode anything other than "allow" aborts the whole skill invocation. The stub therefore has to pre-approve its own command in `allowed-tools`, for example `Bash(cat ${CLAUDE_PROJECT_DIR}/.grimoire/skills/x/SKILL.md)`. `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SKILL_DIR}` are substituted in both the body and Bash rules in `allowed-tools`. Workspace trust never gates `allowed-tools`.
  - A non-zero exit also aborts the invocation.
  - The shell is `bash` by default; set `shell: powershell` otherwise. **Inference:** on Windows, `cat` therefore depends on Git Bash, which makes the `!` route brittle there.
  - `disableSkillShellExecution` turns this off ([settings reference](https://code.claude.com/docs/en/settings-reference)).

**Can a skill folder live inside `.grimoire/`?** Not as a plain project skill. The options are:
- (a) a symlink or junction from `.claude/skills/<name>`;
- (b) `.grimoire/.claude/skills/`, which only loads after Claude touches a file under `.grimoire/` ([skills](https://code.claude.com/docs/en/skills));
- (c) `--add-dir .grimoire` on every launch. This loads `.grimoire/.claude/skills/`, not `.grimoire/skills/`;
- (d) a plugin (see 1.6);
- (e) a stub in `.claude/skills/<name>/SKILL.md` that pulls in the real body through an `@` reference (spike) or a pre-approved `!` command.

### 1.3 Instructions

**Files and load order** ([memory](https://code.claude.com/docs/en/memory))
- Project instructions are `./CLAUDE.md` or `./.claude/CLAUDE.md`, plus `./CLAUDE.local.md`.
- Files in the start directory and every directory above it load at launch.
- Files in subdirectories load on demand.
- All of them are concatenated rather than overriding each other.

**Imports** ([memory](https://code.claude.com/docs/en/memory))
- Syntax is `@path/to/file`. The path is relative to the file that contains the import; absolute paths also work. Escape spaces with a backslash.
- Imports can nest up to four hops deep.
- Imports inside code spans and fenced code blocks are skipped.
- Imported files load at launch.
- An import that resolves outside the working directory is "external": the first time, Claude Code shows an approval dialog.
- **Inference:** an import into `.grimoire/` stays inside the working directory, so no dialog appears.

**`.claude/rules/*.md`** ([memory](https://code.claude.com/docs/en/memory))
- Discovered recursively.
- Rules without `paths:` frontmatter load at launch, with the same priority as `.claude/CLAUDE.md`.
- They do **not** count when Claude decides whether to read `AGENTS.md` (see below).
- Symlinked rules that point outside the working directory need the external-import approval.
- **Unverified:** that `@` imports work inside project rule files. The docs only imply it: imports in `~/.claude/rules/` load without the dialog, and "each CLAUDE.md, rules file, and `@path` import counts as a separate file".

**`AGENTS.md` support** (v2.1.277 and later, 2026-09-18) ([memory](https://code.claude.com/docs/en/memory))
- Claude reads `AGENTS.md` only when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the working directory or above it.
- **Added:** in that mode it reads every `AGENTS.md` **and `.claude/AGENTS.md`** in the working directory and above at session start. It also reads a subdirectory's `AGENTS.md` on demand, when Claude opens a file in that subdirectory.
- `@path` imports inside `AGENTS.md` are expanded. An external import there loads only if external imports were already approved.
- `AGENTS.override.md`, `AGENTS.local.md` and anything under `.agents/` are not read.
- The setting that reads both files is "Project instructions" = `claude-md-and-agents-md`. You can set it in `/config`, or in settings under `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`. That settings entry is read only from `~/.claude/settings.json`, `--settings` or managed settings, and is ignored in project and local settings files.

**Consequence:** if `grimoire init` creates any `CLAUDE.md` (or `CLAUDE.local.md`) in a repo that only has `AGENTS.md`, Claude silently stops reading `AGENTS.md`.

**Inference:** don't name grimoire's instruction file `.grimoire/AGENTS.md`. Both Claude Code (when it reads `AGENTS.md`) and Codex (when launched inside `.grimoire/`) treat a subdirectory `AGENTS.md` as an instruction file in its own right. A neutral name such as `.grimoire/instructions.md` avoids that.

**Size** ([memory](https://code.claude.com/docs/en/memory))
- A `CLAUDE.md` up to 4 MiB is loaded in full; a larger one is skipped.
- The recommended length is under 200 lines.

### 1.4 MCP prompts and resources

**Prompts** ([mcp](https://code.claude.com/docs/en/mcp))
- Prompts show up as `/servername:promptname (MCP)` commands, and `/mcp__server__prompt` also works.
- Arguments are split on whitespace.
- The result is injected into the conversation.
- Prompts from a server named `anthropic-skills` are hidden, because that name is reserved.
- When a server signals a change (`list_changed`), interactive sessions refresh tools, prompts and resources. I did not re-check this point.

**Resources** ([mcp](https://code.claude.com/docs/en/mcp))
- Resources are referenced as `@server:protocol://path` and are "automatically fetched and included as attachments".
- Claude Code "automatically provides tools to list and read MCP resources when servers support them".

**Who triggers prompts**
- The MCP spec says prompts are "designed to be **user-controlled**" ([MCP spec, prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)).
- **Inference:** prompts can carry skill bodies, but Claude won't select them automatically the way it matches skills by description.

### 1.5 Hooks

**Where hooks are configured** ([hooks](https://code.claude.com/docs/en/hooks))
- `~/.claude/settings.json`;
- `.claude/settings.json`, which is committed;
- `.claude/settings.local.json`;
- managed settings;
- a plugin's `hooks/hooks.json`;
- skill or subagent frontmatter.

Entries from all of these are merged.

**Events, inputs and handler types** ([hooks](https://code.claude.com/docs/en/hooks))
- Events include: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`, `InstructionsLoaded` and `FileChanged`.
- **Corrected:** the common inputs are `session_id`, `transcript_path` (a JSONL file, written asynchronously and possibly behind), `cwd` and `hook_event_name`. `permission_mode` is **not** sent to every event; for example, the `SessionEnd` payload doesn't have it. `prompt_id`, `scratchpad_dir` and `effort` appear on some events.
- `Stop` and `SubagentStop` provide `last_assistant_message`.
- Handler types are `command`, `http`, `mcp_tool`, `prompt` and `agent`.
- **`mcp_tool` hooks:**
  - They call a connected server's tool, with `${tool_input.x}` substitution in the arguments.
  - They are skipped for the launch-time `SessionStart` (and `Setup`), because MCP servers aren't connected yet. They do run when `SessionStart` fires again after `/clear` or compaction.

**`SessionEnd` timing** ([hooks](https://code.claude.com/docs/en/hooks))
- The default budget is 1.5 seconds.
- A per-hook `timeout` raises it, up to 60 seconds. `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` sets it explicitly.
- Timeouts on plugin-provided hooks don't raise the budget.

**Windows** ([hooks](https://code.claude.com/docs/en/hooks))
- Shell form runs in Git Bash on Windows, or in PowerShell when Git Bash isn't installed.
- Exec form (with `args`) needs a real executable such as `node.exe`; `.cmd` shims like `npx.cmd` won't spawn.
- `${CLAUDE_PROJECT_DIR}` is available in hook commands.

**Trust** ([hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions))
- In interactive sessions, hooks from every settings file are held back until the workspace is trusted.
- In `-p` and SDK runs they run without the trust dialog.
- Hooks in project-skill frontmatter are registered on invocation, even in an untrusted `-p` run.

### 1.6 Plugins: one committed file pointing into `.grimoire/`

**Local directory marketplace**
- `.claude/settings.json` can register a marketplace with `extraKnownMarketplaces` and `{"source":"directory","path":…}`, and turn on its plugins with `enabledPlugins`.
- A relative `directory` path "resolves against your repository's main checkout" ([plugins/org](https://code.claude.com/docs/en/plugins/org)).
- Plugins with a relative path in a marketplace added from a local path "load in place". Edits take effect at the next session or after `/reload-plugins`, and no install step is needed ([plugins/loading](https://code.claude.com/docs/en/plugins/loading)).
- Repo marketplaces are only honored after workspace trust, even in `-p` runs, and are ignored in cloud sessions ([settings reference](https://code.claude.com/docs/en/settings-reference), [plugins/loading](https://code.claude.com/docs/en/plugins/loading), [permissions](https://code.claude.com/docs/en/permissions)).

**Constraints**
- A plugin's components can't resolve to paths outside the plugin root ([plugins/loading](https://code.claude.com/docs/en/plugins/loading)).
- A plugin `source` must start with `./`, or be `"."` for the marketplace root itself. From v2.1.239, a bare name also works under `metadata.pluginRoot`. `..` fails validation ([marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)).

**Unverified:** a plugin rooted at `.grimoire/`. That would mean `.grimoire/.claude-plugin/marketplace.json` and `plugin.json`, with `skills/`, `hooks/hooks.json` and `.mcp.json` inside `.grimoire/`. Two related unknowns: whether the plugin's MCP servers then need a per-server approval, and how a repo plugin's skills get namespaced.

**Skills-directory plugins**
- A skills-directory plugin is `.claude/skills/<n>/.claude-plugin/plugin.json`.
- It loads only from the primary working directory (parent directories are not searched), and only after trust. Trusting a parent folder or running `-p` isn't enough.
- MCP servers it declares need the same per-server approval as `.mcp.json`.

Source: [plugins/loading](https://code.claude.com/docs/en/plugins/loading), [permissions](https://code.claude.com/docs/en/permissions).

---

## 2. Codex

### 2.1 MCP servers

**Where servers are configured**
- Servers go under `[mcp_servers.<name>]` in `~/.codex/config.toml`, or in a project `.codex/config.toml` ("trusted projects only") ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)).
- Codex walks from the project root (the directory containing `.git` by default; see `project_root_markers`) down to the current directory and loads every `.codex/config.toml`; the closest file wins.
- Relative paths in project config resolve from that `.codex/` folder. The docs' example is `model_instructions_file`. **Unverified:** whether this also applies to `mcp_servers.<x>.cwd`.
- An untrusted project skips the project config, hooks and rules.

Source: [config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced), [config basics](https://learn.chatgpt.com/docs/config-file/config-basic).

**Trust**
- Trust is recorded as `projects.<path>.trust_level` (`"trusted"` or `"untrusted"`) in user config ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
- Codex "may also start in `read-only` until you explicitly trust the working directory" ([approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)).
- The docs describe no separate approval step for each server. Tool calls are gated by `default_tools_approval_mode` and by tool annotations.

**Schema** ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp))
- **stdio servers:** `command`, `args`, `env`, `env_vars` (an allowlist of variables to forward), `cwd`, `experimental_environment`.
- **HTTP servers:** `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`, `auth`.
- **Common options:**
  - `startup_timeout_sec` (default 10) and `tool_timeout_sec` (default 60);
  - `enabled` and `required`;
  - `enabled_tools` and `disabled_tools`;
  - `default_tools_approval_mode` (`auto`, `prompt`, `writes` or `approve`) and per-tool `tools.<tool>.approval_mode`.
- `mcp_optional_startup_grace_ms` (default 1000) controls how long Codex waits for optional servers when it builds the first list of tools.

**Keys a project config can't set** ([config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced)): `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url` and `otel`.

**Environment variables and working directory**
- `${VAR}` interpolation isn't documented, and the source has none for `mcp_servers`. Only plugin configs use `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` (source reading).
- In source, the server's environment is limited to a fixed default list plus `env_vars` and `env` ([rmcp-client/utils.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/utils.rs)).
- On Windows that default list includes `PATH`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP` and `TMP` ([shell_environment.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/shell_environment.rs)).
- When `cwd` is omitted, a local stdio server starts in the Codex process's local working directory, which is in practice the session directory ([stdio_server_launcher.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/stdio_server_launcher.rs), `codex-mcp/src/server.rs`).
- **Resolved (source reading):** Codex does not advertise `roots`. Its MCP `initialize` request declares only the `elicitation` capability (plus extensions), with protocol version `2025-06-18` (`codex-mcp/src/rmcp_client.rs`, `mcp_initialize_request_params`). grimoire's server must not depend on `roots/list` under Codex.

**Windows**
- Codex resolves the server command with `which` plus `PATHEXT`, "so tools like `npx` … work correctly on Windows" without `cmd /c`. It also makes sure `.CMD` is in `PATHEXT` ([program_resolver.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/program_resolver.rs)).
- The docs' own example is `codex mcp add context7 -- npx -y @upstash/context7-mcp`.

**Sandbox (source reading):** local stdio MCP servers are spawned directly with `Command::new`, in a new process group or Windows job object, with no sandbox wrapper. They are not confined by the `workspace-write` sandbox ([stdio_server_launcher.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/stdio_server_launcher.rs)).

**Server instructions**
- Codex reads the MCP `instructions` field as guidance for the whole server.
- The docs advise keeping the first 512 characters self-contained ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)).

### 2.2 Skills

**Locations** ([build skills](https://learn.chatgpt.com/docs/build-skills))
- `.agents/skills` in every directory from the current directory up to the repo root;
- `$HOME/.agents/skills`;
- `/etc/codex/skills`;
- skills bundled with Codex.

**Also found in source:**
- the project config folder's `skills/` folder, i.e. `<repo>/.codex/skills/`, which is undocumented;
- the deprecated `$CODEX_HOME/skills`.

Source: [host_roots.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs).

**Symlinks**
- "Codex supports symlinked skill folders and follows the symlink target when scanning these locations" ([build skills](https://learn.chatgpt.com/docs/build-skills)).
- In source, directory symlinks are followed for repo, user and admin skills, but not for system skills. Hidden directories *below* a skills root are skipped ([loader/host.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/host.rs), [discovery.rs](https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/discovery.rs)).

**Format** ([build skills](https://learn.chatgpt.com/docs/build-skills))
- `SKILL.md` must contain `name` and `description`.
- An optional `agents/openai.yaml` can set `policy.allow_implicit_invocation` (default `true`) and declare MCP tool dependencies.
- "Codex detects skill changes automatically. If an update doesn't appear, restart Codex."
- The initial skill list includes each skill's file path and gets 2% of the context window, or 8,000 characters when the window is unknown.
- Two skills with the same `name` are not merged; both can appear.

**`[[skills.config]]`**
- These entries only turn skills on or off, selected by `name` or absolute `path`. They can't add a new skill location ([build skills](https://learn.chatgpt.com/docs/build-skills), [skills_config.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/skills_config.rs)).

**Sandbox**
- In the default `workspace-write` sandbox, `.agents/` and `.codex/` (when they exist as directories) and `.git` are read-only, recursively ([approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)).
- So an agent inside Codex can't rewrite pointer files without approval. `.grimoire/` is **not** protected, so agents can write grimoire state.
- MCP servers are not sandboxed (see 2.1, source reading).

### 2.3 Instructions

**Discovery** ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md))
- Codex reads a global `~/.codex/AGENTS.override.md` or `AGENTS.md` (from `CODEX_HOME`).
- Then, from the project root down to the current directory, it takes one file per directory: `AGENTS.override.md`, otherwise `AGENTS.md`, otherwise any `project_doc_fallback_filenames`.
- Files are concatenated root first. Empty files are skipped, and reading stops once the total reaches `project_doc_max_bytes` (32 KiB by default).
- The chain is built once per run or session.

**No imports or path tricks**
- There is no import syntax: the loader just concatenates file contents.
- Fallback names "containing path syntax … are ignored": entries containing `/` or NUL, and on Windows `\` or `:`. So `.grimoire/AGENTS.md` can't be named as a fallback.

Source: [agents_md.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs).

**Other config keys** ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference))
- `developer_instructions` is a string injected into the session. It can be set in project config, but it would override the user's own value (closest file wins; inference from the precedence rules).
- `model_instructions_file` *replaces* the built-in instructions. Avoid it.

### 2.4 MCP prompts and resources

**Resources**
- The model gets three tools: `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` ([mcp_resource_spec.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs)).

**Prompts are not supported**
- The MCP client exposes `list_tools`, `list_resources`, `list_resource_templates`, `read_resource` and `call_tool`, but no `prompts/list` or `prompts/get`. A search of the whole `codex-rs` tree found no MCP prompt calls ([rmcp_client.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/rmcp_client.rs)).
- The feature request, [openai/codex#5059](https://github.com/openai/codex/issues/5059) "Feature request: MCP prompts support", is still open; the latest comment is from 2026-09-27. [#8342](https://github.com/openai/codex/issues/8342) was closed as a duplicate of it on 2026-08-06.

### 2.5 Hooks

**Where hooks are configured**
- `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json` and `<repo>/.codex/config.toml` (inline `[hooks]`). Plugins can also bundle hooks.
- All sources load; higher layers don't replace lower ones.
- Project hooks need a trusted project.
- Hooks are on by default; `[features] hooks = false` turns them off.

Source: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced).

**Events and handlers** ([Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`/`SubagentStop`, `Stop`, `Interrupt`.
- Handler types: `command` and `mcp_tool`. `prompt` and `agent` handlers are parsed but skipped.
- Other handler options:
  - `commandWindows` (TOML: `command_windows`), a Windows-only override of the command;
  - `async: true` runs a command hook in the background.
- Commands run in the session's working directory.

**`SessionEnd` limits** ([Codex hooks](https://learn.chatgpt.com/docs/hooks))
- 1 second by default, 3 seconds at most. `Interrupt` has the same limits.
- It always runs synchronously.
- `mcp_tool` handlers can't be used for it.
- It runs for the main thread only: on archive or delete, on a normal close, or after 30 minutes idle with no connected client.

**Inputs** ([Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Every hook receives `session_id`, `transcript_path` (**may be `null`**), `cwd`, `hook_event_name` and `model`. Most events also get `permission_mode`.
- "The transcript format isn't a stable interface."

**Trust** ([Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Every non-managed hook must be reviewed and trusted in `/hooks`.
- Trust is tied to a hash of the hook definition, so new or changed hooks are skipped until they are trusted again.
- `--dangerously-bypass-hook-trust` skips this for a single run.
- **Inference:** keep grimoire's hook definitions byte-stable across grimoire upgrades (no version in the command string), or every upgrade forces a re-review.

### 2.6 Plugins

**How repo plugins work** ([build plugins](https://developers.openai.com/plugins/build/plugins))
- A repo marketplace lives at `$REPO_ROOT/.agents/plugins/marketplace.json`, with `source.path` values like `./…` relative to the marketplace root.
- **Added:** the docs say the ChatGPT desktop app also reads a "legacy-compatible marketplace at `$REPO_ROOT/.claude-plugin/marketplace.json`". **Unverified:** whether the Codex CLI reads it too.
- Manifests: a root `plugin.json` (portable), with `.codex-plugin/plugin.json` still supported. Claude-compatible manifests are also accepted. `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` are set for compatibility.
- A plugin is turned on per project with `[plugins."name@market"] enabled = true` in `.codex/config.toml` (trusted projects only).
- Plugins are installed into `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/local/` and loaded from that copy. Picking up changes needs a restart.

**Inference:** because plugins are copied into a cache, they fit badly with skills that keep changing as the wiki grows. Plain `.agents/skills` is simpler.

---

## 3. Side by side

| | Claude Code | Codex |
|---|---|---|
| MCP config file | `.mcp.json` (repo root, JSON) | `.codex/config.toml` `[mcp_servers.x]` (TOML, root to current directory, trusted only) |
| MCP gate | Asks per server (interactive); committed approvals count only after trust; `-p`/SDK load without asking | Project trust only; per-tool approval modes |
| Variables | `${VAR}` and `${VAR:-d}`; `CLAUDE_PROJECT_DIR` passed to server | No interpolation; environment limited to an allowlist |
| Working directory | Not documented; use `CLAUDE_PROJECT_DIR` | `cwd` key, default is the Codex process directory |
| `roots/list` | Yes (launch directory + added directories) | Not advertised (source) |
| Windows `npx` | v2.1.119 removed the warning; untested | `which` + `PATHEXT` resolution (source) |
| Skill folders | `.claude/skills/` (+ parents up to repo root) | `.agents/skills/` (current directory up to repo root); `.codex/skills/` (source only) |
| Symlinked skills | Yes | Yes (repo/user/admin) |
| Body indirection | `@` file references (implied, spike); `` !`cmd` `` (needs `allowed-tools`) | None documented |
| Instruction files | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/`; `AGENTS.md` / `.claude/AGENTS.md` only if no `CLAUDE.md` | `AGENTS.md`, `AGENTS.override.md`, fallbacks |
| Imports | `@path`, up to 4 hops | None |
| MCP prompts | `/server:prompt` commands | Not supported |
| MCP resources | `@` mentions + list/read tools | List/read tools |
| Server `instructions` | Yes (4,096 characters since v2.1.296; docs still say 2,048) | Yes (first 512 characters matter) |
| Hooks file | `.claude/settings.json` | `.codex/hooks.json` or `[hooks]` in `config.toml` |
| Hook trust | Workspace trust (interactive) | Review and trust per hook (by hash) |
| `SessionEnd` budget | 1.5 s (up to 60 s) | 1 s (up to 3 s), no `mcp_tool` |
| Hook handler types | command, http, mcp_tool, prompt, agent | command, mcp_tool |

---

## 4. Minimal pointer-file set (recommendation)

This set uses only documented paths and no symlinks. `grimoire init` merges each entry idempotently and records it in the manifest.

**Claude Code: 3 files plus one stub per skill**
1. **`.mcp.json`:** merge in a single `mcpServers.grimoire` entry, for example `{"command":"npx","args":["-y","@goksening/grimoire","mcp"]}`.
   - Use the scoped package name. The unscoped `grimoire` on npm is an unrelated PhantomJS framework (latest 0.1.0), and `@goksening/grimoire` isn't published yet (registry returns 404) ([npm: grimoire](https://registry.npmjs.org/grimoire)).
2. **`.claude/rules/grimoire.md`:** a one-line import, such as `@../../.grimoire/instructions.md`.
   - It loads at launch and doesn't change whether Claude reads `CLAUDE.md` or `AGENTS.md` ([memory](https://code.claude.com/docs/en/memory)).
   - Spike needed: confirm imports work in project rule files.
   - Inference: avoid naming the target `AGENTS.md` (see 1.3).
3. **`.claude/skills/<skill>/SKILL.md`:** a generated stub for each skill grimoire exposes.
   - The stub copies the frontmatter (`name`, `description`, and any Claude extras).
   - Body options, in order of preference:
     - (a) an `@` reference to `.grimoire/skills/<skill>/SKILL.md` (spike: local skill bodies expand `@` files, but path resolution isn't documented);
     - (b) a plain sentence: "Generated by grimoire. Read and follow `.grimoire/skills/<skill>/SKILL.md`." This costs one extra Read call;
     - (c) a `` !`…` `` injection, which must be pre-approved in the stub's `allowed-tools` or the invocation aborts, and which depends on bash or PowerShell on Windows;
     - (d) a full generated mirror of the skill.
4. **Optional: `.claude/settings.json`**, for trace hooks and to skip the per-server prompt after trust. Add `hooks` and `"enabledMcpjsonServers":["grimoire"]` ([settings reference](https://code.claude.com/docs/en/settings-reference)).

**Codex: 2 files plus one stub per skill**
1. **`.codex/config.toml`:** `[mcp_servers.grimoire]` with the same command, and `startup_timeout_sec` raised (inference: a cold `npx` start on Windows can exceed the 10 s default). The same file can hold inline `[hooks]`, so Codex needs only one config file. It only loads in trusted projects.
2. **`AGENTS.md`:** a marked grimoire block, appended, or a new file if none exists.
   - It has to be literal text, because Codex has no import syntax.
   - It can be dropped if the MCP server's `instructions` are enough.
   - When the repo has no `CLAUDE.md`, Claude Code reads this block too.
3. **`.agents/skills/<skill>/SKILL.md`:** the same stubs, using body option (b) or (d), since Codex documents no `@` or `!` expansion.

**Why skills need two copies**
- No single skill folder is read by both clients: Claude Code reads `.claude/skills`, and Codex reads `.agents/skills` (and `.codex/skills`).
- You could junction or symlink `.claude/skills/<n>` to `.agents/skills/<n>`, as this repo does. But on Windows, git commits a junction's contents as duplicate files (local observation), so treat the second set as generated output either way.

**Smaller but riskier options**
- **Claude Code with one file:** `.claude/settings.json` only, using `extraKnownMarketplaces` (directory source) plus `enabledPlugins`, pointing at a plugin rooted in `.grimoire/` that carries the skills, hooks and `.mcp.json`. This needs a spike. Downsides: trust gating (even for `-p`), ignored in cloud sessions, namespaced `/grimoire:<skill>` names, and loading only from the repo root.
- **Symlinks into `.grimoire/skills/`:** they work in both clients but don't survive git on Windows.

**Trace capture** ([hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Record `session_id` and `transcript_path` cheaply at `Stop` (and at `SessionStart` with a `command` hook, since launch-time `mcp_tool` hooks are skipped in Claude Code), using an `mcp_tool` hook or a fast command. Ingest the traces into `.grimoire/` later.
- In Codex, `transcript_path` can be null.
- Don't rely on an `npx` process starting in time during `SessionEnd`: Codex allows 1 second, 3 at most, with no `mcp_tool`; Claude Code allows 1.5 s by default.

---

## 5. Options with zero files outside `.grimoire/`

- **MCP as the delivery channel** (once the server is registered somewhere):
  - **Instructions:** the server's `instructions` field, read by both clients.
  - **Skills:** an MCP tool such as `grimoire_skill_get` (both clients), or MCP prompts (Claude only; user-invoked).
  - **Wiki:** MCP resources (Claude via `@` mentions and tools; Codex via tools).
  - **Cost:** you lose the clients' automatic matching of skills by description.
- **Per-machine registration, nothing in the repo:**
  - Claude Code: `claude mcp add --scope local grimoire …` writes to `~/.claude.json` under this project's path ([mcp](https://code.claude.com/docs/en/mcp)).
  - Codex: only a global server in `~/.codex/config.toml`. Codex has no per-project MCP setting outside the repo; the only per-project key in user config is `projects.<path>.trust_level` (docs, and `ProjectConfig` in source) ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). The server would need to do nothing outside grimoire repos.
  - This breaks the "git is the only sync layer" rule for teammates.
- **Launch flags:**
  - Claude Code: `claude --mcp-config .grimoire/… --plugin-dir … --add-dir .grimoire`. `--add-dir` loads `.grimoire/.claude/skills/` ([mcp](https://code.claude.com/docs/en/mcp), [plugins/loading](https://code.claude.com/docs/en/plugins/loading), [skills](https://code.claude.com/docs/en/skills)).
  - Codex: `codex -c mcp_servers.grimoire.command=…` ([config advanced](https://learn.chatgpt.com/docs/config-file/config-advanced)).
  - These must be passed on every launch.
- **Claude Code only:** `.grimoire/.claude/skills/` loads lazily, once Claude touches a file in `.grimoire/` ([skills](https://code.claude.com/docs/en/skills)).

---

## 6. What to copy and what to avoid

**Copy**
- `AGENTS.md` as the instruction file both clients share.
- `.claude/rules/` for a pointer that doesn't disturb anything else.
- `${CLAUDE_PROJECT_DIR:-.}`.
- MCP server `instructions`, with the essentials in the first 512 characters.
- `mcp_tool` hooks, which avoid spawning a process (not at Claude launch-time `SessionStart`, and not at Codex `SessionEnd`).
- Correct read-only and destructive annotations on grimoire's tools. Codex always asks for approval on tools that advertise a destructive annotation, unless they also advertise a read annotation ([approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)).
- Idempotent merges into JSON and TOML using marked blocks.

**Avoid**
- Creating a `CLAUDE.md` or `CLAUDE.local.md` in a repo that only has `AGENTS.md`.
- `cmd /c`, or an unscoped `npx grimoire`, in committed config.
- Committed symlinks or junctions.
- `model_instructions_file`, and `developer_instructions` in project config.
- `required = true` for the grimoire server.
- Depending on the transcript format, or on `roots/list` under Codex.
- Long work in `SessionEnd`.
- Having agents inside Codex write to `.agents/` or `.codex/`.
- Using MCP prompts as the only skill channel (Codex doesn't support them).
- `!` injections in stubs without a matching `allowed-tools` entry.

---

## 7. Open questions for spikes

1. Does a `.mcp.json` entry with `"command":"npx"` start on native Windows in Claude Code 2.1.296?
2. Does a `.claude/rules/x.md` containing `@../../.grimoire/y.md` load without a dialog?
3. **New:** does an `@.grimoire/skills/<n>/SKILL.md` (or `@${CLAUDE_PROJECT_DIR}/…`) reference in a local `SKILL.md` body get expanded, and what is it resolved against?
4. Does a directory marketplace or plugin rooted at `.grimoire/` work? Do its MCP servers need approval, and how are its skills named?
5. How does Codex handle symlinked skills that point into a hidden `.grimoire/` folder? Hidden-directory pruning applies only below the skills root, but whether targets are canonicalized first is unverified.
6. ~~Does Codex answer `roots/list`, and does it sandbox MCP servers?~~ Resolved by source reading: no `roots` capability is advertised, and local stdio servers are not sandboxed.
7. **New:** in a project `.codex/config.toml`, does a relative `mcp_servers.grimoire.cwd` (for example `".."`) resolve against the `.codex/` folder?
8. **Local observation (re-checked):** in this agent shell, `node` and `npx` were not on PATH, even though Node is installed at `C:\Program Files\nodejs`. `grimoire init` should check that `npx` resolves from the client's environment.

---

## Sources

**Claude Code**
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/settings-reference
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/plugins/loading
- https://code.claude.com/docs/en/plugins/org
- https://code.claude.com/docs/en/plugins/create
- https://code.claude.com/docs/en/plugins/marketplace-reference
- https://code.claude.com/docs/en/changelog
- https://github.com/anthropics/claude-code/issues/9594

**Codex**
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/config-file/config-basic
- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/agent-approvals-security
- https://learn.chatgpt.com/docs/customization/overview
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/codex/llms.txt
- https://github.com/openai/codex/releases
- https://github.com/openai/codex/issues/5059
- https://github.com/openai/codex/issues/8342

**Codex source** (`main` branch, HEAD `de8fab6`, fetched 2026-10-11)
- https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs
- https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/host.rs
- https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/loader/discovery.rs
- https://github.com/openai/codex/blob/main/codex-rs/config/src/skills_config.rs
- https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs
- https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/program_resolver.rs
- https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/utils.rs
- https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/stdio_server_launcher.rs
- https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/rmcp_client.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/server.rs
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/shell_environment.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs

**Specs and registries**
- https://agentskills.io/specification
- https://modelcontextprotocol.io/specification/2025-11-25/server/prompts
- https://registry.npmjs.org/grimoire

**Local observations** (D:\Dev\grimoire, 2026-10-11)
- `claude --version` reports 2.1.296.
- `.claude/skills/*` are NTFS junctions (`LinkType = Junction`) to `.agents/skills/*`.
- `git ls-files -s` shows the junction contents committed as regular `100644` files; `core.symlinks=false`.
- `node` and `npx` don't resolve on PATH in the agent shell.

---

## Verification notes

**Checked and confirmed against primary sources:**
- **Claude Code `.mcp.json`:** location, schema, `type` rules, precedence, `${VAR}`/`${VAR:-default}` expansion, `CLAUDE_PROJECT_DIR` and the `:-.` default, and `roots/list` (mcp docs).
- **Claude Code approvals:** the interactive approval prompt, `-p`/SDK behaviour, and `enabledMcpjsonServers`/`enableAllProjectMcpServers` being ignored until trust and written to `settings.local.json` (mcp, settings reference, permissions).
- **Claude Code changelog:** v2.1.296 (Oct 9, 2026), the 2,048→4,096 change, v2.1.119 (Apr 23, 2026) removing the `cmd /c` warning, and v2.1.277 (Sep 18, 2026) adding `AGENTS.md`.
- **Claude Code skills:** locations, parent-directory search, `--add-dir`, `additionalDirectories`, symlinks, the frontmatter table, 1,536 chars, the 1% budget, unknown fields ignored, `/reload-skills`, `!` injection and `disableSkillShellExecution`.
- **Claude Code memory:** `@` imports with 4 hops, the external-import dialog, `.claude/rules` behaviour, `AGENTS.md` rules, 4 MiB and 200 lines.
- **Claude Code hooks:** locations, events, the 5 handler types, the `mcp_tool` `SessionStart` skip, the `SessionEnd` 1.5 s/60 s budget and env var, Windows shell and exec form, trust.
- **Claude Code plugins:** in-place loading, the plugin-root restriction, `./` sources, the `directory` source resolving to the main checkout, skills-dir plugins and trust.
- **Codex MCP:** the `.codex/config.toml` trusted-only rule, all listed stdio/HTTP/common keys and defaults, the 512-char guidance, `mcp_optional_startup_grace_ms`.
- **Codex config:** layering (closest wins), forbidden project keys, relative paths, project root markers.
- **Codex skills:** locations, symlinks, `name`/`description`, the 2%/8,000 budget, `agents/openai.yaml`, `[[skills.config]]`.
- **Codex `AGENTS.md`:** order, 32 KiB, and fallback path-syntax rejection (source).
- **Codex hooks:** locations, events, handlers, `commandWindows`, `async`, `SessionEnd` 1 s/3 s, synchronous, no `mcp_tool`, hash-based trust, the bypass flag, `[features] hooks`.
- **Codex sandbox:** protected `.agents`/`.codex`/`.git`, destructive-annotation approval.
- **Codex plugins:** repo marketplace path, per-project enable, cache path.
- **Codex source:** `program_resolver.rs` (`which` + `PATHEXT`, npx comment), the env allowlist, `cwd` fallback, no prompts in the client, three resource tools, `.codex/skills` and the deprecated `$CODEX_HOME/skills`, `ProjectConfig` has only `trust_level`.
- **Codex release and issues:** `rust-v0.162.1` is the latest stable tag, `main` pushed 2026-10-10, #5059 open (last comment 2026-09-27), #8342 closed as a duplicate.
- **Specs and registries:** the Agent Skills spec (name must match the directory, description ≤1,024), the MCP spec (prompts are user-controlled), npm `grimoire` (PhantomJS, 0.1.0) and `@goksening/grimoire` 404.
- **Local observations:** re-checked.

**Corrected or added:**
1. `@` file references in skill bodies: the original said none were documented. The skills docs and the v2.1.228 changelog imply that local skill bodies expand `@` files.
2. `!` injection must pass permission checks and needs `allowed-tools`, otherwise the invocation aborts.
3. The server-instructions limit: the docs page still says 2,048, while the changelog says 4,096. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` controls it.
4. `permission_mode` is not a universal Claude hook input; Codex `transcript_path` may be null.
5. Codex `roots/list`: resolved via source. No `roots` capability is advertised (protocol 2025-06-18).
6. Codex MCP sandboxing: resolved via source. Local stdio servers are not sandboxed.
7. Claude also reads `.claude/AGENTS.md` in `AGENTS.md` mode.
8. The "six spec fields" rule is limited to claude.ai uploads, the Skills API and `package_skill.py`.
9. `--add-dir .grimoire` loads `.grimoire/.claude/skills/`, not `.grimoire/skills/`.
10. Codex reads a legacy `$REPO_ROOT/.claude-plugin/marketplace.json` (desktop app per docs).
11. The SDK loads `.mcp.json` only with project `settingSources`.
12. Codex's newer pre-release is `rust-v0.163.0-alpha.5`.
13. Recommendation: name the instruction target something other than `AGENTS.md` (inference).

**Still unverified:**
- `@` imports in project `.claude/rules` files.
- How `@` references in `SKILL.md` bodies are resolved.
- The runtime behaviour of `npx` in `.mcp.json` on native Windows.
- A plugin rooted at `.grimoire/`.
- Codex symlink targets inside hidden `.grimoire/`.
- Codex resolution of a relative `mcp_servers.*.cwd`.
- Whether the Codex CLI (not just the desktop app) reads `.claude-plugin/marketplace.json`.
- The `list_changed` refresh behaviour in Claude Code.
- The contents of anthropics/claude-code#9594 (not re-read).
