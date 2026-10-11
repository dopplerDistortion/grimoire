# `codex exec --json`: the runner's invocation (Spike F, GOK-131)

What `codex exec --json` printed on stdout for the runner's Codex invocation
from spec §16, one JSON event per line. Findings:
`docs/research/spikes/codex-skills-role-exec.md` (P7 and the runner). Encoded in
`test/spikes/codex-skills-role-exec.test.ts`.

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
| `success.jsonl` | the scripted model asks for `Get-ChildItem …; Get-Content …`, then `Set-Content written-by-runner.txt`, then answers with the schema-shaped JSON | 0 | Both shell calls were refused before running ("blocked by policy" on stderr; no Windows sandbox under `--ignore-user-config`), and Codex 0.162.1 emits **no** `command_execution` item for a refused call. The answer arrives as one `agent_message`; `-o` got the same text. |
| `no-shell-tool.jsonl` | the same, plus `-c features.shell_tool=false -c web_search="disabled" -c skills.include_instructions=false` | 0 | The same four events. The model's `exec_command` calls got "unsupported call: exec_command". |
| `model-api-error.jsonl` | the model API answers HTTP 400 with an error body | 1 | `error` then `turn.failed`, each carrying the API's JSON error body as `message`. |
| `not-logged-in.jsonl` | **no stand-in**: the default OpenAI provider and a `CODEX_HOME` with no login | 1 | Five WebSocket reconnects, an `item.completed` of type `error` ("Falling back from WebSockets to HTTPS transport…"), five HTTPS reconnects, then `turn.failed` with "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header …". It took about 17 s. |

## Provenance

- **Client:** Codex CLI 0.162.1, native Windows build (`codex.exe` from
  `@openai/codex-win32-x64`, spawned directly, not through the npm shim), not
  logged in.
- **OS:** Windows 11 Pro 10.0.26200, Node 24.21.0. Captured 2026-10-11.
- **Captured under a scripted model** (all files but `not-logged-in.jsonl`).
  Because `--ignore-user-config` skips `config.toml`, the stand-in
  (`test/spikes/codex-skills-role-exec/scripted-responses.mjs`) was passed as
  `-c model_providers.mock={ name = "mock", base_url = "http://127.0.0.1:<port>/v1", wire_api = "responses" }`
  `-c model_provider="mock"` `-c model="gpt-5.5"`. Real: every byte, written
  by the real binary. Scripted: the model's tool calls and answer text, and the
  400.
- **Script:** `test/spikes/codex-skills-role-exec/p7-runner.mjs`, variants
  `success`, `notools`, `http400` and `nologin`, each with a throwaway
  `CODEX_HOME`.

## Sanitizing

`sanitize.mjs` in the same folder: the Windows user name became `USER` and the
time zone `Etc/UTC` (neither occurred in these four files). Thread ids, the
Cloudflare `cf-ray` ids and OpenAI request ids are kept: none is a secret.
