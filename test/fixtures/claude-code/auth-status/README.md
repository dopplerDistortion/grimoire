# `claude auth status` output

Real stdout of `claude auth status` (JSON is its default output, same as `--json`),
captured by spike D (GOK-129) for the runner billing guard. Findings:
`docs/research/spikes/claude-runner-ipc.md`.

## Provenance

- Claude Code 2.1.296 (native `claude.exe`), Windows 11 Pro 10.0.26200, on a machine
  logged in with a claude.ai Max subscription. Captured 2026-10-11.
- Spawned by Node 24.21.0 with `spawnSync(<absolute claude.exe>, ['auth', 'status'],
  { cwd: <fresh empty temp dir>, windowsHide: true })` and the runner child's env:
  `CLAUDE_CODE_SIMPLE` removed, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, the parent session's
  `CLAUDECODE` / `CLAUDE_CODE_*` variables removed, plus the one change below.

| File | Env change | Exit code |
| -- | -- | -- |
| `claude-ai.json` | none (the subscription login) | 0 |
| `api-key.json` | `ANTHROPIC_API_KEY=sk-ant-api03-FAKEFAKEFAKE` | 0 |
| `api-key-helper.json` | `CLAUDE_CONFIG_DIR=<temp dir>` holding `settings.json` = `{"apiKeyHelper":"echo sk-ant-api03-FAKEHELPER"}` | 0 |
| `oauth-token.json` | `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKEFAKEFAKE` | 0 |
| `third-party-bedrock.json` | `CLAUDE_CODE_USE_BEDROCK=1` | 0 |
| `none.json` | `CLAUDE_CONFIG_DIR=<empty temp dir>` (not logged in) | 1 |

The keys and tokens above are fake; `auth status` does not validate them.

## Sanitizing

- The account e-mail address → `user@example.com` (in `email` and `orgName`).
- Organization id → `00000000-0000-4000-8000-000000000000`.
- Home directory `C:\Users\<name>\` → `C:\Users\USER\` in `projectsDirectory` and
  `configDirectory`.

Nothing else changed: key order, two-space indentation and the trailing `\n` are as printed.
