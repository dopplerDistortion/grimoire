# What Codex sent to the model

Items of the input Codex sent to the model provider in a Responses API request,
for the cases where that differs from the rollout or is missing from the exec
stream.

## Spike E (GOK-130)

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`.

**How the files were made.** The scripted stand-in for the Responses API
(`test/spikes/codex-mcp-hooks-transcripts/fake-responses.mjs`) logged every
request body Codex sent, parsed. Each file holds the `function_call` and
`function_call_output` items of one run's **last** request, in request order,
one JSON object per line. The items and their field order are Codex's; the byte
layout is `JSON.stringify`'s. Nothing else from the request (instructions,
tools, messages) is included.

| File | Run | What it shows |
| -- | -- | -- |
| `truncation.jsonl` | `../transcripts/truncation/` (gpt-5.5) | The 30,000- and 45,000-byte results whole. The 60,000- and 120,000-byte ones as the model got them: 48,000 characters around `…7 tokens truncated…`, a second cut of the rollout's text that removed the rollout's own mark. Head and tail match the rollout. |
| `truncation-unknown-model.jsonl` | `../transcripts/truncation-unknown-model/` (`unknown-model-x`) | The 30,000-byte result as 12,000 characters around `…7 tokens truncated…` (the rollout says `…18188 chars truncated…`), then the `exec_command` output. |
| `read-only-shell-blocked.jsonl` | `../exec-json/read-only-shell-blocked.jsonl` (fix pass, under `C:\gok130`) | The two shell calls the model made, and the outputs Codex returned for them: `exec_command failed: CreateProcess { message: "Rejected(… rejected: blocked by policy)" }`. The commands never ran. |
