# Spike A: Claude Code hooks, bootstrap and transcripts (GOK-126)

*Run on 2026-10-11 against the real Claude Code 2.1.296 (native Windows build), on Windows 11 Pro 10.0.26200, with Node 24.21.0. R3 was also checked on Node 22.23.3. Every item was exercised for real; none is unverifiable.*

## Verdicts at a glance

| Item | Verdict | What changes downstream |
| -- | -- | -- |
| R1 | **Confirmed**, once R3's `--` is in the args | Nothing beyond R3. Exec form works; shell form isn't needed. |
| R3 | **Fallback taken, plus an amendment** | The spec's `["-e", "<bootstrap>", "--from", …]` fails before the bootstrap runs. Entries put `--` after the bootstrap, and the bootstrap passes `process.argv.slice(1)` to the launcher explicitly. |
| R4 (Claude half) | **Confirmed** | None. The sync-pending marker is still built, as the spec requires. |
| T1 | **Confirmed in default, plan, acceptEdits and auto, with an amendment** | The hint must not carry `transcript_path`. Without an allow rule, the auto-mode classifier denies calls whose hint holds it. |
| T3 | **Confirmed** | None. `/clear` gives a new file and a new session id. |
| T5 | **Confirmed: copied history is detectable** | The reader detects the copy by uuid, never by `sessionId`, which the fork rewrites. |

**Items that took a fallback:** only R3 ("the bootstrap passes `process.argv` explicitly"). The fallback alone doesn't fix R3, so it also needs `--` in the entry args.

**Amendments that are not named fallbacks:** R3's `--`, and T1's hint without `transcript_path`.

## Setup (reproducible)

Everything ran in throwaway repos under `%TEMP%`, never in a real checkout. Paths with a space and a non-ASCII character (`…\r1 dash ö\repo`) were used on purpose.

**The probe kit** (throwaway scripts, not committed):

- **`bootstrap.txt`:** a 485-character stand-in for the frozen bootstrap. Like the spec's, it avoids `$ " \ % ^` and backticks. It walks up from `--from` (or the cwd) to the first `.git`, follows a `gitdir:` file through `commondir`, and calls `require('<git-common-dir>/grimoire/launcher.cjs')(args, root)` with `args = process.argv.slice(1)`:

  ```js
  const f=require('fs'),p=require('path'),a=process.argv.slice(1),i=a.indexOf('--from');let d=p.resolve(i<0?'.':a[i+1]),g;for(;;){g=p.join(d,'.git');if(f.existsSync(g))break;const u=p.dirname(d);if(u==d)process.exit(0);d=u}if(f.statSync(g).isFile()){g=p.resolve(d,f.readFileSync(g,'utf8').trim().slice(7).trim());const c=p.join(g,'commondir');if(f.existsSync(c))g=p.resolve(g,f.readFileSync(c,'utf8').trim())}const l=p.join(g,'grimoire','launcher.cjs');if(f.existsSync(l))require(l)(a,d)
  ```

- **`launcher.cjs`,** in `<repo>/.git/grimoire/`. It logs argv, cwd, the `CLAUDE*`/`AI_AGENT` environment and the raw hook stdin to a JSONL log, then acts by verb:
  - `hook pre-tool-use` on a `mcp__grimoire__*` tool prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{…tool_input, "_grimoire_hint":{session_id, transcript_path, tool_use_id, agent_id, agent_type}}}}`, with no `permissionDecision`. Variants drop `transcript_path`, or emit nothing.
  - `hook session-start` prints one line.
  - `mcp` starts the echo server.
- **`echo-mcp.cjs`:** a stdio JSON-RPC server named `grimoire`. It logs every request and offers three tools:
  - `show` (`readOnlyHint`);
  - `comment` (`destructiveHint: false`);
  - `strict_show` (`additionalProperties: false`).

  Each tool returns the argument keys it received. A "quiet" variant returns only `{ok, ref}`.
- **`mkrepo.mjs`:** `git init`, plus `.mcp.json` and `.claude/settings.json` as `init` would write them (below), plus the launcher.
- **`run-claude.mjs`:** spawns `claude.exe` directly, with no shell, and strips the parent session's `CLAUDE*`/`AI_AGENT` variables.
  - With `--stream`, it feeds user messages one per turn over `--input-format stream-json`. That is how `/clear` and `/compact` were sent.
  - It answers `can_use_tool` permission prompts as an SDK host would.
  - Run it with `MSYS_NO_PATHCONV=1` from Git Bash, or `/clear` arrives as `C:/Program Files/Git/clear`.

**`.mcp.json`** (as spec §11):

```json
{ "mcpServers": { "grimoire": { "command": "node", "args": ["-e", "<bootstrap>", "mcp"] } } }
```

**`.claude/settings.json`** (as spec §11, with R3's `--`):

```json
{
  "permissions": { "allow": ["mcp__grimoire"] },
  "enabledMcpjsonServers": ["grimoire"],
  "hooks": {
    "PreToolUse": [{ "matcher": "mcp__grimoire__.*", "hooks": [
      { "type": "command", "command": "node",
        "args": ["-e", "<bootstrap>", "--", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "pre-tool-use"], "timeout": 5 } ] }],
    "SessionStart": [{ "hooks": [
      { "type": "command", "command": "node",
        "args": ["-e", "<bootstrap>", "--", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "session-start"], "timeout": 10 } ] }]
  }
}
```

**A typical run:**

```sh
node run-claude.mjs "<repo>" out.jsonl -- -p "Call the mcp__grimoire__show tool with ref gr-1 …" \
  --model sonnet --output-format stream-json --verbose --include-hook-events --allowedTools mcp__grimoire
```

## R1: exec-form hooks run `node -e "<bootstrap>"` with `--from ${CLAUDE_PROJECT_DIR}`

**Verdict: confirmed** (with R3's `--`).

**Evidence:**

- **Spec args as written fail.** With `["-e", "<bootstrap>", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "<event>"]`, both hooks failed in Claude Code. `--include-hook-events` reported:

  ```json
  {"type":"system","subtype":"hook_response","hook_name":"SessionStart:startup","stderr":"node: bad option: --from\r\n","exit_code":9,"outcome":"error"}
  ```

  The failure is non-blocking: the tool call still ran, with no hint. The cause is R3's, below.
- **With `--` after the bootstrap, both hooks ran.** The launcher logged:
  - `process.argv = ["C:\\Program Files\\nodejs\\node.exe", "--from", "C:\\Users\\…\\Temp\\gok126\\r1 dash ö\\repo", "hook", "pre-tool-use"]`;
  - `process.execArgv = ["-e", "<the bootstrap, byte for byte>"]`.
- **The JSON args reach node intact.** Claude Code resolved `node` to `node.exe` on PATH and spawned it without a shell. The 485-character bootstrap arrived unchanged.
- **`${CLAUDE_PROJECT_DIR}` is substituted inside an `args` element,** as a plain string. A path holding a space and `ö` arrived as one argument.
- **The hook process:**
  - its cwd was the project root;
  - its env held `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID` (the current session, updated after `/clear`), `AI_AGENT=claude-code_2-1-296_harness`, `CLAUDE_CODE_CHILD_SESSION=1` and `CLAUDECODE=1`;
  - `SessionStart` hooks also got `CLAUDE_ENV_FILE`.
- **The MCP entry** `["-e", "<bootstrap>", "mcp"]` worked as written: `process.argv = [node, "mcp"]`.
- **Hook cwd and `cd`:** an agent ran `cd sub/nested && pwd` (a nested repo), then `pwd` again, then a grimoire call. The second `pwd` was back at the root, because in `-p` the Bash tool's cwd didn't persist. The hook cwd stayed at the project root. So this run couldn't show a hook following `cd`. `--from` makes that moot anyway: the walk-up starts at `--from`, not at the hook's cwd.
- **The shell-form fallback** was not needed, and not built.

**Dependent slices build:** exec-form hooks, exactly as in the settings above.

- GOK-146 writes them.
- GOK-144's `hook` verbs read `--from <dir>` from the explicit args.

## R3: argument order under `node -e`

**Verdict: fallback taken, plus an amendment.**

**Evidence** (plain `node`, so the claim doesn't rest on Claude Code; checked on Node 24.21.0 and 22.23.3):

```text
$ node -e "<print process.argv.slice(1)>" --from "C:/x y" hook pre-tool-use
node: bad option: --from                              (exit 9)
$ node -e "<print>" -- --from "C:/x y" hook pre-tool-use
["--from","C:/x y","hook","pre-tool-use"]             (exit 0)
$ node -e "<print>" hook pre-tool-use --from "C:/x y"
["hook","pre-tool-use","--from","C:/x y"]             (exit 0)
$ node -e "<print>" mcp
["mcp"]                                               (exit 0)
```

- **Why it fails:** Node keeps parsing its own options after `-e <script>` until the first non-option argument, so `--from` is read as a Node flag.
- **Two ways out:**
  - a verb first ends option parsing;
  - `--` ends it explicitly, which Node documents.
- **Where user arguments start:** under `-e` there is no script path, so they start at `process.argv[1]`, not `[2]`.

**Decision for the frozen cross-pin contract (GOK-144, GOK-146):**

- **Claude Code hooks:** `node -e "<bootstrap>" -- --from ${CLAUDE_PROJECT_DIR} hook <event>`, that is args `["-e", "<bootstrap>", "--", "--from", "${CLAUDE_PROJECT_DIR}", "hook", "<event>"]`.
  - `--` keeps the spec's `[--from <dir>] <verb>` order.
  - It also guards every later argument from Node.
- **MCP entries** (`.mcp.json`, Codex): `["-e", "<bootstrap>", "mcp"]` works as written. Adding `--` is harmless if one shape everywhere is preferred.
- **The Codex hook string** (spike E, R2) needs `--` too if it ever carries `--from`.
- **The fallback:** the bootstrap passes `process.argv.slice(1)` to the launcher explicitly, for example `require(launcher)(process.argv.slice(1))`. The launcher never reads `process.argv` itself.
- **Tests:** `test/spikes/claude-hooks-transcripts.test.ts` encodes the layout, so CI checks it on every OS and Node version in the matrix.

## R4 (Claude half): a detached child survives inside Claude Code's Bash tool

**Verdict: confirmed.**

`r4-spawn.cjs` does what the CLI does after a write: `spawn(process.execPath, [child, …], { detached: true, windowsHide: true, stdio: 'ignore', shell: false })`, `unref()`, print, exit. The child wrote a heartbeat every second for 15 to 25 seconds, then `done`.

- **In a headless session** (`claude -p`, `--allowedTools Bash PowerShell`), the agent ran the spawner once through the **Bash** tool (Git Bash) and once through the **PowerShell** tool.
  - Both tool calls returned at once.
  - `claude` exited at 03:22:49.
  - Both children kept beating and wrote `done` at 03:23:10 and 03:23:12, long after the tool calls returned and after `claude` had exited.
- **The same held in this agent's own Bash tool** (an SDK-hosted Claude Code 2.1.296 session). The child was alive (`tasklist`) after the command returned, and finished.
- **No job object killed the children.** libuv's `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` was enough, with no `CREATE_BREAKAWAY_FROM_JOB`.

**Dependent slices build:** GOK-141 spawns the detached child as specified. The sync-pending marker stays, as the spec says ("built either way"). The Codex half of R4 is spike E's.

**Bash tool environment**, for GOK-141's actor and session detection:

- the Bash tool's env carries `AI_AGENT=claude-code_2-1-296_agent`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID`;
- hooks get `AI_AGENT=…_harness`;
- the MCP server gets `AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR`, but not `CLAUDE_CODE_CHILD_SESSION`.

## T1: `updatedInput` without `permissionDecision`, per permission mode

**Verdict: confirmed in default, plan, acceptEdits and auto**, with one amendment: drop `transcript_path` from the hint.

**Method:** one fresh repo per case. The prompt asked for `show`, then `comment`, then `strict_show`. Honoured means the server received the hook's key. In every honoured call, `_meta["claudecode/toolUseId"]` equalled the hint's `tool_use_id`.

| Mode (`--permission-mode`) | Allow rule | `show` | `comment` | `strict_show` |
| -- | -- | -- | -- | -- |
| `default` (payload says `default`) | `--allowedTools mcp__grimoire` | honoured | honoured | honoured |
| `manual` (payload says `default`) | yes | honoured | honoured | honoured |
| `plan` | yes | honoured | not attempted (plan mode: the model skips writes) | honoured |
| `acceptEdits` | yes | honoured | honoured | honoured |
| `auto` | yes | honoured | honoured | honoured |
| `dontAsk` | yes | honoured | honoured | honoured |
| `bypassPermissions` | none | honoured | honoured | honoured |
| `default`, prompt answered by an SDK host | none | honoured | honoured | honoured |
| `auto`, full hint | **none** | honoured | **denied by classifier** | **denied by classifier** |

**What the table shows:**

- **The updated input reaches the server verbatim** (fixture `meta/tools-call.json`).
- **The tool's schema doesn't matter.** Claude Code didn't check the updated input against it: `strict_show`, with `additionalProperties: false`, got the extra key.
- **A permission prompt shows the updated input, and approving it keeps it.** In the prompt case, the `can_use_tool` request already held `_grimoire_hint`.
- **The transcript keeps the model's original input.** The hint appears only in the `hook_success` attachment that records the hook's stdout. A reader must never expect it in a `tool_use`.

**The classifier finding** (auto mode, no allow rule):

- The classifier denied grimoire calls whose hint held `transcript_path`. The reason was `[Data Exfiltration]`. In 6 of 6 runs it denied at least one call, a write and a read-only tool alike. The first call of each run (`show`) always passed; the later ones were denied.
- The quiet server, which didn't echo the key back, made no difference (3 of 3 still denied). So the trigger is the hint itself, not what the tool returned.
- Every call passed in 4 of 4 runs with an ids-only hint (`session_id`, `tool_use_id`), and in 2 of 2 runs with no hint.
- **Plan mode is affected too.** Without an allow rule, plan mode routed a read-only call through the same classifier and denied it.

**When does the allow rule apply?**

- `init` writes `mcp__grimoire` to `permissions.allow`, so in a trusted workspace the classifier never sees grimoire calls.
- But Claude Code ignores a project's `permissions.allow` until the workspace is trusted, even under `-p`. Its stderr said: "Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted."
- Hooks and `.mcp.json` servers still run in that case. So an untrusted checkout running in `-p`, auto or plan mode reaches the classifier, with the hint attached.

**Decision (GOK-147):**

- **The hint holds ids only:** `session_id`, `tool_use_id`, and `agent_id` and `agent_type` when present. Never `transcript_path`.
  - The ids-only output is fixture `hook-outputs/pre-tool-use-updated-input-ids-only.json`.
  - The primary path otherwise stays as specified: `updatedInput` and no `permissionDecision`.
- **`transcript_path` reaches grimoire another way:** the `pre-tool-use` hook process (unsandboxed Node, same machine) records the transcript root machine-locally (§6), keyed by session.
  - The root is the `projects/<slug>/` folder.
  - The cut can also derive it as `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug(cwd)>/<session_id>.jsonl`, then fall back to the id search (§14 Roots).
  - The `SessionStart` payload carries the same `transcript_path`.
- **Subagents:** inside a subagent, the payload's `session_id` and `transcript_path` are the parent's (fixture `pre-tool-use-subagent.json`). The context's own transcript is `<projects>/<slug>/<session_id>/subagents/agent-<agent_id>.jsonl`, as §14 already says.
- **The `_meta` join:** `_meta["claudecode/toolUseId"]` was present on every `tools/call`, and equalled the hook's `tool_use_id`.

## T3: `/clear` starts a new transcript file

**Verdict: confirmed.**

**Method:** one `claude -p --input-format stream-json` session with three messages: a turn with a grimoire call and Bash/Read, then `/clear`, then a turn with a grimoire call.

- **Before `/clear`:** the session ran as `249ac573…` in `249ac573….jsonl`.
- **After `/clear`:**
  - stream events switched to session id `bd89d1c0…`;
  - `SessionStart` fired with `source: "clear"` and the new `session_id` and `transcript_path`;
  - a new file `bd89d1c0….jsonl` appeared beside the old one.
- **The new file:**
  - it starts with `{"type":"mode",…}`, then the `SessionStart:clear` hook record (`parentUuid: null`), then `<local-command-caveat>` and `<command-name>/clear</command-name>` user lines, then a `system`/`local_command` line, then the new prompt;
  - it shares no uuid with the old file and never names the old session.
- **The old file** ends with the queued `/clear` (`queue-operation`) and a `cost-state` line.
- **The MCP server is not respawned.** The one started at startup (spawn-env `CLAUDE_CODE_SESSION_ID=249ac573…`) kept serving after `/clear`, so its spawn-env id is stale from then on, as ADR 0008 expected. Hooks get the new id in their env.

**For contrast:**

- **Compaction** (`/compact`) stays in the same file and session. It writes a `compact_boundary` system line (`parentUuid: null`, `logicalParentUuid`, `compactMetadata.trigger`), one `isCompactSummary` user line, and fires `SessionStart` with `source: "compact"`.
- **`--resume <id>` without `--fork-session`** appends to the same file and keeps the session id. `SessionStart` reports `source: "resume"`.

**Caveat:** `/clear` was driven through the headless stream-json input (the SDK path), not the interactive TUI, because no pty is available here. The transcript shows it ran the same local command (`commandRun: {command: "clear"}`).

**Dependent slices build:** GOK-135 treats a transcript file as one session, and `/clear` as a session boundary. Lookup by session id is sound.

## T5: a fork's copied history can be detected

**Verdict: confirmed.** The copy is detectable, but not by `sessionId`.

**Method:** `claude -p --resume 18aa1670… --fork-session "…show gr-4…"` on the compacted session.

- **A new session and file.** The fork got session id `c90649d0…` and a new file. `SessionStart` reported `source: "fork"`. The payload doesn't name the origin.
- **What it copies.** The fork file copies the origin's active branch, from its last compact boundary on (30 lines).
- **What a copied line keeps:** its `uuid`, `timestamp`, `message.id` and every tool-use id.
- **What a copied line loses:**
  - `sessionId` is rewritten to the fork's id;
  - `slug` is dropped;
  - some `promptId`s are rewritten, and two `parentUuid`s are relinked;
  - token counts on one assistant line are zeroed.
- **Layout.** The file opens with `mode`, `atis-latch` and `queue-operation` lines stamped at fork time, then the copy. Then comes the `SessionStart:fork` hook record, which is the fork's first own uuid line, then its own turns.
- **Forking left the origin file byte-identical.**

**Detection rules, all verified on the fixture:**

1. **By uuid** (primary, needs no hooks). A line in session S's file is copied history if its `uuid` also appears in another transcript of the same project folder. The copied lines form a contiguous run before S's first own line.
2. **By boundary** (with grimoire's SessionStart hook). Everything before the `hook_success` attachment named `SessionStart:fork` is copied.
3. **By time.** Copied lines keep their original timestamps, all earlier than the fork's first own line.

**Consequences for GOK-135:**

- **The T3 fallback isn't enough here.** "Bound the window by each line's `sessionId`" does not exclude fork copies, because the copy carries the fork's id.
- **One file per call.** When two files contain a binding call id, the call belongs to the file where its line is not in the copied run. Equivalently, it belongs to the session named by the hint's `session_id`.
- **The fork rule.** A forked session's window starts after its copy. The one-excerpt-per-call-id rule stays as the backstop.

## Other observations for the reader (GOK-135)

- **Metadata line types** to skip:
  - top-level: `queue-operation`, `mode`, `atis-latch`, `last-prompt`, `cost-state`;
  - `attachment` lines of types `hook_success`, `environment`, `model`, `deferred_tools_delta`, `deferred_tools_record`, `agent_listing_delta`, `mcp_instructions_delta`, `skill_listing`, `total_tokens_reminder`, `session_context`, `date`, `credential_org`, `remote_session_change`, `prompt_snapshot` and `silent_turn_reminder`.
  - `hook_success` records carry `toolUseID` and the hook's stdout.
  - `prompt_snapshot` holds the whole system prompt (about 77 KB per line), so stream it and never keep it.
- **One API message spans several lines.** Each content block of an assistant message is its own line, sharing `message.id`. Group by `message.id`.
- **`is_error` is often absent:** absent on most successful results, `true` on failures.
- **Deferred MCP tools.** Grimoire tools are deferred, so a session first calls `ToolSearch` (`select:mcp__grimoire__…`), then the tool.
- **Subagents.** The launch is a `tool_use` named `Agent`, with `input.subagent_type`. Its result line carries `toolUseResult.agentId`. The subagent's file is `<session>/subagents/agent-<agentId>.jsonl`, with a sibling `.meta.json` (`agentType`, `toolUseId`). Every subagent line carries the parent `sessionId`, `isSidechain: true` and `agentId`.
- **Spills.** A big result becomes `<persisted-output>…Full output saved to: <projects>\<slug>\<session>\tool-results\<id>.txt … Preview (first 2KB): …` in the `tool_result`. The reader never opens the spill file.
- **Path spellings in one Windows session:**
  - `C:\\Users\\…` (JSON-escaped);
  - `C:/Users/…` (`pwd -W`);
  - `/c/Users/…` (typed by agents);
  - `/tmp/…` (Git Bash's mount for `%TEMP%`);
  - the project slug `C--Users-…` (each `:`, `\` and space becomes `-`, and so does `ö`: `r1 dash ö` became `r1-dash---repo`).
- **The MCP handshake** (for spike B, GOK-127): Claude Code 2.1.296 first sent `server/discover` with `_meta["io.modelcontextprotocol/protocolVersion"]: "2026-07-28"`. When the probe answered "method not found", it fell back to `initialize` with `protocolVersion: "2025-11-25"`.

## Fixtures added (seam 2)

These are in `test/fixtures/claude-code/`. Provenance and sanitizing are in its README files.

- **`hook-payloads/`:**
  - `pre-tool-use.json` (main thread);
  - `pre-tool-use-subagent.json` (`agent_id`, `agent_type`);
  - `session-start-{startup,clear,compact,resume,fork}.json`.
- **`hook-outputs/`:**
  - `pre-tool-use-updated-input.json`, the honoured shape;
  - `pre-tool-use-updated-input-ids-only.json`, the amended shape.
- **`meta/tools-call.json`:** a `tools/call` with the hint and `_meta["claudecode/toolUseId"]`.
- **`transcripts/`:** `plain/`, `clear/`, `compaction/`, `fork/`, `subagent/`, `spill/` and `resume/`. Each folder mirrors a project folder, including `subagents/` and `tool-results/`.

`test/spikes/claude-hooks-transcripts.test.ts` asserts each verified behaviour above against these files, plus the R3 argv layout against a real `node`.
