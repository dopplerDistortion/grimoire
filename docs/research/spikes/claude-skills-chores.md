# Spike C: Claude Code skill delivery and the chore subagent

*Spike for GOK-128 (spec §22: B1, P2, C1, C2). Every item was exercised with the real Claude Code 2.1.296 (`claude -p`, headless) on native Windows 11, Node v24.21.0, Git 2.55.0.windows.3, on 2026-10-11. Sessions ran in throwaway git repos under `%TEMP%`, with the machine's normal user settings, so the skill listing held about 80 other personal, plugin and built-in skills. Model `claude-opus-5-5` unless a run says otherwise.*

## Verdicts

| Item | Verdict | Fallback taken? |
| -- | -- | -- |
| B1: SessionStart `reloadSkills` through the exec-form bootstrap | **Confirmed** | No |
| P2 (Claude half): stub in a self-ignoring folder matched by description, then the copy read | **Confirmed** (3 of 3 runs) | No. ADR 0002 stands |
| C1: `PreToolUse` reports `agent_type: grimoire-chores` and an `agent_id` for the forked subagent | **Confirmed** | No |
| C2: the chore subagent reaches the deferred chore tools through `ToolSearch` | **Confirmed**. No always-loaded tools needed | No |

**Items that took the fallback: none.**

Four side findings change downstream tickets (see [Other findings](#other-findings-that-change-downstream-work)). The most urgent: the spec's hook argument vector `["-e", "<bootstrap>", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "<event>"]` **fails under Node** (`node: bad option: --from`, exit 9). Node treats `--from` as its own option. An `--` after the script fixes it.

## Common setup

- **Repos:** `git init` in `%TEMP%\gok128\repos\<run>`, one commit, `.grimoire/config.yml` present (`version: 0.0.0`).
- **Stub MCP server:** a Node stdio JSON-RPC server registered as `grimoire` in `.mcp.json`. It serves `chore_start`, `chore_read`, `chore_submit`, `chore_abandon` and `skill_read`, answers `initialize` with `2025-06-18`, and logs every request with its `_meta`.
- **Observer hooks:** exec-form command hooks (`"command": "node", "args": [<script>, <label>]`) that save stdin byte for byte and print nothing.
- **Runs:** `claude -p "<prompt>" --output-format stream-json --verbose --max-turns N`. Evidence comes from three places: the stream (`system/init` lists `skills` and `agents`, plus hook and task events), the session transcript under `~/.claude/projects/`, and the hook and server logs.

The probe scripts were throwaway and are not committed. Every file content that mattered is quoted below.

## B1: `reloadSkills` from the SessionStart hook

**Question.** Can a SessionStart hook run through the exec-form bootstrap write skill folders and print `"reloadSkills": true`, so that Claude Code lists those skills on the first turn?

**Setup.** `.claude/settings.json` declares one SessionStart hook in exec form:

```json
{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "node",
  "args": ["-e", "<bootstrap>", "--", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "session-start"],
  "timeout": 10}]}]}}
```

`<bootstrap>` is a stand-in for the frozen bootstrap. It avoids `$ " \ % ^` and backticks, walks up from `--from` to the first `.git` (following a `gitdir:` file through `commondir`), and requires `<git-common-dir>/grimoire/launcher.cjs`:

```js
const f=require('fs'),p=require('path');let a=process.argv.slice(1),d=process.cwd();if(a[0]=='--from'){d=a[1];a=a.slice(2)}d=p.resolve(d);let c;for(;;){const g=p.join(d,'.git');if(f.existsSync(g)){if(f.statSync(g).isDirectory())c=g;else{const t=f.readFileSync(g,'utf8').trim().slice(8);c=p.resolve(d,t);const m=p.join(c,'commondir');if(f.existsSync(m))c=p.resolve(c,f.readFileSync(m,'utf8').trim())}break}const u=p.dirname(d);if(u==d)process.exit(0);d=u}const l=p.join(c,'grimoire','launcher.cjs');if(f.existsSync(l))require(l)(a,d)
```

On `hook session-start`, the launcher stand-in writes the copy `.grimoire/skills/tidewater-ledger/SKILL.md` and the stub `.claude/skills/grimoire-tidewater-ledger/SKILL.md`. Each folder gets its own `.gitignore` of `*`. The stub uses the spec's three-line body. When the launcher wrote anything, it prints exactly:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}
```

Each repo started with no `.claude/skills/` folder, the fresh-worktree case. The prompt was "Without using any tools: list the names of all skills available to you whose names start with grimoire-, exactly as listed, one per line. If there are none, reply NONE."

**Results.**

| Run | Hook output | Listed on turn 1? | Turn 2 |
| -- | -- | -- | -- |
| `b1-print`: main checkout, prints `reloadSkills` | the JSON above, exit 0 | **yes**: `grimoire-tidewater-ledger` | — |
| `b1-wt-linked`: fresh linked worktree (`git worktree add`), prints `reloadSkills` | the JSON above, exit 0 | **yes** | — |
| `b1-noprint`: writes the same files, prints nothing | empty, exit 0 | no (`NONE`) | — |
| `b1-noprint-2t`: same, two turns in one process | empty | no | **no** |
| `b1-noprint-pre-2t`: a committed `.claude/skills/house-style/` already exists, prints nothing, two turns | empty | no | **no**, although the stream emitted `commands_changed` with the new skill after turn 1 |
| `b1-specargs`: the spec's literal args (no `--`) | `node: bad option: --from`, exit 9, outcome `error` | no | — |

**Evidence.**

- The stream's `system/init` event comes *after* the SessionStart `hook_response`. In `b1-print` its `skills` array starts with `grimoire-tidewater-ledger`; in `b1-noprint` the skill is absent.
- The transcript's `skill_listing` attachment in `b1-print` starts with `- grimoire-tidewater-ledger: Reconcile the tidewater ledger files in this repo. Use when …`.
- The launcher logged `argv: [node, "--from", "C:\\Users\\…\\repos\\b1-print", "hook", "session-start"]`. So `${CLAUDE_PROJECT_DIR}` is substituted inside exec-form `args` on Windows, with backslashes, and Node strips the `--`.
- In the linked worktree, the bootstrap reached the main checkout's `.git/grimoire/launcher.cjs` through `gitdir:` and `commondir`, and the files landed in the linked worktree.
- The SessionStart payload a `-p` session sends: `{session_id, transcript_path, cwd, hook_event_name: "SessionStart", source: "startup"}` (fixture `session-start-startup.json`).

**Decision for dependent slices.**

- **GOK-157 (SessionStart fast path):** print exactly `{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true}}` on stdout whenever the hook wrote a copy or a stub. Without it, a fresh worktree gets no evolved skills on turn 1, and in these runs not on turn 2 either. The "hot reload on the next turn" fallback is weaker than the spec assumed: in `-p` the watcher saw the new folder, but no updated listing reached the model. Don't rely on it.
- **GOK-144 / GOK-146 (bootstrap and pointer files):** the hook args must put `--` before `--from` (see side finding 1).

## P2 (Claude half): stub matched by description, then the copy read

**Question.** Does Claude Code match a skill stub in a self-ignoring folder by its description, and then actually read the copy under `.grimoire/skills/`?

**Setup.** Both generated folders are self-ignoring, so after the commit `git status --short --ignored` shows `!! .claude/` and `!! .grimoire/skills/`. The repo also holds a `CHANGELOG.md` as a decoy, and `src/login.js`.

`.claude/skills/grimoire-changelog-entry/SKILL.md` (the stub, in the spec's wording):

```markdown
---
name: grimoire-changelog-entry
description: Add a changelog entry or release note for a change in this repo. Use when the user asks to record, log or note a change, fix or feature in the changelog or release notes.
---

Generated by grimoire. Read and follow `.grimoire/skills/changelog-entry/SKILL.md`.

If that file is missing, call `skill_read` with `changelog-entry`.

If `.grimoire/config.yml` is absent in this checkout, grimoire isn't installed here: ignore this skill, and tell the user that `npx @goksening/grimoire leave` cleans these files up.
```

The copy `.grimoire/skills/changelog-entry/SKILL.md` (same `name` without the prefix, same description) says that `CHANGELOG.md` is generated and must not be edited. Instead, the agent should create `changes/<kebab-slug>.md` holding `kind:`, `summary:` and an exact line `marker: GRIM-P2-COPY-READ`.

The prompt names no skill: "Add a changelog entry saying we fixed the login timeout bug." Runs used `--permission-mode acceptEdits`.

**Results.**

| Run | First tool call | How the copy was read | Outcome |
| -- | -- | -- | -- |
| `p2-a` (opus) | `Skill {skill: "grimoire-changelog-entry"}` | `Bash ls`, then `Read .grimoire\skills\changelog-entry\SKILL.md` | wrote `changes/fix-login-timeout.md` with the marker; `CHANGELOG.md` untouched |
| `p2-b` (opus) | `Skill {skill: "grimoire-changelog-entry"}` | `Glob .grimoire/**`, then `Read` of the copy | same |
| `p2-sonnet` (`--model sonnet`) | `Skill {skill: "grimoire-changelog-entry"}` | `Bash cat .grimoire/skills/changelog-entry/SKILL.md` | same |

**Evidence.**

- The stub was listed in `system/init` `skills` and in the transcript's `skill_listing`, with its full description, although its folder is git-ignored. Claude Code doesn't skip ignored skill folders.
- The stub body reaches the model as a `user` line with `isMeta: true`, whose `sourceToolUseID` is the `Skill` call's id. Its text begins "Base directory for this skill: …\\.claude\\skills\\grimoire-changelog-entry" and then the stub body.
- The `Glob` tool listed files inside the ignored `.grimoire/skills/` folder, so ignore files don't hide the copy from Glob.
- Fixtures: `transcripts/stub-match-read-tool.jsonl` (`p2-a`) and `transcripts/stub-match-shell-read.jsonl` (`p2-sonnet`).

**Decision for dependent slices.**

- **ADR 0002 stands.** The stub format in §15 works verbatim. Nothing reopens.
- **GOK-153 (generated output):** write stubs and copies exactly as §15 says. Self-ignoring folders are fine for Claude Code discovery.
- **GOK-158 (skill facts in traces), the read signal:** a read of the copy shows up as the `Read` tool (`file_path`, backslashes on Windows) *or* as a shell command naming the path (`cat`). The `Skill` call for `grimoire-<name>` comes first, and its stub body is an `isMeta` line tied to it by `sourceToolUseID`. Count both read forms, and normalize path separators before matching.

## C1: `agent_type` in the forked subagent's `PreToolUse` payload

**Question.** When the `grimoire-chores` skill (`context: fork`, `agent: grimoire-chores`) runs, do `PreToolUse` payloads for the subagent's grimoire tool calls carry `agent_type: "grimoire-chores"` and an `agent_id`?

**Setup.** `.mcp.json` registers the stub server as `grimoire`. `.claude/settings.json` has `permissions.allow: ["mcp__grimoire"]`, `enabledMcpjsonServers: ["grimoire"]`, and observer hooks: `PreToolUse` with matcher `mcp__grimoire__.*` (the spec's matcher) and with `.*`, plus `SubagentStart` and `SubagentStop`. Because the folder is untrusted under `-p`, the allow rule is ignored (side finding 2), so the runs passed `--allowedTools mcp__grimoire`.

`.claude/skills/grimoire-chores/SKILL.md`:

```markdown
---
name: grimoire-chores
description: Run grimoire's due maintenance chores in an isolated subagent. Use when grimoire's session notice says one is due and the user agrees, or when the user asks.
context: fork
agent: grimoire-chores
background: true
---

Run grimoire's due maintenance chore with the grimoire chore tools (`chore_start`, `chore_read`, `chore_submit`, `chore_abandon`).

1. Call `chore_start` with no arguments. It returns a run handle.
2. Call `chore_read` with that `run` to page the inputs.
3. Reason about the inputs.
4. Call `chore_submit` with the `run` and `result` set to `{"pages": [], "consumption": {"pair-1": "no_pattern"}}`.
5. Return the `summary` from the last result verbatim, and nothing else.

Never edit files and never ask for approval.
```

`.claude/agents/grimoire-chores.md`:

```markdown
---
name: grimoire-chores
description: Runs grimoire's knowledge chores with only the chore tools. Use only through the grimoire-chores skill.
tools: mcp__grimoire__chore_start, mcp__grimoire__chore_read, mcp__grimoire__chore_submit, mcp__grimoire__chore_abandon, ToolSearch
omitClaudeMd: true
---

You run grimoire's maintenance chores. Follow the procedure you are given exactly, using only the grimoire chore tools.
```

Prompt: "Run the grimoire-chores skill."

**Results.**

- **Run `c-ts2`.** The main context called `Skill {skill: "grimoire-chores"}`. The stream showed `task_started` with `subagent_type: "grimoire-chores"`, and `is_backgrounded: false`, because `-p` always waits for a forked skill (documented). Then `SubagentStart` fired with `agent_type: "grimoire-chores"`, `agent_id: "a523fef26307d8241"`. The subagent's `ToolSearch`, `chore_start`, `chore_read` and `chore_submit` each fired `PreToolUse` with that `agent_id` and `agent_type`. The main context returned the run's `summary` verbatim.
- The forked subagent's `PreToolUse` payload (sanitized fixture `hook-payloads/pre-tool-use-chore-subagent.json`):

  ```json
  {"session_id":"c2eb58d9-…","transcript_path":"C:\\Users\\user\\.claude\\projects\\…\\c2eb58d9-….jsonl","cwd":"…\\repos\\c-ts2","prompt_id":"4a4c29b7-…","permission_mode":"default","agent_id":"a523fef26307d8241","agent_type":"grimoire-chores","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"mcp__grimoire__chore_start","tool_input":{},"tool_use_id":"toolu_01JKJLE75F1oWW6KxurK5paA","mcp_server":{"name":"grimoire","source":"project"}}
  ```

- The matching `tools/call` reached the server with `_meta: {"claudecode/toolUseId": "toolu_01JKJLE75F1oWW6KxurK5paA", "progressToken": 2}`. The ids match. `_meta` carries no session or agent identity.
- **Controls:**
  - The main context calling `chore_start` itself: no `agent_id` and no `agent_type` keys at all (`pre-tool-use-main-context.json`).
  - A `general-purpose` subagent launched with the Agent tool: `agent_type: "general-purpose"` with its own `agent_id` (`pre-tool-use-general-purpose-subagent.json`).
  - A `grimoire-chores` subagent launched with `run_in_background: true` (`is_backgrounded: true`): the same `agent_type` and `agent_id` on every grimoire call, and its result came back to the main context.
- `transcript_path` in a subagent's payload is the **parent** session's transcript. The subagent's own transcript is `<session>/subagents/agent-<agent_id>.jsonl`, next to `agent-<agent_id>.meta.json` = `{"agentType":"grimoire-chores","spawnDepth":1,"requestShape":"foreground","requestNonInteractive":true}`.

**Decision for dependent slices.**

- **GOK-147 (hint hook):** the hint gets `agent_id` and `agent_type` straight from the payload. They are absent, not empty, in the main context. The `tool_use_id` ↔ `_meta["claudecode/toolUseId"]` validation works for subagent calls.
- **GOK-154 (admission):** admit only when the validated hint has `agent_type === "grimoire-chores"`. A merely present `agent_id` is not enough, because other subagents carry one too. This matches the spec's table, and the fallback ("admit any subagent") is not needed.
- **GOK-135 / GOK-149 (capture):** a subagent's transcript is found from `agent_id`, not from `transcript_path`. A `grimoire-chores` subagent transcript can be recognized, and excluded, from its `.meta.json` `agentType` without parsing it.

## C2: deferred chore tools in the subagent

**Question.** With MCP tool search on (the default), does the chore subagent reach the deferred chore tools through `ToolSearch` in its `tools:` allowlist, or do the tools have to be always loaded (`alwaysLoad`)?

**Results.**

| Run | Subagent `tools:` | Server entry | What happened |
| -- | -- | -- | -- |
| `c-ts2` | 4 chore tools + `ToolSearch` | no `alwaysLoad` | The subagent transcript got a `deferred_tools_delta` naming **only** the 4 chore tools; `skill_read`, on the same server, was not offered. The subagent called `ToolSearch {query: "select:mcp__grimoire__chore_start,…chore_read,…chore_submit,…chore_abandon"}`, got 4 `tool_reference` blocks, then ran the whole procedure. |
| `c-nots2` | 4 chore tools only | no `alwaysLoad` | No `deferred_tools_delta` in the subagent: the listed tools were loaded up front, and it called `chore_start` directly. The whole procedure ran. |
| `c-bg` | 4 chore tools + `ToolSearch`, run in the background | no `alwaysLoad` | Same as `c-ts2`. Background subagents keep `ToolSearch` (documented). |

**Decision for dependent slices.**

- **GOK-166 (chore carriers) and GOK-146 (pointer files):** keep the subagent's `tools:` as the 4 chore tools plus `ToolSearch`, as the spec says. Don't add `alwaysLoad` to `.mcp.json`, and don't set `anthropic/alwaysLoad` on any tool.
  - `ToolSearch` widens nothing, because its pool is the subagent's allowlist. It costs one extra model turn per run.
  - Dropping `ToolSearch` also works today, through an observed but undocumented rule (an agent without `ToolSearch` gets its listed MCP tools up front). Keeping it works under both rules.

## Other findings that change downstream work

1. **The hook argument vector in spec §11 fails (GOK-144, GOK-146; overlaps spike R3).**
   - Node parses options after `-e <script>` until the first positional argument. So `node -e "<bootstrap>" --from <dir> hook session-start` exits 9 with `node: bad option: --from`.
   - Under Claude Code the hook outcome is `error`, and nothing is written (run `b1-specargs`).
   - **Fix, verified under Claude Code:** `["-e", "<bootstrap>", "--", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "<event>"]`. Node drops the `--`, so `process.argv.slice(1)` is `["--from", <dir>, "hook", "<event>"]`.
   - Putting the verb first (`hook session-start --from <dir>`) also parses. MCP entries (`["-e", "<bootstrap>", "mcp"]`) are unaffected, because `mcp` is positional.
   - Because hook definitions are frozen, this must be right in the first release.
2. **Under `claude -p`, an untrusted folder ignores the project's `permissions.allow` (GOK-146, GOK-150, GOK-166).**
   - With `.claude/settings.json` allowing `mcp__grimoire` (also tried: `mcp__grimoire__*` and the exact tool name), every grimoire call was denied: "Claude requested permissions to use mcp__grimoire__chore_start, but you haven't granted it yet."
   - stderr said: `Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. … set projects["<repo>"].hasTrustDialogAccepted: true in ~/.claude.json`.
   - This is documented: in a never-trusted folder, `-p` and the SDK use the project's hooks and `.mcp.json` servers, but not its allow rules. `--allowedTools mcp__grimoire` fixed it. An interactive session's trust dialog lists the rule and applies it once accepted.
   - **What to build:** headless recipes (local schedulers, CI, cloud) must pass `--allowedTools mcp__grimoire`, or allow it in user settings. `doctor` can flag an untrusted repo. The chore carrier fails the same way in such a session.
3. **Don't put `allowed-tools` on the chore skill (GOK-166).** Adding `allowed-tools: mcp__grimoire__chore_start …` to `grimoire-chores` made the `Skill` invocation itself need approval: `permission_denied` "Execute skill: grimoire-chores", twice, so the chore never started. Rely on the `mcp__grimoire` allow rule.
4. **MCP handshake, an incidental observation for spike B (GOK-127, GOK-142).**
   - Claude Code 2.1.296 first sent `server/discover` (id `server-discover-probe-1`, `_meta["io.modelcontextprotocol/protocolVersion"] = "2026-07-28"`).
   - After the stub's method-not-found error, it sent `initialize` with `protocolVersion: "2025-11-25"`, accepted the stub's `2025-06-18` answer, and sent `tools/list`.

## Fixtures added (seam 2)

All are under `test/fixtures/claude-code/`, with provenance and sanitizing notes in each folder's README. `test/spikes/claude-skills-chores.test.ts` encodes the verified behaviour against them.

- `hook-payloads/pre-tool-use-chore-subagent.json`: the forked subagent's `PreToolUse` (C1).
- `hook-payloads/pre-tool-use-general-purpose-subagent.json`, `hook-payloads/pre-tool-use-main-context.json`: the two contrasts.
- `hook-payloads/subagent-start-chore-subagent.json`, `hook-payloads/session-start-startup.json`.
- `meta/tools-call-chore-subagent.json`: the `tools/call` paired with the C1 payload by tool-use id.
- `transcripts/stub-match-read-tool.jsonl`, `transcripts/stub-match-shell-read.jsonl`: a stub match followed by a read of the copy (P2).
- `transcripts/chore-fork/…`: the main session plus the `grimoire-chores` subagent transcript and its `.meta.json` (C1, C2).

## Limits of this evidence

- All runs were headless (`-p`). Interactive sessions weren't driven. The documented differences are covered above:
  - a forked skill backgrounds in interactive sessions (covered by the `run_in_background` control);
  - project allow rules apply after the trust dialog.
- P2 used one skill with a sharp description, in a listing of about 80 skills. It shows that the mechanism works, not how well matching holds up across 8 overlapping evolved skills (ADR 0002's open question).
