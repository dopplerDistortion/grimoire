# Spike E: Codex MCP, hooks and transcripts (GOK-130)

*Run on 2026-10-11 against Codex CLI 0.162.1 (`@openai/codex`, native `x86_64-pc-windows-msvc` build) on Windows 11 Pro 10.0.26200, Node 24.21.0. Spec §22 items P1 (Codex half), T4, T6, R2, P3 and P4, plus B2, P7 and R4 (Codex half), added by the advisor ruling below.*

> **Codex was not logged in. Every model turn was scripted; nothing else was.**
>
> **The situation.** `codex login status` printed "Not logged in" throughout, and the advisor ruled (2026-10-11) that no Codex login will happen during this build.
>
> **What ran instead.** As the ruling directs, every **model turn** was scripted by a small local stand-in for the OpenAI Responses API (`fake-responses.mjs`), wired in as a custom model provider (`wire_api = "responses"`, no auth). It lived in a throwaway `CODEX_HOME`, so the user's `~/.codex` was never read or written.
>
> **What was real.** Everything else ran in the real Codex 0.162.1 binary: the MCP client, tool routing and truncation, hooks and their trust, rollout writing, subagents, compaction, archiving and the exec sandbox. Only the model's decisions were scripted.
>
> **Verdict label:** "confirmed (real Codex 0.162.1, scripted model)".
>
> **Fallbacks taken:** none of this spike's items needed its documented fallback. Per the ruling, P2, C4 and P5 (spike F's items) stay **"unverifiable: fallback applies"** and were not exercised here.
>
> **Fixtures** from these runs are marked "captured under a scripted model".
>
> **What a ChatGPT login would still add (not verified here):**
> - **Remote compaction.** The OpenAI provider compacts remotely ("remote compaction v2"), so its `compacted` line can carry encrypted compaction items. A custom provider compacts locally. The line type and its neighbours are the same.
> - **Real reasoning items.** These are encrypted `reasoning` items in the rollout; the reader drops reasoning anyway.
> - **Real model behaviour.** Notably, whether a real model calls `tool_search` before using grimoire's tools (see P1).
>
> The model slug was `gpt-5.5`, which matches Codex's bundled catalog entry, as a ChatGPT login would. A slug missing from the catalog changes the truncation (see P1).

## Verdicts

Every "Confirmed" below means **confirmed (real Codex 0.162.1, scripted model)**.

| Item | Verdict | In one line |
| -- | -- | -- |
| P1 (Codex half) | **Confirmed** | Codex initializes the bundled `serveStdio` probe at 2025-06-18, lists and calls tools, starts one server process per thread, and gives the model `structuredContent` (never the text block). Its own cut is about 12k tokens (~48,000 chars), so grimoire's 24 KB result arrives whole. |
| T4 | **Confirmed** | A `spawn_agent` subagent thread writes its own rollout, linked to the root by `session_meta.session_id` and `source.subagent.thread_spawn.parent_thread_id`. |
| T6 | **Confirmed** | Every Codex `tools/call` carries `_meta.callId`, `sessionId` (root thread) and `threadId` (the calling thread). `callId` equals the `call_id` of the namespaced `function_call` in that thread's rollout. |
| R2 | **Confirmed** | `node -e "<bootstrap>" hook session-start` (with or without `--`) ran unchanged under PowerShell 5.1 and pwsh 7.6, both through real Codex, and under `cmd /c "…"` and `sh -c`. No `command_windows` copy is needed. |
| P3 | **Confirmed** | Codex runs hooks **unsandboxed**. The SessionStart hook wrote `.agents/skills/grimoire-*`, `.grimoire/skills/` and `<git-common-dir>/grimoire/` under the default `codex exec` sandbox (read-only), from a main checkout and from a linked worktree. |
| P4 | **Confirmed** | Trust is per user (`$CODEX_HOME/config.toml`), per declaring file (absolute path), per group position and per handler position, plus a hash of the definition. A linked worktree runs the main checkout's `.codex/config.toml` hooks, under the main checkout's trust key. |
| B2 | **Confirmed** | A skill folder written mid-session (here by the SessionStart hook) is listed from the thread's **second** turn, never in the turn that wrote it. |
| P7 | **Confirmed**, for the runner's tool-free turn | The runner's exact invocation (read-only, `--output-schema`, `-o`, bundle on stdin) completes on native Windows without `prefer_mxc`. Every shell command is refused there, reads included; `prefer_mxc` turns that into real read-only. |
| R4 (Codex half) | **Confirmed** | A detached, unref'd child spawned through `exec_command` outlived the command and Codex, and was never killed. `codex exec` waited for it before exiting. |
| P2, C4, P5 | **Unverifiable: fallback applies** (advisor ruling) | Spike F's items; not exercised here. |

## Environment

- **Codex:** `codex-cli 0.162.1`, installed with npm (`@openai/codex` plus `@openai/codex-win32-x64`), **not logged in**. Source read at tag `rust-v0.162.1` (`092d3acd`).
- **Throwaway `CODEX_HOME` per run.** Its `config.toml` held:
  - `model = "gpt-5.5"`, `model_provider = "fake"`;
  - `[model_providers.fake]` with `base_url = "http://127.0.0.1:<port>/v1"` and `wire_api = "responses"`;
  - `[projects.'<repo>'] trust_level = "trusted"`;
  - `[mcp_servers.probe]`: spike B's bundled `serveStdio` probe (`test/spikes/mcp-dual-era/probe-server.ts`).
- **Shells:**
  - Windows PowerShell 5.1 (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  - PowerShell 7.6.6 (the official `win-x64` zip, SHA-256 checked against the release's published hash);
  - `cmd.exe`;
  - Git for Windows' `sh.exe`.
- **Repos:** throwaway git repos under `%TEMP%`. Codex ran in `codex exec` (non-interactive), or through `codex app-server` over stdio where a run needed an API the exec CLI lacks: legacy history mode, two turns in one thread, archive, compress, hook listing and trust.

## How to reproduce

The kit lives in `test/spikes/codex-mcp-hooks-transcripts/`. It is Git Bash only, because it uses `cygpath`, and nothing in it touches `~/.codex`.

**The harness: `run.sh`.** Run it as `SPIKE_DIR=<scratch> run.sh <run> '<prompt>' [extra.toml] [-- codex exec args]`. Each run builds a fresh `CODEX_HOME` and starts the stand-in. It drives `codex exec`, or `appserver-turn.mjs` when `DRIVER=appserver`.

**The scripted model: `fake-responses.mjs`.**
- It reads a plan embedded in the prompt, for example `PLAN: [{"search":"probe echo"},{"call":"echo","ns":"mcp__probe","args":{…}},{"say":"done"}]`.
- Each Responses request plays the next step for its (thread, plan), using Codex's own test SSE shapes.
- A request whose `x-codex-turn-metadata.request_kind` is `compaction` gets a summary.
- It logs every request Codex sent to `requests.jsonl`, which shows exactly what the model would have seen.

**Scenario plans.**
- `plan-a.mjs`: an MCP call, a shell read of a skill copy, a `git commit`, a failing command, `apply_patch`, and a long-running command polled with `write_stdin`.
- `plan-t4.mjs`: spawn a subagent, wait, then call the probe from both threads.

**Probes and capture scripts.**
- `extra-mcp.mjs`: a raw JSON-RPC MCP server. Its `huge`, `fail` and `textonly` tools return an uncut N-byte result, an `isError` envelope and a text-only result. `writeish` carries grimoire's write annotations. It dumps its spawn env.
- `hooks/bootstrap.txt`: spike A's 485-character bootstrap stand-in.
- `hooks/launcher.cjs`: logs what the hook process saw, makes the P3 writes, and prints a line or JSON.
- `hooks/mkrepo.mjs`: creates a repo whose committed `.codex/config.toml` ends in a grimoire-shaped `[[hooks.SessionStart]]` block.
- `hooks/r2-direct.mjs`: R2 under four shells.
- `hooks/hooks-rpc.mjs`: `hooks/list` and the `/hooks` trust write over the app-server.
- `appserver-rpc.mjs`: one-off RPCs such as `thread/archive` and `rollout/compress`.
- `r4-spawn.cjs`: the R4 detached-child probe.
- `rsum.mjs`: summarizes a rollout.
- `sanitize.mjs`: makes fixtures.

**Encoded verdicts.** `test/spikes/codex-mcp-hooks-transcripts.test.ts` (27 tests, in `npm test`) checks every verdict against the fixtures.

## P1 (Codex half): the bundled server under Codex

**Handshake and process scope.**
- Codex sent `initialize` at `2025-06-18`, then `notifications/initialized`, then `tools/list`, as spike B saw. The probe answered at 2025-06-18.
- Codex starts **one MCP server process per thread**: the subagent run started two (`codex/mcp/subagent/starts.jsonl`). This confirms §8.
- Optional servers get a shared 1 s startup grace (`mcp_optional_startup_grace_ms`, default 1000). A server still starting after that is left out of that model step and joins on a later one. That is the R7 premise.

**How the model reaches the tools.** MCP tools are Responses API *namespace* tools: namespace `mcp__<server>`, function name = the raw MCP tool name.
- When the model's catalog entry supports search (gpt-5.x does), Codex **defers** every MCP tool behind a `tool_search` tool. The model must call `tool_search` first; its output lists `{type: "namespace", name: "mcp__grimoire", description: <server instructions>, tools: [...]}`.
- The `tool_search` description itself lists each source as `- <server>: <server instructions>`, under a 512 KiB budget, so **the server instructions reach the model whole** before any tool is loaded.
- The function call is `{"type":"function_call","namespace":"mcp__probe","name":"echo",…}`. Hooks and logs see the flat name `mcp__probe__echo`.
- Names are sanitized to `[A-Za-z0-9_]`.

**What the model sees** (the `function_call_output` Codex sent, and the same text in the rollout):

| Server result | Model input |
| -- | -- |
| `structuredContent` + text block (`which`) | `"Wall time: 0.0056 seconds\nOutput:\n{\"seen_via\":\"structuredContent\"}"`: **only `structuredContent`**, compact JSON, behind a header |
| text block only | `[{"type":"input_text","text":"Wall time: … seconds\nOutput:"},{"type":"input_text","text":"plain text only"}]` |
| `isError: true` + `structuredContent` | the `structuredContent` text, as above (`{"error":{…}}`); the call is marked `failed` in the rollout's `McpToolCall` item |
| JSON-RPC error (handler threw) | `[{header item},{"type":"input_text","text":"tool call error: tool call failed for \`probe/boom\`\n\nCaused by:\n    Mcp error: -32603: probe exploded"}]` |

So, as in Claude Code, the model sees exactly one copy of a grimoire result.

**Truncation.** Codex middle-truncates every tool output to the model's truncation policy × 1.2, keeping the head and the tail.
- **gpt-5.x** (bundled catalog, `tokens: 10000`): about 12,000 tokens ≈ **48,000 characters**.
  - `huge` results of 30,000 and 45,000 bytes arrived whole.
  - Results of 60,000 and 120,000 bytes came back as 48,020 characters: rows 0–129, the marker, then the real tail.
- **The marker** is `…N tokens truncated…`. N read `7` in every case, even when thousands of tokens were removed, so don't trust the number.
- **A slug missing from Codex's catalog** (tested: `-m unknown-model-x`) falls back to `bytes: 10000` → about **12,000 characters**. A 30,000-byte result came back as 12,020 characters.
- **Grimoire's 24 KB cut** (spike B's `big`: 24,482 bytes, `truncated: true`, `cursor: "137"`) arrived byte-whole under gpt-5.5, with 2× headroom.
- **Where the rollout stores it.** The rollout's `function_call_output` holds the truncated text. Paginated `item_completed` `McpToolCall.result` is capped at 64 KiB; legacy `mcp_tool_call_end` at 1 MiB.

**Approval in `codex exec`.** `codex exec` forces approval policy `never`. Under the default per-server mode `auto`:
- a tool with `readOnlyHint: true` runs;
- a tool with `destructiveHint: false` **and** `openWorldHint: false` (grimoire's writes) runs (`writeish`);
- a tool with no annotations is refused: "MCP tool call requires approval, but approval policy is never".

`default_tools_approval_mode = "approve"` (spec §11's Codex block) is a valid value and made the unannotated tools run.

## T6: Codex's per-call `_meta`

A real `tools/call` (`codex/meta/tools-call.json`):

```json
"_meta": {
  "callId": "call_2_0",
  "x-codex-turn-metadata": { "session_id": "…", "thread_id": "…", "turn_id": "…", "model": "gpt-5.5",
    "thread_source": "user", "sandbox_mode": "danger-full-access", "workspaces": { "C:\\Users\\USER\\…": {…} },
    "codex_version": "0.162.1", … },
  "threadId": "01a12946-7d23-…", "sessionId": "01a12946-7d23-…",
  "windowId": "01a12946-7d23-…:0", "itemId": "fc_…", "progressToken": 1
}
```

- **The keys.** `callId`, `threadId` and `sessionId` are camelCase and **always present**. No feature flag gates them (`core/src/mcp_tool_call.rs`). The same path serves exec, the TUI and the app-server.
- **What the ids name.**
  - `sessionId` is the root thread's id, for the root and every descendant thread.
  - `threadId` is the calling thread.
  - `callId` is the model's `function_call.call_id`.
  - Codex also sends `windowId` (`<thread>:<compaction window>`), `itemId` (the function_call item id) and an rmcp-added `progressToken`.
- **A subagent call** (`codex/meta/tools-call-subagent.json`) has `threadId ≠ sessionId`. Its turn metadata adds `parent_thread_id` (= `sessionId`), `subagent_kind` and `thread_source: "subagent"`.
- **Exact matching works.** `callId` is the `call_id` of a `function_call` with `namespace: "mcp__probe"` and the called `name`, in the rollout whose `session_meta.id` equals `threadId` (asserted for a root and a subagent call).
- **Paths inside.** `x-codex-turn-metadata` holds absolute workspace paths and the model. Never copy it into trailers or records.

## T4: subagent threads

A V1 `spawn_agent` (namespace `multi_agent_v1`; tools `spawn_agent`, `send_input`, `wait_agent`, `close_agent`, `resume_agent`) created a second rollout file in the same `sessions/YYYY/MM/DD/` folder (`codex/transcripts/subagent/`).

**The child's `session_meta`:**
- `id` is the child thread and `session_id` is the root thread;
- `parent_thread_id` is the root;
- `thread_source` is `"subagent"`;
- `source` is `{"subagent":{"thread_spawn":{"parent_thread_id":…,"depth":1,"agent_nickname":"…","agent_role":null}}}`, with `agent_nickname` also at top level and `multi_agent_version: "v1"`.

**The root records the spawn and its result:**
- `function_call` `spawn_agent`, whose output is `{"agent_id":"<child thread id>","nickname":"…"}`;
- `function_call` `wait_agent`, whose output is `{"status":{"<child>":{"completed":"<child's last message>"}},"timed_out":false}`;
- a user-role `<subagent_notification>{"agent_path":…,"status":…}</subagent_notification>` message;
- in paginated mode only, `item_completed` `CollabAgentToolCall` items.

**What the child's own process does.** The child thread ran its own MCP server process and its calls carry its own `threadId`. It did **not** run the SessionStart hook: only the root's first turn does.

V2 multi-agent (`multi_agent_v2`, default off) uses namespace `collaboration` and `inter_agent_communication` lines instead. The 0.162.1 defaults give V1.

## R2: the Codex hook string under four shells

**How Codex runs a hook command** (`hooks/src/engine/command_runner.rs`, `core/src/shell.rs`). The command goes through the session's shell:
- **Windows:** `pwsh` (on PATH, or `C:\Program Files\PowerShell\7\pwsh.exe`), else `powershell` (always found through its System32 path). It runs as `[shell, "-NoProfile", "-Command", <command>]`, with standard argument quoting. `cmd.exe /c "<command>"` (a raw argument) is only the last-resort fallback.
- **Unix:** `[shell, "-c", <command>]`.
- **Process setup:** cwd is the session cwd. The env is the Codex process's environment snapshot. Stdin is the JSON payload.
- **`command_windows`:** exists in the schema (camelCase `commandWindows`, alias `command_windows`), and replaces `command` on Windows when set.

**Tested string:** `node -e "<485-char bootstrap>" hook session-start`, and the same with `--` before `hook`.

| Shell | How it ran | Result |
| -- | -- | -- |
| Windows PowerShell 5.1 | real Codex (no pwsh on PATH), and direct | ran; argv `[hook, session-start]`; bootstrap byte-identical (SHA-256 match); stdin intact |
| PowerShell 7.6.6 | real Codex (pwsh first on PATH), and direct | same |
| cmd | direct, as Codex's fallback: `cmd.exe /c "<command>"` | same |
| sh | direct, `sh -c <command>` (Git for Windows' sh, standing in for Unix Codex) | same |

All eight combinations, both variants under each of the four shells, gave the same result. The parent process (`powershell.exe`, `pwsh.exe`, `cmd.exe`, `sh.exe`) was logged each time. `--` is harmless under all four, so Codex can use the same argument shape as Claude Code's entries (spike A's R3).

## P3: what the SessionStart hook process can write

- **Hooks run unsandboxed.** The runner spawns the shell directly (a Windows job object, for timeouts only), and the `hooks` crate never mentions the sandbox. The TUI tells the user that hooks "can run outside the sandbox after you trust them".
- **The writes, verified** under `codex exec`'s default `sandbox: read-only`, with approval `never`:

  | Target | Result |
  | -- | -- |
  | `.agents/skills/grimoire-p3-probe/` | written |
  | `.grimoire/skills/p3-probe/` | written |
  | `<git-common-dir>/grimoire/p3-marker.txt` | written |

  The same writes landed from a linked worktree: the worktree got the skill folders, and the main `.git/grimoire/` got the marker.
- **When it runs.**
  - The hook runs at the start of a root thread's **first turn**, not at process start.
  - Sources are `startup | resume | clear | compact | fork`. A resumed session fired again with `source: "resume"`.
  - Subagent threads don't fire it.
- **Payload.** Fields are `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode` (`bypassPermissions` under approval `never`, else `default`) and `source`.
  - On resume, `transcript_path` came in verbatim extended form: `\\?\C:\Users\…\rollout-….jsonl`.
- **Output** (exit 0):
  - plain stdout text becomes a **developer-role message** the model sees;
  - JSON must match Codex's strict schema (`hookSpecificOutput.additionalContext`, `systemMessage`, `continue`, `stopReason`).
  - **Claude Code's shape with `"reloadSkills": true` made the hook fail** ("SessionStart Failed"), and the line never reached the model.
  - The default timeout is 600 s when `timeout` is omitted.
- **When the written skills show up:** see B2. They appear from the thread's second turn.

## P4: hook trust and linked worktrees

**Where trust lives** (`config/src/hook_config.rs`, `hooks/src/engine/discovery.rs`, `hooks/src/lib.rs`).

- Only in the **user's** `$CODEX_HOME/config.toml`. Codex reads trust state only from the user layer and `-c` flags, so a project can't trust its own hooks. The trust write looks like this:

  ```toml
  [hooks.state.'C:\Users\USER\…\repo\.codex\config.toml:session_start:0:0']
  trusted_hash = "sha256:907a8003…"
  ```

- **The key** is `<declaring file's absolute path>:<event>:<group index>:<handler index>`. It holds no user name, because the file it lives in is per user.
- **The hash** is `sha256:` over compact JSON, keys sorted, of `{event_name: "session_start", matcher?, hooks: [{type, command, timeout, async, statusMessage?, …}]}`. It uses the resolved command (the Windows variant on Windows) and the timeout, defaulting to 600; it does **not** use the file path. Grimoire's group hashes to `sha256:907a800335f5…` (the full value is in the test).
- **Exec skips untrusted hooks silently.** `codex exec` runs an untrusted or modified hook not at all, and prints nothing. The TUI shows "Hooks need review" at startup, and `/hooks` writes the trust through `config/batchWrite` on `hooks.state`; `hooks-rpc.mjs` does the same over the app-server. `--dangerously-bypass-hook-trust` overrides trust for one invocation only, and can't come from config.
- **Projects must be trusted first.** An untrusted project's `.codex/` layer, hooks and MCP servers included, isn't loaded at all.

**What each change did** (captured `hooks/list` responses in `codex/hook-trust/`):

| Change | Grimoire's hook |
| -- | -- |
| Fresh user (`CODEX_HOME`) | `untrusted`: skipped |
| Trusted through `/hooks`' write | `trusted`: ran |
| A group inserted **before** grimoire's | moves to key `…:1:0`; same hash, but `untrusted`. The inserted group took `…:0:0` and shows `modified`. Skipped. |
| `timeout` 10 → 11, same position | same key, new hash: `modified`. Skipped. |
| Restored to the original | `trusted` again: ran |
| A second clone of the repo | same hash, different key (path): `untrusted` |
| Another user | `untrusted` |
| From a linked worktree | key and `sourcePath` are the **main checkout's** file: `trusted`, ran |

**Linked worktrees.**
- Codex resolves the main checkout from the worktree's `gitdir:` / `commondir` (`git-utils/src/trust.rs`). It replaces the worktree's own `hooks` table with the main checkout's `.codex/config.toml` hooks, read at the same relative directory.
- An uncommitted hook edited into the worktree's own `.codex/config.toml` did **not** run.
- Every **other** key comes from the worktree's own file. A `[mcp_servers.wtonly]` defined only in the worktree's file started.
- **Gotcha:** the main checkout's hooks load only if the worktree has its own `.codex/` directory at that level.
  - With no `.codex/` in the worktree, no project hooks ran.
  - With an empty `.codex/`, the main checkout's ran.
  - A committed `.codex/config.toml` always provides the folder, so grimoire's installed branches are fine.
- **Project trust.** Codex checks the directory, the worktree root, then the main checkout root, so a worktree inherits the main checkout's project trust.

## B2: skill folders written mid-session

Codex builds the skill list for a turn's model input from `.agents/skills/*/SKILL.md` (the `<skills_instructions>` developer message). On a SessionStart run, the hook fires only after that list is built for the first turn.

- **First turn, `codex exec`.** The hook wrote `.agents/skills/grimoire-fresh/SKILL.md`. The first request's input did **not** mention `grimoire-fresh`.
- **Two turns on one thread.** These ran through `codex app-server`, with the hook trusted through `/hooks`' write. In turn 1 the hook wrote `grimoire-midsession`.
  - Turn 1's request did not list it.
  - **Turn 2's request did.**
  - The hook's session line reached the model in both turns.
- **A new process** (`codex exec resume --last`) listed the skill from the previous run in its first turn, but not the one its own hook had just written.
- **Bad skill folders are logged, not shown.** A `SKILL.md` without YAML frontmatter is logged as "failed to load skill … missing YAML frontmatter" and left out.

So the spec's "Codex sees skills written that session from its second turn" holds, and the stub's `skill_read` line covers turn 1.

## P7: read-only `codex exec` on native Windows

The runner's Codex invocation from spec §16 was run verbatim, with the stand-in passed by `-c` because `--ignore-user-config` skips `config.toml`. Its stdout streams are in `codex/exec-json/`.

**The runner's own turn.** A served bundle on stdin, no prompt argument, a fresh temp directory outside any repo, an output schema of `{summary: string}`:
- `--output-schema` reached the model as `text.format = {type: "json_schema", strict: true, schema}`;
- the model's final message landed in `-o`, the exit code was 0, and `--ephemeral` wrote no session file;
- the stdout events were `thread.started`, `turn.started`, `item.completed` (`agent_message`), `turn.completed`.

**Shell under `--sandbox read-only`:**

| | `Get-Content input.txt` | `Set-Content written.txt x` |
| -- | -- | -- |
| default (no `prefer_mxc`) | refused before running ("blocked by policy") | refused ("blocked by policy") |
| `--enable prefer_mxc` | ran: exit 0, file text returned | ran and failed: "Access to the path … is denied", exit 1 |

With `prefer_mxc`, the turn also emits a warning item (`type: "error"`, "Under-development features enabled: prefer_mxc"), which `suppress_unstable_features_warning = true` silences.

**Verdict.** The runner's turn, which needs no tools, works without `prefer_mxc`. A run needing shell reads would take the fallback (`prefer_mxc`).

**"No tools" isn't quite true.** Codex still offers `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `request_user_input`, the goal tools, `tool_search` and the hosted `web_search`.
- Read-only blocks the shell ones.
- `web_search` runs on the provider's side. `-c web_search="disabled"` removed it from the request (verified).

## R4 (Codex half): a detached child after the shell tool returns

`exec_command` ran `node r4-spawn.cjs <log> <delay>` under `-s danger-full-access`. `r4-spawn.cjs` spawns itself as a child with `detached: true, stdio: 'ignore', windowsHide: true` plus `unref()`, the way `sync --background` would, and exits.

- **The command returned at once.** The command's output was `Process exited with code 0` after 0.11 s.
- **The child survived.** It logged "started" at once and "finished" after its full delay: 8 s in one run, 25 s in another. It was never killed.
- **`codex exec` waited for it.** The model's turn ended right away, but the process exited only when the child did: 26 s for the 25 s child. A background sync therefore keeps a headless `codex exec` alive until it finishes. Grimoire's sync is short, so that cost is small. In the TUI and app-server, the session outlives it anyway.

## Codex transcripts: what the reader must handle (GOK-137)

### Roots, names and files

- **Where files live.**
  - Live sessions are at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread uuid>.jsonl`. The folder date and the file timestamp are **local time**; each line's `timestamp` is UTC with milliseconds.
  - A thread reverted with `thread/revert` gets `…-<uuid>_<rollout id>.jsonl`.
  - The file isn't created until the first user input.
- **Archiving** (`codex archive <id>`, app-server `thread/archive`, TUI `/archive`) **moves** the file, under the same name, into the flat folder `$CODEX_HOME/archived_sessions/`. Spawned descendants are archived with the parent. Archiving doesn't compress.
- **Compression.**
  - **What does it.** A separate maintenance pass compresses rollouts whose **mtime is at least 7 days old**, in both `sessions/` and `archived_sessions/`. It runs at startup behind the default-off feature `local_thread_store_compression`, or on demand with the app-server's `rollout/compress` RPC. The result is `….jsonl.zst` (zstd level 3), and the plain file is deleted.
  - **Reading.** When both a plain and a `.zst` file exist, Codex reads the plain one.
  - **Before an append** (a resume), Codex decompresses the file back to `.jsonl`.
  - **Verified:** a session was archived, back-dated, then `rollout/compress`ed. Node's `zlib.zstdDecompressSync` decoded Codex's frame byte-identically to the pre-archive file.
- **Torn lines.**
  - **How Codex writes.** Lines are written as they happen: one `write_all` plus `flush` per line, with no fsync.
  - **Reopening.** If the file doesn't end in a newline, Codex appends `\n` before writing again, so a torn fragment can end up **mid-file** as an unparsable line.
  - **What the reader does:** skip and count any unparsable line, not only the last one.

### The two history modes

There are exactly two: `session_meta.history_mode` is `"legacy"` or `"paginated"`, and a missing field means legacy.

- **Paginated is the default for every new non-ephemeral local thread in 0.162.1**, both `codex exec` and the TUI. Legacy survives in older files, in forks of legacy threads, and wherever an app-server client asks for it (`thread/start {historyMode: "legacy"}`). The legacy fixture was made that way.
- **`codex migrate-rollouts --apply`** converts legacy to paginated in place.
- **The JSONL file is canonical in both modes.** Paginated mode also projects it into SQLite (`state_5.sqlite`, `thread_history_1.sqlite`), a rebuildable view the reader never needs.

| | Paginated | Legacy |
| -- | -- | -- |
| `ordinal` on each line | yes, consecutive from 0 (from `history_base.end_ordinal_exclusive` in a referenced fork) | **never**: use the line index as the reach ordinal |
| Structured items | `event_msg` `item_completed` with a PascalCase `item.type`: `UserMessage`, `AgentMessage`, `McpToolCall`, `CommandExecution`, `FileChange`, `CollabAgentToolCall`, `ContextCompaction`, `Reasoning`, … | `event_msg` `user_message`, `agent_message`, `mcp_tool_call_end`, `patch_apply_end`, `context_compacted`, `agent_reasoning` |
| Structured exit code | `CommandExecution {status: "completed" or "failed", exit_code, process_id, aggregated_output (≤64 KiB), parsed_cmd, duration}` | **none**: only the output text |
| Both | `session_meta`, `turn_context`, `world_state`, `token_usage_record`, `response_item` (`message`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `tool_search_call`, `tool_search_output`, `reasoning`), `compacted`, `event_msg` (`task_started`, `task_complete`, `token_count`, `thread_settings_applied`, `turn_aborted`, …) | same |

Neither mode persists `exec_command_begin/end`, `mcp_tool_call_begin` or `collab_*` events.

### Outputs, headers and failures

`function_call_output.output` is a **string or an array of content items** (`input_text` and others). MCP errors and text-only results are arrays whose first item is the header.

**Headers to strip.**
- **MCP:** `Wall time: 0.0076 seconds\nOutput:\n`.
- **Unified exec**, for `exec_command` and `write_stdin`: `Chunk ID: 1a2b3c\nWall time: 0.0000 seconds\n` + (`Process exited with code N` | `Process running with session ID N`) + `\nOriginal token count: N\nOutput:\n`.
- **apply_patch** (a `custom_tool_call_output`): `Exit code: 0\nWall time: 0 seconds\nOutput:\n`. In 0.162.1, "Exit code: N" appears **only** here. There is no classic `shell` tool: `exec_command` and `write_stdin` are the only shell tools, and they are on by default on Windows.
- **Truncation marks inside the body:** `…N tokens truncated…` / `…N chars truncated…` (N unreliable), or `Warning: truncated output (original token count: N)` at the top of shell output.

**Failures.**
- **Paginated:** `CommandExecution.status` / `exit_code` first, then the text.
- **Legacy:** only "Process exited with code N".
- **PowerShell flattens native exit codes.** `node -e "process.exit(3)"` run through Codex's PowerShell came back as `Process exited with code 1` and `exit_code: 1`. That is still a failure, but the number isn't the program's.

**Long-running commands.**
- **The first output.** `exec_command` returns `Process running with session ID 10767`, with no exit line. Windows clamps `yield_time_ms` to 10–30 s.
- **Later polls.** A later `write_stdin {session_id: 10767}` output carries `Process exited with code 0`.
- **The paginated record.** One `CommandExecution` item lands at the very end, with `process_id: "10767"`, `id` = the `exec_command` call id, the final `exit_code` and the whole output.

**Facts helpers.**
- `CommandExecution.parsed_cmd` tags reads: `{"type":"read","path":".grimoire/skills/probe/SKILL.md"}`.
- Git's creation line arrives verbatim: `[master 76c482a] Probe commit`.

### Compaction

**Lines in order** (`codex/transcripts/compaction/`, local compaction):
1. A **`response_item` assistant `message` holding the summarizer's reply** (the compaction prompt itself is not recorded). It is not visible assistant text: the reader must fold it into the compaction step, because it is the last response item before `compacted`.
2. `compacted` = `{message: "Another language model started… <summary>", replacement_history: [the kept messages], window_number, window_id, …}`.
3. `world_state`, `turn_context` and `event_msg` `thread_settings_applied`.
4. In paginated mode, `item_completed` `ContextCompaction`; in legacy, `event_msg` `context_compacted`.

**What changes under a login.** Remote compaction, used by the OpenAI provider under a ChatGPT login, puts `{"type":"compaction","encrypted_content":…}` items into `replacement_history` instead of a readable summary.

### Forks

- **Legacy:** a fork copies the parent's items, **including the parent's `session_meta` line**, after its own.
- **Paginated:** `thread/fork` copies nothing. The new `session_meta` carries `history_base {thread_id, end_ordinal_exclusive, end_byte_offset}` and `forked_from_ordinal_exclusive`.
- **A subagent spawned with `fork_context`** copies the parent context. `subagent_history_start_ordinal` marks where its own records begin.

These come from the source and were not exercised. The T5 detection rules for Codex should key on these fields.

## Other findings that change downstream work

1. **`hook session-start` must speak each client's output format** (GOK-144, GOK-157).
   - Claude Code needs JSON with `reloadSkills`; Codex fails the hook on that JSON and drops the line.
   - The verb must print plain text, or Codex's `hookSpecificOutput.additionalContext` JSON, when Codex runs it.
   - **Telling the clients apart:** Claude Code sets `CLAUDECODE` / `CLAUDE_PROJECT_DIR` in the hook env, and Codex's payload has `model` and `permission_mode`. An explicit marker in the hook args is cleanest, but the args are part of the frozen bootstrap contract.
2. **Grimoire's tools are deferred behind `tool_search` in Codex** (GOK-142). The server instructions are what the model reads before searching, and the tool names and descriptions are what BM25 matches. Name grimoire and its issue operations plainly in both.
3. **An unknown model slug gets a 12,000-character cut** (GOK-142).
   - For catalog models the 24 KB budget fits with 2× headroom.
   - Since Codex keeps the head and the tail, end every cut result with `truncated` and `cursor`, so a client-side middle cut still shows them.
   - The per-tool override `[mcp_servers.grimoire.tools.<tool>] output_token_limit` exists if ever needed.
4. **The Codex MCP server's spawn env holds no `CODEX_*` variables**, only about 20 OS variables plus the configured `env`. The spec's `env_vars` list is required (GOK-146). Identity must come from per-call `_meta`.
5. **Codex shell commands get `CODEX_SESSION_ID` (root thread), `CODEX_THREAD_ID` and `CODEX_VERSION`** (GOK-147). These are the CLI-call evidence for "the session from the shell env". In a root thread both ids are equal.
6. **Exact Codex approval state is computable** (GOK-161, GOK-171).
   - Grimoire can reproduce Codex's trust hash (the recipe is above and in the test) and read `hooks.state` from `$CODEX_HOME/config.toml`.
   - With both, `status` and `doctor` can report "approved", "needs approval" or "modified" exactly, rather than inferring from hash changes.
   - The recipe is Codex-internal, so keep the "announce on change" path as the fallback.
7. **Uninstall shifts only the groups after grimoire's.** Grimoire's group is appended last. Removing it shifts the keys of groups **after** it (their index drops by one), so those need re-approval. Groups before it keep their trust.

## What each downstream ticket must build

- **GOK-137 (Codex reader):** everything in "Codex transcripts" above. In particular:
  - both modes, with the line index as the legacy ordinal;
  - string-or-array outputs;
  - all four headers;
  - structured exit codes only in paginated mode;
  - the long-running pattern;
  - the compaction summary message folded into the compaction step;
  - mid-file torn lines;
  - `\\?\` paths;
  - `archived_sessions/` and `.jsonl.zst`.

  MCP calls are matched by `namespace` + `name` and `call_id`. T4 confirmed: cut a subagent's own file.
- **GOK-142 (MCP server):**
  - no `initialize` shim;
  - results as planned (Codex shows `structuredContent` only, with a header);
  - put `truncated` / `cursor` last in a cut result;
  - write the instructions and tool descriptions for `tool_search`;
  - keep the write annotations exactly (`destructiveHint: false`, `openWorldHint: false`), because Codex auto-approves on them.
- **GOK-144 (bootstrap):**
  - R2 confirmed: no `command_windows`;
  - the Codex hook string is `node -e "<bootstrap>" [--] hook session-start`, with the hook's cwd = the session cwd;
  - the client-specific SessionStart output (finding 1).
- **GOK-147 (identity):**
  - T6 confirmed;
  - session = `_meta.sessionId`, context = `_meta.threadId`, call = `_meta.callId` (camelCase, top level), not the snake_case copies in `x-codex-turn-metadata`;
  - CLI calls use `CODEX_SESSION_ID` / `CODEX_THREAD_ID` (finding 5);
  - the T6 fallback stays only for a missing `callId`, which 0.162.1 never sends.
- **GOK-157 (fast path):**
  - P3 confirmed: the hook writes directly, so no upkeep fallback is needed for permissions;
  - Codex lists those skills from the thread's second turn;
  - output per finding 1.
- **GOK-139 (sync):** R4 confirmed for Codex: the detached `sync --background` child survives. Keep the sync-pending marker as the spec requires, and keep the child short, because `codex exec` waits for it.
- **GOK-167 (runner):**
  - P7 confirmed: no `prefer_mxc` is needed for the tool-free run;
  - add `-c web_search="disabled"` to the Codex invocation, because the hosted search tool is otherwise still offered;
  - `-o` and the `--json` events behave as fixtured.
- **GOK-161 (upgrade) / GOK-171 (uninstall):**
  - P4 confirmed: positions are real, so keep the position computation;
  - the position is grimoire's group index among `[[hooks.SessionStart]]` groups in the main checkout's `.codex/config.toml`; a sibling `.codex/hooks.json` is a separate declaring file with its own keys;
  - uninstall names the groups after grimoire's;
  - optionally use finding 6 for exact approval state;
  - re-approval is once per clone path per user;
  - worktrees share the main checkout's approval.

## Fixtures added

They live under `test/fixtures/codex/`; provenance and sanitizing are in each folder's README.

- `meta/tools-call.json`, `meta/tools-call-subagent.json`: real `tools/call` requests with Codex's `_meta`.
- `mcp/tools-call/`: wire traffic for `echo`, `big`, `which`, `boom` and two parallel calls.
- `mcp/subagent/`: two server processes, root and subagent calls.
- `transcripts/paginated/`, `transcripts/legacy/`: the same scenario in both history modes. It has an MCP call, one-shot and long-running unified exec, a failing command, a skill read, a git commit and `apply_patch`.
- `transcripts/subagent/`: root and child rollouts.
- `transcripts/compaction/`.
- `transcripts/mcp-results/`: what the model saw for each result shape.
- `transcripts/archived-zstd/archived_sessions/…jsonl.zst`: the paginated session, archived and compressed.
- `hook-payloads/session-start-startup.json`, `hook-payloads/session-start-resume.json`.
- `hook-trust/`: `hooks/list` responses for each P4 state, the project configs that produced them, and the `hooks.state` trust write.
- `exec-json/`: the runner's `codex exec --json` streams (P7), with the bundle on stdin and with the shell blocked or under `prefer_mxc`.
