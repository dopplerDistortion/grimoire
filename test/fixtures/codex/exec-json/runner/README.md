# `codex exec --json`: the runner's invocation (Spike F, GOK-131)

What `codex exec --json` printed on stdout for the runner's Codex invocation,
one JSON event per line. Findings:
`docs/research/spikes/codex-skills-role-exec.md` (P7, C4). Encoded in
`test/spikes/codex-skills-role-exec.test.ts`.

## The spec §16 invocation

```
exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
  --cd <fresh temp dir> --sandbox read-only --output-schema <schema.json> -o <out>
  -c features.apps=false -c features.plugins=false
```

The served bundle went on stdin, with no prompt argument. The output schema was
`{verdict: string, pairs: string[]}` (all required, `additionalProperties:
false`).

| File | Run | Exit | What it shows |
| -- | -- | -- | -- |
| `success.jsonl` | the scripted model asks for `Get-ChildItem …; Get-Content …`, then `Set-Content written-by-runner.txt`, then answers with the schema-shaped JSON | 0 | Four events: `thread.started`, `turn.started`, one `agent_message` with the answer, `turn.completed`. `-o` got the same text. Codex 0.162.1 emits **no** `command_execution` item for a refused call, so the stream alone can't show the shell calls. |
| `success.tool-io.jsonl` | the same run | | What Codex sent the model in its last request: both `exec_command` calls and their outputs, each `exec_command failed: CreateProcess { message: "Rejected(…) rejected: blocked by policy" }`. They were refused before running: no Windows sandbox under `--ignore-user-config`. |
| `no-shell-tool.jsonl` | the same plan, plus `-c features.shell_tool=false -c web_search="disabled" -c skills.include_instructions=false` | 0 | The same four events. |
| `no-shell-tool.tool-io.jsonl` | the same run | | Both `exec_command` calls got `unsupported call: exec_command`. |
| `model-api-error.jsonl` | the model API answers HTTP 400 with an error body | 1 | `error` then `turn.failed`, each carrying the API's JSON error body as `message`. |
| `not-logged-in.jsonl` | **no stand-in**: the default OpenAI provider and a `CODEX_HOME` with no login | 1 | Four WebSocket `error` events (`Reconnecting... 2/5` to `5/5`, `wss://`), an `item.completed` of type `error` ("Falling back from WebSockets to HTTPS transport…"), five HTTPS `error` events (`1/5` to `5/5`), a final standalone `error` event, then `turn.failed` with "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header …". It took about 17 s. |

## The final runner invocation (C4 fallback)

```
exec --json --ephemeral --ignore-rules --skip-git-repo-check
  --cd <fresh temp dir> --sandbox read-only --output-schema <schema.json> -o <out>
  -c features.apps=false -c features.plugins=false
  -c features.hooks=false -c notify=[] -c developer_instructions=""
  -c features.shell_tool=false -c web_search="disabled"
  -c skills.include_instructions=false
  -c model_provider="openai"
  -c mcp_servers.usermcp.enabled=false
  -c openai_base_url="http://127.0.0.1:<port>/v1"      (test-only: the stand-in)
```

The user `config.toml` was kept. It declared an MCP server `usermcp`, a
SessionStart hook, a legacy `notify` program, `developer_instructions` and
`[windows] sandbox = "unelevated"`. The `usermcp` name came from `codex mcp
list --json`, run in the same temp dir with the same flags.

| File | Exit | What it shows |
| -- | -- | -- |
| `fallback-final.jsonl` | 0 | `thread.started`, `turn.started`, four WebSocket `error` events (`Reconnecting... 2/5` to `5/5`: the stand-in has no WebSocket endpoint, and the built-in `openai` provider tries WebSockets first), the "Falling back from WebSockets to HTTPS transport" error item, the `agent_message` with the answer, then `turn.completed`. A successful run can carry `error` events. |
| `fallback-final.tool-io.jsonl` | | The model's `exec_command` call got `unsupported call: exec_command`, and its call to the user's MCP tool (`chore_start`, namespace `mcp__usermcp`) got `unsupported call: mcp__usermcpchore_start`. |

## Provenance

- **Client:** Codex CLI 0.162.1, native Windows build (`codex.exe` from
  `@openai/codex-win32-x64`, spawned directly, not through the npm shim), not
  logged in.
- **OS:** Windows 11 Pro 10.0.26200, Node 24.21.0. Captured 2026-10-11.
- **Captured under a scripted model** (all files but `not-logged-in.jsonl`).
  For the §16 runs, `--ignore-user-config` skips `config.toml`, so the stand-in
  (`test/spikes/codex-skills-role-exec/scripted-responses.mjs`) was passed as
  `-c model_providers.mock={ name = "mock", base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses" }`
  `-c model_provider="mock"` `-c model="gpt-5.5"`. The final run reached it
  through `openai_base_url`. Real: every byte, written by the real binary.
  Scripted: the model's tool calls and answer text, and the 400.
- **Scripts:** `test/spikes/codex-skills-role-exec/p7-runner.mjs`, variants
  `success`, `notools`, `http400` and `nologin`, and `c4-fallback.mjs`, variant
  `final`. Each had a throwaway `CODEX_HOME`. `success.jsonl` is from a re-run
  of `success`, the run whose request log gave `success.tool-io.jsonl`.
- **`*.tool-io.jsonl`:** `sanitize.mjs --tool-io` applied to the stand-in's
  request log. It keeps the `function_call`, `function_call_output`,
  `custom_tool_call` and `custom_tool_call_output` input items of the run's last
  `POST /responses`, one per line, as Codex sent them.

## Sanitizing

`sanitize.mjs` in the same folder: the Windows user name became `USER` and the
machine's IANA time zone `Etc/UTC` (neither occurred in these files). Thread
ids, the Cloudflare `cf-ray` ids, OpenAI request ids and the stand-in's port
are kept: none is a secret.
