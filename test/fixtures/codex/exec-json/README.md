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
directory outside any git repo.

| File | What it shows |
| -- | -- |
| `runner-stdin-bundle.jsonl` | The bundle on stdin as the whole prompt, with no prompt argument. The model answered with the schema-shaped final message only: `thread.started`, `turn.started`, `item.completed` (`agent_message`), `turn.completed`. `-o` received the same text and the exit code was 0. |
| `read-only-shell-blocked.jsonl` | The model asked for `Get-Content input.txt`, then `Set-Content written.txt x`. Without `prefer_mxc` both were refused before running ("blocked by policy" on stderr), so no `command_execution` item appears. The turn still completed. |
| `read-only-prefer-mxc.jsonl` | The same with `--enable prefer_mxc`. It starts with a warning `item.completed` of type `error` (an under-development feature). The read ran (`exit_code: 0`, the file's text), and the write failed with "Access to the path … is denied" (`exit_code: 1`). |
