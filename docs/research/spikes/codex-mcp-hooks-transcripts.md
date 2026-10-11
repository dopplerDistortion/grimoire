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
>
> **Only Codex 0.162.1 was run.** Where older versions matter (the `_meta` keys in T6), they were read from the source at tags `rust-v0.140.0`, `rust-v0.150.0` and `rust-v0.162.1`, and are marked as source-only.

**Review fix pass (same day).** An independent review led to more captures with the same kit: a legacy-mode compaction, a legacy root thread with a subagent, two turns on one thread, the truncation runs (now fixtured), the P7 refusal as the model saw it, a hook listing with mixed groups and handlers, a SessionStart run with Claude Code's real output shape, R4 with Codex killed early, and an archived session whose `.zst` is Codex's own frame. Those runs used `C:\gok130\` as the scratch folder, `TEMP` and `CODEX_HOME`, so their artifacts hold no user name. Corrections from that pass are folded into the sections below. Once the fixtures were extracted, both scratch folders (`%TEMP%\gok130\`, `C:\gok130\`) were deleted, so the raw captures named below no longer exist.

## Verdicts

Every "Confirmed" below means **confirmed (real Codex 0.162.1, scripted model)**.

| Item | Verdict | In one line |
| -- | -- | -- |
| P1 (Codex half) | **Confirmed** | Codex initializes the bundled `serveStdio` probe at 2025-06-18, lists and calls tools, starts one server process per thread (not per call or per turn), and gives the model `structuredContent` (never the text block). Its own cut keeps 48,000 chars for gpt-5.x (12,000 for an unknown slug), head and tail, so grimoire's 24 KB result arrives whole. |
| T4 | **Confirmed** | A `spawn_agent` subagent thread writes its own rollout, linked to the root by `session_meta.session_id` and `source.subagent.thread_spawn.parent_thread_id`. A legacy-mode root spawns a **paginated** child. |
| T6 | **Confirmed** for 0.162.1 | Every Codex 0.162.1 `tools/call` carries `_meta.callId`, `sessionId` (root thread) and `threadId` (the calling thread). `callId` equals the `call_id` of the namespaced `function_call` in that thread's rollout. Source-only: 0.150.0 sends `callId` and `threadId` but no top-level `sessionId`; 0.140.0 sends only `threadId`. Every version has `x-codex-turn-metadata.session_id`. |
| R2 | **Confirmed** | `node -e "<bootstrap>" hook session-start` (with or without `--`) ran unchanged under PowerShell 5.1 and pwsh 7.6, both through real Codex, and under `cmd /c "…"` and `sh -c`. No `command_windows` copy is needed. |
| P3 | **Confirmed** | Codex runs hooks **unsandboxed**. The SessionStart hook wrote `.agents/skills/grimoire-*`, `.grimoire/skills/` and `<git-common-dir>/grimoire/` under the default `codex exec` sandbox (read-only), from a main checkout and from a linked worktree. |
| P4 | **Confirmed** | Trust is per user (`$CODEX_HOME/config.toml`), per declaring file (absolute path), per group index among that event's groups and per handler index in the group, plus a hash of the definition. A linked worktree runs the main checkout's `.codex/config.toml` hooks, under the main checkout's trust key. |
| B2 | **Confirmed** | A skill folder written mid-session (here by the SessionStart hook) is listed from the thread's **second** turn, never in the turn that wrote it. |
| P7 | **Confirmed**, for the runner's tool-free turn | The runner's exact invocation (read-only, `--output-schema`, `-o`, bundle on stdin) completes on native Windows without `prefer_mxc`. Every shell command is refused there, reads included; `prefer_mxc` turns that into real read-only. |
| R4 (Codex half) | **Confirmed** under `-s danger-full-access` only | A detached, unref'd child spawned through `exec_command` outlived the command and was never killed. `codex exec` waited for it before exiting. When `codex.exe` was killed while it waited, the child still finished. Under sandboxes spike F (GOK-131) took the fallback. |
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
- **Repos:** throwaway git repos and run folders under `%TEMP%\gok130\` for the first pass, and under `C:\gok130\` (also `TEMP`) for the fix pass. Codex ran in `codex exec` (non-interactive), or through `codex app-server` over stdio where a run needed an API the exec CLI lacks: legacy history mode, two turns in one thread, archive, compress, hook listing and trust.

## How to reproduce

The kit lives in `test/spikes/codex-mcp-hooks-transcripts/`. It is Git Bash only, because it uses `cygpath`, and nothing in it touches `~/.codex`.

**The harness: `run.sh`.** Run it as `SPIKE_DIR=<scratch> run.sh <run> '<prompt>' [extra.toml] [-- codex exec args]`. Each run builds a fresh `CODEX_HOME` and starts the stand-in. It drives `codex exec`, or `appserver-turn.mjs` when `DRIVER=appserver` (`HISTORY=legacy|paginated`; a line `---TURN---` splits the prompt into turns of one thread). For example, the legacy compaction was `DRIVER=appserver HISTORY=legacy run.sh legacy-compact '<plan>\n---TURN---\n<plan>' config/compact.toml`.
- With `SPIKE_DIR` and `TEMP` both under a path without the user name (the fix pass used `C:\gok130`), the artifacts need no sanitizing, and a `.zst` keeps Codex's own frame.
- `SPIKE_DIR` holds raw, unsanitized captures; it is yours to delete afterwards. Nothing cleans it up.

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
- `hooks/launcher.cjs`: logs what the hook process saw, makes the P3 writes, and prints a line or JSON (`GRIMOIRE_PROBE_OUTPUT`: plain, `codex-json`, `claude-json`).
- `hooks/mkrepo.mjs`: creates a repo whose committed `.codex/config.toml` ends in a grimoire-shaped `[[hooks.SessionStart]]` block (`--groups-before N`, `--mixed-before` put other groups first).
- `hooks/r2-direct.mjs`: R2 under four shells.
- `hooks/hooks-rpc.mjs`: `hooks/list` and the `/hooks` trust write over the app-server.
- `appserver-rpc.mjs`: one-off RPCs such as `thread/archive` and `rollout/compress`.
- `r4-spawn.cjs`: the R4 detached-child probe.
- `rsum.mjs`: summarizes a rollout.
- `sanitize.mjs`: makes fixtures. It replaces the user name, refuses any leftover (including a shortened name or a foreign `Users\<name>`), and keeps a `.zst` file's bytes when nothing needed replacing.

**Encoded verdicts.** `test/spikes/codex-mcp-hooks-transcripts.test.ts` (in `npm test`) encodes T6, T4, P1 (results, process scope and Codex's cut), the transcript formats in both modes, P7, the hook payloads, P4 and R2. R2 runs the hook string itself under each shell found on the machine (PowerShell 5.1, cmd and Git's sh on Windows; `/bin/sh` elsewhere), with no Codex. A hygiene test checks that no Codex fixture names a user other than `USER`.

**Not encoded** (evidence in this document only): P3 and B2 (hook writes and skill listing need a live Codex turn), R4 (a process lifetime), and R2 under pwsh 7 (not installed everywhere).

## P1 (Codex half): the bundled server under Codex

**Handshake and process scope.**
- Codex sent `initialize` at `2025-06-18`, then `notifications/initialized`, then `tools/list`, as spike B saw. The probe answered at 2025-06-18.
- Codex starts **one MCP server process per thread**, not per call or per turn. This confirms §8.
  - The subagent run started two, one per thread (`codex/mcp/subagent/`).
  - Six calls in one turn started one (`codex/mcp/tools-call/`).
  - Calls in two turns of one app-server thread started one (`codex/mcp/two-turns/`).
- Optional servers get a shared 1 s startup grace (`mcp_optional_startup_grace_ms`, default 1000). A server still starting after that is left out of that model step and joins on a later one. That is the R7 premise.

**How the model reaches the tools.** MCP tools are Responses API *namespace* tools: namespace `mcp__<server>`, function name = the raw MCP tool name.
- When the model's catalog entry supports search (gpt-5.x does), Codex **defers** every MCP tool behind a `tool_search` tool. The model must call `tool_search` first; its output lists `{type: "namespace", name: "mcp__grimoire", description: <server instructions>, tools: [...]}`.
- The `tool_search` description itself lists each source as `- <server>: <server instructions>`, under a 512 KiB budget, so **the server instructions reach the model whole** before any tool is loaded.
- The function call is `{"type":"function_call","namespace":"mcp__probe","name":"echo",…}`. Hooks and logs see the flat name `mcp__probe__echo`.
- Names are sanitized to `[A-Za-z0-9_]`.

**What the model sees** (the `function_call_output` Codex sent; the rollout holds the same text unless Codex cut it, see Truncation):

| Server result | Model input |
| -- | -- |
| `structuredContent` + text block (`which`) | `"Wall time: 0.0056 seconds\nOutput:\n{\"seen_via\":\"structuredContent\"}"`: **only `structuredContent`**, compact JSON, behind a header |
| text block only | `[{"type":"input_text","text":"Wall time: … seconds\nOutput:"},{"type":"input_text","text":"plain text only"}]` |
| `isError: true` + `structuredContent` | the `structuredContent` text, as above (`{"error":{…}}`); the call is marked `failed` in the rollout's `McpToolCall` item |
| JSON-RPC error (handler threw) | `[{header item},{"type":"input_text","text":"tool call error: tool call failed for \`probe/boom\`\n\nCaused by:\n    Mcp error: -32603: probe exploded"}]` |

So, as in Claude Code, the model sees exactly one copy of a grimoire result.

**Truncation.** Codex middle-truncates every tool output (header included) to the model's truncation policy × 1.2, keeping the head and the tail. Fixtures: `codex/transcripts/truncation/` and `truncation-unknown-model/` (the rollouts) and `codex/model-input/truncation*.jsonl` (what the next request carried).
- **gpt-5.x** (bundled catalog, `tokens: 10000`): about 12,000 tokens, which kept exactly **48,000 characters**.
  - `huge` results of 30,000 and 45,000 bytes arrived whole.
  - Results of 60,000 and 120,000 bytes kept 48,000 characters plus a marker: rows 0–129, the marker, then the real tail.
- **A slug missing from Codex's catalog** (tested: `-m unknown-model-x`) falls back to `bytes: 10000`, which kept exactly **12,000 characters** of a 30,000-byte result.
- **Two cuts, two markers.** Codex cuts the output once and stores that in the rollout, then cuts the stored text again when it builds the model's input.
  - **The rollout** holds the first cut. Its marker counts what was really removed: `…3020 tokens truncated…` (60,000 bytes), `…18013 tokens truncated…` (120,000 bytes), and for the unknown slug `…18188 chars truncated…`, exactly the characters removed.
  - **The model** sees the stored text cut once more. That second cut removes the first marker with a few characters around it, so its own marker always read `…7 tokens truncated…`, in tokens even for the unknown slug. Head and tail are the same as in the rollout.
  - So don't rely on N: the rollout's is accurate, but it isn't what the model saw.
- **Grimoire's 24 KB cut** (spike B's `big`: 24,482 bytes, `truncated: true`, `cursor: "137"`) arrived byte-whole under gpt-5.5, with 2× headroom.
- **Where else the rollout stores a result.** Paginated `item_completed` `McpToolCall.result` holds the server's result capped at 64 KiB; legacy `mcp_tool_call_end` caps it at 1 MiB.

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

- **The keys.** In 0.162.1, `callId`, `threadId` and `sessionId` are camelCase and present on every call. No feature flag gates them (`core/src/mcp_tool_call.rs`). The same path serves exec, the TUI and the app-server.
- **Older Codex (source only, not run).** `git show <tag>:codex-rs/core/src/mcp_tool_call.rs` shows when each key arrived:

  | Codex | `threadId` | `callId` | top-level `sessionId` | `x-codex-turn-metadata.session_id` |
  | -- | -- | -- | -- | -- |
  | 0.140.0 | yes | no | no | yes |
  | 0.150.0 | yes | yes | no | yes |
  | 0.162.1 | yes | yes | yes (`MCP_TOOL_SESSION_ID_META_KEY`) | yes |

  `callId` arrived before `sessionId`, so every Codex that sends `sessionId` also sends `callId`. In 0.162.1 both session ids come from the session's `SessionId`: `sess.session_id()` for the top-level key, and the `session_id` that `session/turn_context.rs` passes to `TurnMetadataState::new` for the snake_case one. In every fixture call they are equal, subagents included (asserted). Older versions build the turn metadata the same way, but that is source-only.
- **What the ids name.**
  - `sessionId` is the root thread's id, for the root and every descendant thread.
  - `threadId` is the calling thread.
  - `callId` is the model's `function_call.call_id`.
  - Codex also sends `windowId` (`<thread>:<compaction window>`), `itemId` (the function_call item id) and an rmcp-added `progressToken`.
- **A subagent call** (`codex/meta/tools-call-subagent.json`) has `threadId ≠ sessionId`. Its turn metadata adds `parent_thread_id` (= `sessionId`), `subagent_kind` and `thread_source: "subagent"`.
- **Exact matching works.** `callId` is the `call_id` of a `function_call` with `namespace: "mcp__probe"` and the called `name`, in the rollout whose `session_meta.id` equals `threadId` (asserted for a root and a subagent call).
- **Paths inside.** `x-codex-turn-metadata` holds absolute workspace paths and the model. Never copy it into trailers or records; read single fields from it at most.

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

**A legacy root spawns a paginated child** (`codex/transcripts/subagent-legacy-root/`). The history mode isn't inherited: one session tree can mix both modes, so the mode is read per file. That root, started through the app-server, has `source: "vscode"` and no `thread_source` field at all, so a root is recognized by `session_id == id`, not by `thread_source`.

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

The direct half is now a test: it runs both variants under PowerShell 5.1, cmd and Git's sh (or `/bin/sh` off Windows) with Codex's argv shapes, skipping a shell that isn't installed.

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
  - **Claude Code's shape made the hook fail** ("SessionStart Failed"), and the line never reached the model. Re-run with Claude's real shape, `{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true,"additionalContext":"…"}}` (spike C): failed the same way, while the same JSON without `reloadSkills` completed and delivered the line. (The first run put `reloadSkills` at the top level; that failed too.)
  - **Why:** `SessionStartHookSpecificOutputWire` and `SessionStartCommandOutputWire` are `#[serde(deny_unknown_fields)]` (`hooks/src/schema.rs`, lines 385–403 at `rust-v0.162.1`). Any key Codex doesn't know fails the parse.
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
  - The group index counts only that event's groups, and the handler index counts handlers within the group. A config with a `[[hooks.PreToolUse]]` group, then a two-handler `[[hooks.SessionStart]]` group, then grimoire's listed keys `…:pre_tool_use:0:0`, `…:session_start:0:0`, `…:session_start:0:1` and `…:session_start:1:0` (`hooks-list-mixed-groups.json`).
  - `hooks/list`'s `displayOrder` is a global count over all hooks (0, 1, 2, 3 there). Don't use it as the position.
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

The runner's Codex invocation from spec §16 was run verbatim, with the stand-in passed by `-c` because `--ignore-user-config` skips `config.toml`. Its stdout streams are in `codex/exec-json/`. The two shell runs were re-captured in the fix pass, with the request log kept, so the refusals are now fixtured as the model saw them (`codex/model-input/read-only-shell-blocked.jsonl`).

**The runner's own turn.** A served bundle on stdin, no prompt argument, a fresh temp directory outside any repo, an output schema of `{summary: string}`:
- `--output-schema` reached the model as `text.format = {type: "json_schema", strict: true, schema}`;
- the model's final message landed in `-o`, the exit code was 0, and `--ephemeral` wrote no session file;
- the stdout events were `thread.started`, `turn.started`, `item.completed` (`agent_message`), `turn.completed`.

**Shell under `--sandbox read-only`:**

| | `Get-Content input.txt` | `Set-Content written.txt x` |
| -- | -- | -- |
| default (no `prefer_mxc`) | refused before running; the model got `exec_command failed: CreateProcess { message: "Rejected(… rejected: blocked by policy)" }` | refused the same way |
| `--enable prefer_mxc` | ran: exit 0, file text returned | ran and failed: "Access to the path … is denied", exit 1 |

With `prefer_mxc`, the turn also emits a warning item (`type: "error"`, "Under-development features enabled: prefer_mxc"), which `suppress_unstable_features_warning = true` silences.

**Verdict.** The runner's turn, which needs no tools, works without `prefer_mxc`. A run needing shell reads would take the fallback (`prefer_mxc`).

**"No tools" isn't quite true.** Codex still offers `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `request_user_input`, the goal tools, `tool_search` and the hosted `web_search`.
- Read-only blocks the shell ones.
- `web_search` runs on the provider's side. `-c web_search="disabled"` removed it from the request (verified).

## R4 (Codex half): a detached child after the shell tool returns

`exec_command` ran `node r4-spawn.cjs <log> <delay>` under `-s danger-full-access`. `r4-spawn.cjs` spawns itself as a child with `detached: true, stdio: 'ignore', windowsHide: true` plus `unref()`, the way `sync --background` would, and exits. Only `danger-full-access` was tested; under the read-only sandbox on native Windows the shell command itself is refused (P7).

- **The command returned at once.** The command's output was `Process exited with code 0` after 0.11 s.
- **The child outlived the command.** It logged "started" at once and "finished" after its full delay: 8 s in one run, 25 s in another. It was never killed.
- **`codex exec` waited for it.** The model's turn ended right away, but the process exited only when the child did: 26 s for the 25 s child. A background sync therefore keeps a headless `codex exec` alive until it finishes. Grimoire's sync is short, so that cost is small. In the TUI and app-server, the session outlives it anyway.
- **The child also outlived Codex** (fix pass). While `codex exec` waited, `codex.exe` itself was killed (`Stop-Process -Force` on that PID only, not the tree), 4 s after the child started. The child still logged "finished" 25 s after it started.
  - **Why it survives:** the shell runs inside a Windows job object, and when the root process exits Codex calls `JobObject::preserve_descendants` (`utils/pty/src/win/job.rs`, called from `utils/pty/src/pipe.rs` and `win/mod.rs`). That disables kill-on-close, so closing the job's handle, even by Codex dying, kills nothing.
- **Sandboxed runs are spike F's.** Spike F (GOK-131) ran the same probe under Codex's sandboxes and took R4's fallback: under the MXC sandbox the child is killed when the shell command ends, and under the unelevated Windows sandbox the shell call doesn't return until the child exits (`docs/research/spikes/codex-skills-role-exec.md`). So this "confirmed" holds only unsandboxed, and the sync-pending marker is load-bearing on Codex.

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
  - **Verified:** a session was archived, back-dated, then `rollout/compress`ed. Node's `zlib.zstdDecompressSync` decoded Codex's frame byte-identically to the pre-archive file. The fix pass repeated this under `C:\gok130`, so `codex/transcripts/archived-zstd/` holds Codex's own frame and the pre-archive file, both unchanged, and the test decodes the one to the other.
- **Torn lines.**
  - **How Codex writes.** Lines are written as they happen: one `write_all` plus `flush` per line, with no fsync.
  - **Reopening.** If the file doesn't end in a newline, Codex appends `\n` before writing again, so a torn fragment can end up **mid-file** as an unparsable line.
  - **What the reader does:** skip and count any unparsable line, not only the last one.

### The two history modes

There are exactly two: `session_meta.history_mode` is `"legacy"` or `"paginated"`, and a missing field means legacy.

- **Paginated is the default for every new non-ephemeral local thread in 0.162.1**, both `codex exec` and the TUI. Legacy survives in older files, in forks of legacy threads, and wherever an app-server client asks for it (`thread/start {historyMode: "legacy"}`). The legacy fixtures were made that way.
- **The mode is per file.** A legacy root's `spawn_agent` child was paginated (`subagent-legacy-root/`), so one session tree can hold both.
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
- **Truncation marks inside the body:** `…N tokens truncated…` / `…N chars truncated…`, or `Warning: truncated output (original token count: N)` at the top of shell output. In a rollout, the mark is Codex's first cut and N counts what was removed; the model saw that text cut again, under a mark reading 7 (see P1). Don't build on N.

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

**Lines in order** (local compaction; `codex/transcripts/compaction/` is paginated, `compaction-legacy/` legacy):
1. A **`response_item` assistant `message` holding the summarizer's reply** (the compaction prompt itself is not recorded). It is not visible assistant text: the reader must fold it into the compaction step, because it is the last response item before `compacted`.
2. `compacted` = `{message: "Another language model started… <summary>", replacement_history: [the kept messages], window_number, window_id, …}`.
3. `world_state`, `turn_context` and `event_msg` `thread_settings_applied`.
4. In paginated mode, `item_completed` `ContextCompaction`; in legacy, an `event_msg` `token_count` and then `event_msg` `context_compacted`.

Both modes were captured. The legacy run had a second turn after the compaction, on the same thread.

**What changes under a login.** Remote compaction, used by the OpenAI provider under a ChatGPT login, puts `{"type":"compaction","encrypted_content":…}` items into `replacement_history` instead of a readable summary.

### Forks

- **Legacy:** a fork copies the parent's items, **including the parent's `session_meta` line**, after its own.
- **Paginated:** `thread/fork` copies nothing. The new `session_meta` carries `history_base {thread_id, end_ordinal_exclusive, end_byte_offset}` and `forked_from_ordinal_exclusive`.
- **A subagent spawned with `fork_context`** copies the parent context. `subagent_history_start_ordinal` marks where its own records begin.

These come from the source and were not exercised. The T5 detection rules for Codex should key on these fields.

## Other findings that change downstream work

1. **`hook session-start` must speak each client's output format** (GOK-144, GOK-157, GOK-166).
   - Claude Code needs `{"hookSpecificOutput":{"hookEventName":"SessionStart","reloadSkills":true,…}}`. Codex fails the hook on any key it doesn't know (`deny_unknown_fields`), so that JSON drops the line.
   - When Codex runs it, the verb must print the session line as plain text, or as `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<line>"}}` with no other keys.
   - **Telling the clients apart:** Codex's SessionStart payload always has `permission_mode`; Claude Code's never does (6 captured payloads, asserted). Both can have `model`, so don't use it.
   - Env markers are weaker: Claude Code sets `CLAUDECODE` / `CLAUDE_PROJECT_DIR` in its hook env, but Codex passes its own environment to hooks, so a Codex started from Claude Code's Bash tool hands them on.
   - An explicit marker in the hook args would be cleanest, but the args are part of the frozen bootstrap contract.
2. **Grimoire's tools are deferred behind `tool_search` in Codex** (GOK-142). The server instructions are what the model reads before searching, and the tool names and descriptions are what BM25 matches. Name grimoire and its issue operations plainly in both.
3. **An unknown model slug gets a 12,000-character cut** (GOK-142).
   - For catalog models (48,000 characters) the 24 KB budget fits with 2× headroom.
   - Since Codex keeps the head and the tail, end every cut result with `truncated` and `cursor`, so a client-side middle cut still shows them.
   - The per-tool override `[mcp_servers.grimoire.tools.<tool>] output_token_limit` exists if ever needed.
4. **The Codex MCP server's spawn env holds no `CODEX_*` variables**, only about 20 OS variables plus the configured `env`. The spec's `env_vars` list is required (GOK-146). Identity must come from per-call `_meta`.
5. **Codex shell commands get `CODEX_SESSION_ID` (root thread), `CODEX_THREAD_ID` and `CODEX_VERSION`** (GOK-147). These are the CLI-call evidence for "the session from the shell env". In a root thread both ids are equal.
6. **Exact Codex approval state is computable** (GOK-161, GOK-171).
   - Grimoire can reproduce Codex's trust hash (the recipe is above and in the test) and read `hooks.state` from `$CODEX_HOME/config.toml`.
   - With both, `status` and `doctor` can report "approved", "needs approval" or "modified" exactly, rather than inferring from hash changes.
   - The recipe is Codex-internal, so keep the "announce on change" path as the fallback.
7. **Uninstall shifts only the SessionStart groups after grimoire's.** Grimoire's group is appended last. Removing it shifts the keys of `[[hooks.SessionStart]]` groups **after** it (their index drops by one), so those need re-approval. Groups before it, and every other event's groups, keep their trust.

## What each downstream ticket must build

- **GOK-137 (Codex reader):** everything in "Codex transcripts" above. In particular:
  - both modes, with the line index as the legacy ordinal, and the mode read per file (a legacy root can have a paginated child);
  - roots recognized by `session_id == id`, since app-server threads have no `thread_source`;
  - string-or-array outputs;
  - all four headers;
  - structured exit codes only in paginated mode;
  - the long-running pattern;
  - the compaction summary message folded into the compaction step, in both modes;
  - truncation marks kept as text, without trusting N;
  - mid-file torn lines;
  - `\\?\` paths;
  - `archived_sessions/` and `.jsonl.zst` (a fixture holds Codex's own frame).

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
  - the client-specific SessionStart output (finding 1), told apart by `permission_mode` in the payload.
- **GOK-147 (identity):**
  - T6 confirmed for 0.162.1;
  - context = `_meta.threadId`, call = `_meta.callId` (camelCase, top level);
  - session = `_meta.sessionId`; when it is missing (Codex up to at least 0.150.0), read the single string field `_meta["x-codex-turn-metadata"].session_id`. Read that one field only and never copy the object, which holds absolute paths;
  - CLI calls use `CODEX_SESSION_ID` / `CODEX_THREAD_ID` (finding 5);
  - the T6 fallback (tool name plus time) stays for a missing `callId`: 0.162.1 and 0.150.0 send it, 0.140.0 doesn't.
- **GOK-166 (session line):** under Codex the SessionStart line must be plain stdout or `hookSpecificOutput.additionalContext` with no other keys (finding 1); a `reloadSkills` key makes Codex drop it.
- **GOK-157 (fast path):**
  - P3 confirmed: the hook writes directly, so no upkeep fallback is needed for permissions;
  - Codex lists those skills from the thread's second turn;
  - output per finding 1.
- **GOK-139 (sync):** R4 confirmed for unsandboxed Codex (`danger-full-access`): the detached `sync --background` child outlives the command and Codex itself. Under sandboxes spike F took the fallback, so keep the sync-pending marker as the spec requires, and keep the child short, because `codex exec` waits for it.
- **GOK-167 (runner):**
  - P7 confirmed: no `prefer_mxc` is needed for the tool-free run;
  - add `-c web_search="disabled"` to the Codex invocation, because the hosted search tool is otherwise still offered;
  - `-o` and the `--json` events behave as fixtured.
- **GOK-161 (upgrade) / GOK-171 (uninstall):**
  - P4 confirmed: positions are real, so keep the position computation;
  - the position is grimoire's group index among `[[hooks.SessionStart]]` groups in the main checkout's `.codex/config.toml` (other events' groups don't count), with handler index 0; never `hooks/list`'s `displayOrder`, which counts every hook; a sibling `.codex/hooks.json` is a separate declaring file with its own keys;
  - uninstall names the groups after grimoire's;
  - optionally use finding 6 for exact approval state;
  - re-approval is once per clone path per user;
  - worktrees share the main checkout's approval.

## Fixtures added

They live under `test/fixtures/codex/`; provenance and sanitizing are in each folder's README.

- `meta/tools-call.json`, `meta/tools-call-subagent.json`: real `tools/call` requests with Codex's `_meta`.
- `mcp/tools-call/`: wire traffic for `echo`, `big`, `which`, `boom` and two parallel calls.
- `mcp/subagent/`: two server processes, root and subagent calls.
- `mcp/two-turns/`: one server process for calls in two turns of one thread.
- `transcripts/paginated/`, `transcripts/legacy/`: the same scenario in both history modes. It has an MCP call, one-shot and long-running unified exec, a failing command, a skill read, a git commit and `apply_patch`.
- `transcripts/subagent/`: root and child rollouts. `transcripts/subagent-legacy-root/`: a legacy root with its paginated child.
- `transcripts/compaction/` (paginated) and `transcripts/compaction-legacy/`.
- `transcripts/mcp-results/`: what the model saw for each result shape.
- `transcripts/truncation/`, `transcripts/truncation-unknown-model/`: Codex's own cut, as stored; `model-input/truncation*.jsonl`: the same outputs as the model received them.
- `transcripts/archived-zstd/`: a session before archiving, and its archived `.jsonl.zst`, both Codex's bytes.
- `hook-payloads/session-start-startup.json`, `hook-payloads/session-start-resume.json`.
- `hook-trust/`: `hooks/list` responses for each P4 state (mixed groups and handlers included), the project configs that produced them, and the `hooks.state` trust write.
- `exec-json/`: the runner's `codex exec --json` streams (P7), with the bundle on stdin and with the shell blocked or under `prefer_mxc`; `model-input/read-only-shell-blocked.jsonl`: the refusals the model got.
