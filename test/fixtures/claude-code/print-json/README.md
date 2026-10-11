# `claude -p --output-format json` results

Real stdout from the Claude Code CLI run the way the runner spawns it, captured
by spike D (GOK-129). Findings: `docs/research/spikes/claude-runner-ipc.md`.

## Provenance

- Claude Code 2.1.296 (native `claude.exe`), Windows 11 Pro 10.0.26200, Node 24.21.0
  as the spawning process. Captured 2026-10-11.
- Spawned with `child_process.spawn(<absolute claude.exe>, args, { cwd: <fresh empty
  temp dir>, windowsHide: true, shell: false })`, with the bundle written to stdin and
  no positional prompt.
- Env: `CLAUDE_CODE_SIMPLE` removed, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and the
  parent Claude Code session's `CLAUDECODE` / `CLAUDE_CODE_*` variables removed.
- Base args (the spec's §16 Claude invocation):

  ```
  -p --output-format json --json-schema <schema> --setting-sources user
  --strict-mcp-config --settings {"disableAllHooks":true} --tools ""
  --permission-mode dontAsk --permission-prompts none --max-turns 3
  --no-session-persistence --append-system-prompt-file <procedure.md>
  ```

- Schema used: `{"type":"object","properties":{"first_token":{"type":"string"},"last_token":{"type":"string"},"line_count":{"type":"integer"},"summary":{"type":"string","maxLength":200}},"required":["first_token","last_token","line_count","summary"],"additionalProperties":false}`.
  The procedure file told the model to start `summary` with `PROC-OK:`.

| File | Run | Exit code | Differences from the base args |
| -- | -- | -- | -- |
| `success-structured-output.json` | the exact base args, default model (resolved to `claude-opus-5-5`), a 12-line bundle on stdin | 0 | none |
| `error-max-turns.json` | an unsatisfiable schema (`{"type":"object","properties":{"n":{"type":"integer","minimum":5,"maximum":3}},"required":["n"],"additionalProperties":false}`) | 1 | `--model haiku` |
| `api-error-invalid-key.json` | `ANTHROPIC_API_KEY=sk-ant-api03-FAKEFAKEFAKE` in the env (stderr: "claude.ai connectors are disabled because ANTHROPIC_API_KEY … takes precedence over your claude.ai login") | 1 | `--model haiku` |
| `success-local-command.json` | stdin starting with `/cost` (it ran as a slash command; the model never ran) | 0 | `--model haiku --disable-slash-commands` |

## Sanitizing

Nothing needed scrubbing: these results carry no paths, user names or e-mail
addresses. Each file is the exact stdout, one JSON line plus `\n`.
