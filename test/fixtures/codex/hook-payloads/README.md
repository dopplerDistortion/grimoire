# Codex hook payloads

The JSON a Codex hook process receives on stdin.

## Spike E (GOK-130)

Captured under a scripted model. Shared provenance and sanitizing are in
`../README.md`.

The hook was the last `[[hooks.SessionStart]]` group of the repo's committed
`.codex/config.toml`. It ran `node -e "<spike A's bootstrap stand-in>" hook
session-start` through Codex's PowerShell. The probe launcher it reached
(`test/spikes/codex-mcp-hooks-transcripts/hooks/launcher.cjs`) logged its stdin
verbatim; each file is that string with a newline added.

| File | What it shows |
| -- | -- |
| `session-start-startup.json` | `source: "startup"`, at the root thread's first turn under `codex exec` (approval `never`, so `permission_mode: "bypassPermissions"`). `transcript_path` is the root rollout in `../transcripts/subagent/`. Fields, in order: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source`. |
| `session-start-resume.json` | `codex exec resume --last`: `source: "resume"`, and `transcript_path` in verbatim extended-length form (`\\?\C:\…`). |
