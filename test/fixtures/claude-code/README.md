# Claude Code fixtures (spike A, GOK-126)

Real artifacts captured from Claude Code by spike A. Findings, verdicts and the
exact probe setup are in `docs/research/spikes/claude-hooks-transcripts.md`.
`test/spikes/claude-hooks-transcripts.test.ts` encodes what the spike verified
against these files.

## Provenance (all folders)

- **Client:** Claude Code 2.1.296, native Windows build (`claude.exe`), model
  `claude-sonnet-5-5`, logged in with a claude.ai subscription.
- **OS:** Windows 11 Pro 10.0.26200. Hooks and the probe MCP server ran on Node 24.21.0.
- **Captured:** 2026-10-11, in headless sessions (`claude -p`). `/clear` and
  `/compact` were sent as user messages over `--input-format stream-json`. The
  fork used `--resume <id> --fork-session`.
- **Probe repo:** `%TEMP%\grimoire-spike-a\proj`, a throwaway git repo with:
  - a `.mcp.json` server named `grimoire` (a probe server that echoes what it
    received), started through a probe bootstrap as `node -e <bootstrap> mcp`;
  - exec-form `PreToolUse` (matcher `mcp__grimoire__.*`) and `SessionStart`
    hooks in `.claude/settings.json`, running
    `node -e <bootstrap> -- --from ${CLAUDE_PROJECT_DIR} hook <event>`;
  - a probe launcher in `.git/grimoire/`. Its `PreToolUse` handler returned
    `updatedInput` with the reserved key `_grimoire_hint` and no
    `permissionDecision`. Its `SessionStart` handler printed one line.
  - The synced claude.ai plugins were turned off with `--settings`, so only
    built-in tools and the probe server appear.

## Sanitizing (all folders)

Applied by one script, the same way everywhere:

- The Windows user name became `alice` in every spelling: `C:\Users\alice`
  (JSON-escaped in the files), `C:/Users/alice`, `/c/Users/alice`, and the
  project slug `C--Users-alice-…`.
- The account e-mail became `alice@example.com`. The account organization UUID
  became `00000000-0000-4000-8000-000000000000`. The per-account `atis` value
  became zeros.
- In `prompt_snapshot` and `skill_listing` attachments (Claude Code's own system
  prompt, tool list and skill list), every string over 200 characters was cut
  to its first 80 characters plus `[sanitized: N characters elided]`. Anywhere
  else, a string over 4,000 characters kept its first 1,500 and last 500
  characters around the same marker.
- Nothing else changed. Ids, uuids, timestamps, field order and line endings
  (LF) are as Claude Code wrote them. Every unmodified Claude Code 2.1.296 line
  round-trips through `JSON.stringify` byte for byte, which is how edited lines
  were re-serialized.

Each folder's README lists what it holds and anything specific to it.
