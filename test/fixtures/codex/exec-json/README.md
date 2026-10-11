# `codex exec --json` event streams

What `codex exec --json` prints on stdout, one JSON event per line.

## Spike E (GOK-130), item P7

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`.

Each stream is the runner's Codex invocation from spec §16:

```
exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check
  --cd <tmp> --sandbox read-only --output-schema <file> -o <out>
  -c features.apps=false -c features.plugins=false -m gpt-5.5
```

Because `--ignore-user-config` skips `config.toml`, the stand-in provider was
passed with `-c model_provider="mock"` and
`-c model_providers.mock={name="mock",base_url="http://127.0.0.1:<port>/v1",wire_api="responses"}`.
The output schema was `{summary: string}`. The working folder was a fresh temp
directory outside any git repo. The prompt (a `PLAN: [...]` for the stand-in)
came on stdin.

Every `agent_message` text is the scripted model's reply, fixed in the plan
(`from the stdin bundle`, `scripted reply`). It says nothing about what the
commands did.

| File | What it shows |
| -- | -- |
| `runner-stdin-bundle.jsonl` | The bundle on stdin as the whole prompt, with no prompt argument. The model answered with the schema-shaped final message only: `thread.started`, `turn.started`, `item.completed` (`agent_message`), `turn.completed`. `-o` received the same text and the exit code was 0. |
| `read-only-shell-blocked.jsonl` | The model asked, in one response, for `Get-Content input.txt` and `Set-Content written.txt x`. Without `prefer_mxc` both were refused before running, so no `command_execution` item appears, and the turn still completed. The refusals the model got (`exec_command failed: CreateProcess { … rejected: blocked by policy … }`) are in `../model-input/read-only-shell-blocked.jsonl`. Re-captured in the fix pass, under `C:\gok130`. |
| `read-only-prefer-mxc.jsonl` | The same with `--enable prefer_mxc`. It starts with a warning `item.completed` of type `error` (an under-development feature). The two commands ran in parallel: the read completed (`exit_code: 0`, the file's text), and the write failed with "Access to the path … is denied" (`exit_code: 1`). Re-captured in the fix pass, under `C:\gok130`. |

## Spike F (GOK-131), items P7 and C4

`runner/`: the same invocation with a strict `{verdict, pairs}` schema, as
success, with the shell tool off, a model API error, and a real not-logged-in
failure with no stand-in. Also the final runner invocation of the C4 fallback
(user config kept, its additions switched off by `-c`), and, beside each
scripted run, the tool calls and outputs Codex sent the model. See
`runner/README.md`.
